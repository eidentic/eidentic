import { createHash } from "node:crypto";
import type { VectorPort, VectorEntry, VectorSearchResult } from "@eidentic/types";

/**
 * Derive a deterministic UUIDv5-style UUID from an arbitrary string `id`.
 * Real Qdrant only accepts UUID or unsigned-integer point IDs — string ids like "a" or "shared"
 * are rejected on upsert. We SHA-1 the input and format the bytes into the UUID shape
 * `xxxxxxxx-xxxx-5xxx-yxxx-xxxxxxxxxxxx` (version bits: 0101, variant bits: 10xxxxxx).
 * No external dependency: uses Node.js built-in `node:crypto`.
 */
function idToUuid(id: string): string {
  const hash = createHash("sha1").update(id).digest();
  // Set version nibble to 5 (UUIDv5): byte 6 high nibble = 0101
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  // Set variant bits: byte 8 = 10xxxxxx
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const h = hash.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** A scored point as returned by Qdrant search (the subset we read). `score` is cosine similarity (higher = better). */
export interface QdrantScoredPoint {
  id: string | number;
  score: number;
  payload?: Record<string, unknown> | null;
}

/** A payload field condition: matches points whose payload has `key` equal to `value`. */
export interface QdrantFieldCondition {
  key: string;
  match: { value: string };
}

/** An id condition: matches points whose point ID is in the `has_id` list. */
export interface QdrantHasIdCondition {
  has_id: Array<string | number>;
}

/** The filter condition union used by this adapter. */
export type QdrantCondition = QdrantFieldCondition | QdrantHasIdCondition;

/** Structural subset of `@qdrant/js-client-rest`'s QdrantClient that the adapter uses. */
export interface QdrantLike {
  getCollections(): Promise<{ collections: Array<{ name: string }> }>;
  createCollection(
    collection: string,
    opts: { vectors: { size: number; distance: "Cosine" | "Euclid" | "Dot" | "Manhattan" } },
  ): Promise<unknown>;
  upsert(
    collection: string,
    opts: { wait?: boolean; points: Array<{ id: string | number; vector: number[]; payload?: Record<string, unknown> }> },
  ): Promise<unknown>;
  search(
    collection: string,
    opts: {
      vector: number[];
      limit: number;
      filter?: { must: Array<QdrantFieldCondition> };
      with_payload?: boolean;
    },
  ): Promise<QdrantScoredPoint[]>;
  delete(
    collection: string,
    opts:
      | { points: Array<string | number>; wait?: boolean }
      | { filter: { must: Array<QdrantCondition> }; wait?: boolean },
  ): Promise<unknown>;
  /**
   * Optional: exact point count with a filter.  When present, `eraseScope` uses it to obtain a
   * precise deleted-count instead of the high-topK search approximation.
   * Maps to `QdrantClient.count(collection, { filter, exact: true })` in `@qdrant/js-client-rest`.
   */
  count?(
    collection: string,
    opts: { filter: { must: Array<QdrantFieldCondition> }; exact: boolean },
  ): Promise<{ count: number }>;
  /**
   * Page through points matching a filter. Required by `list` (archival dedup / reindex). Maps to
   * `QdrantClient.scroll(collection, { filter, limit, offset, with_payload, with_vector })`; the
   * response carries the next page cursor in `next_page_offset` (null/undefined when exhausted).
   */
  scroll?(
    collection: string,
    opts: {
      filter?: { must: Array<QdrantFieldCondition> };
      limit?: number;
      offset?: string | number | Record<string, unknown> | null;
      with_payload?: boolean;
      with_vector?: boolean;
    },
  ): Promise<{
    // `vector` and `next_page_offset` are intentionally SUPERTYPES of what the real
    // `@qdrant/js-client-rest` returns (plain vector, multi-vector `number[][]`, or a named-vector
    // record; and an offset that can be a point-id record) so a concrete `QdrantClient` is
    // structurally assignable to `QdrantLike`. `list` only reads the plain single-vector form (the
    // only shape this adapter ever writes) and treats the cursor opaquely.
    points: Array<{ id: string | number; vector?: number[] | number[][] | Record<string, unknown> | null; payload?: Record<string, unknown> | null }>;
    next_page_offset?: string | number | Record<string, unknown> | null;
  }>;
}

export class QdrantVectorStore implements VectorPort {
  private constructor(
    private readonly client: QdrantLike,
    private readonly collection: string,
    readonly dim: number,
  ) {}

  static async create(opts: { client: QdrantLike; collection: string; dim: number }): Promise<QdrantVectorStore> {
    const { client, collection, dim } = opts;
    if (!Number.isInteger(dim) || dim <= 0) throw new Error(`dim must be a positive integer, got ${dim}`);
    const { collections } = await client.getCollections();
    if (!collections.some((c) => c.name === collection)) {
      await client.createCollection(collection, { vectors: { size: dim, distance: "Cosine" } });
    }
    return new QdrantVectorStore(client, collection, dim);
  }

  async upsert(entry: VectorEntry): Promise<void> {
    if (entry.vector.length !== this.dim) {
      throw new Error(`vector dim ${entry.vector.length} != collection dim ${this.dim}`);
    }
    // Real Qdrant only accepts UUID or unsigned-integer point IDs — derive a deterministic UUID
    // from the caller's string id. Store the original id in the payload (`orig_id`) so search
    // can return it unchanged. The UUID is a stable opaque handle the adapter manages internally.
    const pointId = idToUuid(entry.id);
    await this.client.upsert(this.collection, {
      wait: true,
      points: [{ id: pointId, vector: entry.vector, payload: { scope_key: entry.scopeKey, text: entry.text, orig_id: entry.id } }],
    });
  }

  async search(queryVector: number[], scopeKey: string, topK = 10): Promise<VectorSearchResult[]> {
    const hits = await this.client.search(this.collection, {
      vector: queryVector,
      limit: topK,
      filter: { must: [{ key: "scope_key", match: { value: scopeKey } }] },
      with_payload: true,
    });
    // Return the original string id stored in `orig_id`, not the internal UUID point id.
    // Qdrant Cosine `score` is cosine SIMILARITY (higher = better) — no normalization; ranking matches LanceDB.
    return hits.map((h) => ({
      id: String((h.payload ?? {})["orig_id"] ?? h.id),
      text: String((h.payload ?? {})["text"] ?? ""),
      score: h.score,
    }));
  }

  async delete(id: string, scopeKey: string): Promise<void> {
    // Use a filter-based delete scoped to both the derived UUID point id and scope_key so
    // cross-tenant deletes are impossible. `has_id` matches by Qdrant POINT ID (not a payload
    // field); `key/match` matches by payload field.
    const pointId = idToUuid(id);
    await this.client.delete(this.collection, {
      filter: {
        must: [
          { has_id: [pointId] },
          { key: "scope_key", match: { value: scopeKey } },
        ],
      },
      wait: true,
    });
  }

  /**
   * Erase all points for `scopeKey` and return the number deleted.
   *
   * Count strategy: when the client exposes the optional `count` capability (exact server-side
   * count via `QdrantClient.count`), we use it for a precise result.  Otherwise we fall back to a
   * high-topK zero-vector search as an approximation — accurate for conformance-scale collections
   * but may under-count very large scopes (> 100 000 points).
   *
   * NOTE: the count is read before the delete; a concurrent write between the two calls can cause
   * a slight discrepancy, but this is unavoidable without Qdrant transaction support.
   */
  async eraseScope(scopeKey: string): Promise<{ deleted: number }> {
    const filter: { must: QdrantFieldCondition[] } = { must: [{ key: "scope_key", match: { value: scopeKey } }] };
    let count: number;
    if (typeof this.client.count === "function") {
      const result = await this.client.count(this.collection, { filter, exact: true });
      count = result.count;
    } else {
      // NOTE: approximation — high-topK search used as count proxy when `count` is unavailable.
      const dummyVector = new Array(this.dim).fill(0) as number[];
      const hits = await this.client.search(this.collection, {
        vector: dummyVector,
        limit: 100_000,
        filter,
        with_payload: false,
      });
      count = hits.length;
    }
    if (count > 0) {
      await this.client.delete(this.collection, { filter, wait: true });
    }
    return { deleted: count };
  }

  /**
   * Enumerate every entry in `scopeKey` (used by `Memory.deduplicateArchival` / `reindexEmbeddings`).
   * Pages through `scroll` with `with_vector` so the full `VectorEntry` (including the embedding) is
   * reconstructed. The original string id is read back from the `orig_id` payload, mirroring `search`.
   *
   * Requires the client to support `scroll` (every real `@qdrant/js-client-rest` client does). If the
   * injected client omits it, we throw a descriptive error rather than silently returning nothing.
   */
  async list(scopeKey: string): Promise<VectorEntry[]> {
    if (typeof this.client.scroll !== "function") {
      throw new Error("QdrantVectorStore.list requires the client to support scroll() (present on @qdrant/js-client-rest)");
    }
    const filter: { must: QdrantFieldCondition[] } = { must: [{ key: "scope_key", match: { value: scopeKey } }] };
    const entries: VectorEntry[] = [];
    let offset: string | number | Record<string, unknown> | null | undefined = undefined;
    do {
      const page = await this.client.scroll(this.collection, {
        filter,
        limit: 256,
        offset: offset ?? null,
        with_payload: true,
        with_vector: true,
      });
      for (const p of page.points) {
        const payload = p.payload ?? {};
        // with_vector returns a plain `number[]` for single-vector collections (the only kind this
        // adapter creates); multi-vector (`number[][]`) and named-vector (record) shapes are ignored.
        const vector =
          Array.isArray(p.vector) && typeof p.vector[0] === "number" ? (p.vector as number[]) : [];
        entries.push({
          id: String(payload["orig_id"] ?? p.id),
          scopeKey: String(payload["scope_key"] ?? scopeKey),
          text: String(payload["text"] ?? ""),
          vector,
        });
      }
      offset = page.next_page_offset ?? null;
    } while (offset !== null && offset !== undefined);
    return entries;
  }
}
