import { Buffer } from "node:buffer";
import type { VectorPort, VectorEntry, VectorSearchResult } from "@eidentic/types";

function encodeIdPart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function physicalId(scopeKey: string, id: string): string {
  return `${encodeIdPart(scopeKey)}/${encodeIdPart(id)}`;
}

/** A scored match as returned by Pinecone query (the subset we read). `score` is cosine similarity (higher = better). */
export interface PineconeMatch {
  id: string;
  score?: number;
  metadata?: Record<string, unknown>;
  values?: number[];
}

/** Structural subset of `@pinecone-database/pinecone`'s Index that the adapter uses (verified against 7.2). */
export interface PineconeIndexLike {
  upsert(opts: { records: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }> }): Promise<void>;
  query(opts: {
    vector: number[];
    topK: number;
    filter?: Record<string, unknown>;
    includeMetadata?: boolean;
    includeValues?: boolean;
  }): Promise<{ matches: PineconeMatch[] }>;
  fetch(opts: { ids: string[] }): Promise<{ records: Record<string, { metadata?: Record<string, unknown> }> }>;
  deleteOne(opts: { id: string }): Promise<void>;
  /**
   * Optional: paginated ID listing for a namespace/prefix.  When present, `eraseScope` uses it to
   * obtain an exact count of deleted records instead of the high-topK query approximation.
   * Maps to `Index.listPaginated` in `@pinecone-database/pinecone` ≥ 2.x.
   */
  listPaginated?(opts: {
    prefix?: string;
    limit?: number;
    paginationToken?: string;
  }): Promise<{ vectors?: Array<{ id: string }>; pagination?: { next?: string } }>;
}

export class PineconeVectorStore implements VectorPort {
  private constructor(
    private readonly index: PineconeIndexLike,
    readonly dim: number,
  ) {}

  /**
   * Pinecone indexes are pre-created by the user (with the matching dimension + cosine metric).
   * This adapter does NOT create indexes; it only validates entry dimensionality against `dim`.
   */
  static create(opts: { index: PineconeIndexLike; dim: number }): PineconeVectorStore {
    const { index, dim } = opts;
    if (!Number.isInteger(dim) || dim <= 0) throw new Error(`dim must be a positive integer, got ${dim}`);
    return new PineconeVectorStore(index, dim);
  }

  async upsert(entry: VectorEntry): Promise<void> {
    if (entry.vector.length !== this.dim) {
      throw new Error(`vector dim ${entry.vector.length} != index dim ${this.dim}`);
    }
    const id = physicalId(entry.scopeKey, entry.id);
    await this.index.upsert({
      records: [{ id, values: entry.vector, metadata: { scope_key: entry.scopeKey, text: entry.text, orig_id: entry.id } }],
    });
  }

  async search(queryVector: number[], scopeKey: string, topK = 10): Promise<VectorSearchResult[]> {
    const { matches } = await this.index.query({
      vector: queryVector,
      topK,
      filter: { scope_key: { $eq: scopeKey } },
      includeMetadata: true,
    });
    // Pinecone cosine `score` is cosine SIMILARITY (higher = better) — no normalization; ranking matches LanceDB.
    return matches.map((m) => ({
      id: String((m.metadata ?? {})["orig_id"] ?? m.id),
      text: String((m.metadata ?? {})["text"] ?? ""),
      score: m.score ?? 0,
    }));
  }

  /**
   * Delete a single record by `id` within `scopeKey`.
   *
   * Known platform limitation (TOCTOU): Pinecone's free/serverless tier does not support
   * metadata-filtered deletes, so we must fetch the record first to verify ownership, then call
   * `deleteOne`.  A concurrent write that replaces the record between the fetch and the delete
   * could cause the new record to be wrongly deleted.  This is a structural limitation of the
   * Pinecone API; the recommended mitigation for high-write workloads is to use one namespace
   * per tenant (namespace isolation).
   */
  async delete(id: string, scopeKey: string): Promise<void> {
    const scopedId = physicalId(scopeKey, id);
    const result = await this.index.fetch({ ids: [scopedId, id] });
    for (const candidate of [scopedId, id]) {
      const record = result.records[candidate];
      if (record === undefined) continue;
      if (record.metadata?.["scope_key"] !== scopeKey) continue;
      await this.index.deleteOne({ id: candidate });
    }
  }

  /**
   * Erase all records for `scopeKey` and return the number deleted.
   *
   * Enumeration strategy: when the client exposes the optional `listPaginated` capability, we use
   * it to page through all IDs for this scope (exact count, no dimension dependency).  Otherwise
   * we fall back to a high-topK zero-vector query — accurate for conformance-scale collections but
   * may under-count very large scopes (> 10 000 records).
   *
   * NOTE: Pinecone does not offer a deleteByFilter on the free/serverless path.  For high-volume
   * workloads the recommended approach is one namespace per tenant (namespace isolation).
   */
  async eraseScope(scopeKey: string): Promise<{ deleted: number }> {
    const ids = new Set<string>();
    if (typeof this.index.listPaginated === "function") {
      // Paginate through all IDs; Pinecone listPaginated returns up to 100 at a time.
      let token: string | undefined;
      do {
        const page = await this.index.listPaginated!({ prefix: `${encodeIdPart(scopeKey)}/`, limit: 100, paginationToken: token });
        for (const v of page.vectors ?? []) ids.add(v.id);
        token = page.pagination?.next;
      } while (token !== undefined);
    }
    // Also query by metadata to catch legacy non-prefixed IDs and clients without listPaginated.
    const dummyVector = new Array(this.dim).fill(0) as number[];
    const { matches } = await this.index.query({
      vector: dummyVector,
      topK: 10_000,
      filter: { scope_key: { $eq: scopeKey } },
      includeMetadata: false,
    });
    for (const m of matches) ids.add(m.id);
    let deleted = 0;
    for (const id of ids) {
      await this.index.deleteOne({ id });
      deleted += 1;
    }
    return { deleted };
  }

  /**
   * Enumerate every entry in `scopeKey` (used by `Memory.deduplicateArchival` / `reindexEmbeddings`).
   *
   * Pinecone has no "scan all" primitive on the serverless path, so we use a high-topK zero-vector
   * query with the `scope_key` filter and `includeValues` to recover the stored embeddings — the same
   * enumeration strategy `eraseScope` uses. Bounded to 10 000 records (Pinecone's query topK ceiling),
   * which matches `Memory.deduplicateArchival`'s own O(n²) safety cap; larger scopes should be
   * partitioned (e.g. one namespace per tenant) before dedup/reindex.
   */
  async list(scopeKey: string): Promise<VectorEntry[]> {
    const dummyVector = new Array(this.dim).fill(0) as number[];
    const { matches } = await this.index.query({
      vector: dummyVector,
      topK: 10_000,
      filter: { scope_key: { $eq: scopeKey } },
      includeMetadata: true,
      includeValues: true,
    });
    return matches.map((m) => ({
      id: String((m.metadata ?? {})["orig_id"] ?? m.id),
      scopeKey: String((m.metadata ?? {})["scope_key"] ?? scopeKey),
      text: String((m.metadata ?? {})["text"] ?? ""),
      vector: m.values ?? [],
    }));
  }
}
