import * as lancedb from "@lancedb/lancedb";
import { Schema, Field, Utf8, FixedSizeList, Float32 } from "apache-arrow";
import type { VectorPort, VectorEntry, VectorSearchResult } from "@eidentic/types";

/**
 * Escape a string value for embedding in a LanceDB SQL filter expression.
 *
 * Trust model: `id` and `scopeKey` values originate from callers and are
 * treated as untrusted user input.  LanceDB (as of 0.x) does not expose a
 * parameterised-query API for filter expressions, so we must sanitise values
 * before interpolating them.
 *
 * Escaping rule: single-quote → `''` (standard SQL literal doubling).
 * Backslash does NOT need escaping: LanceDB's SQL parser (DataFusion) treats
 * `\\` as two literal backslashes, not a single escaped one.  However, note
 * that the parser does accept `\'` as an escape for a single-quote, so the
 * `''` doubling is load-bearing: an unescaped `'` following a `\` would
 * allow injection.  Doubling the `'` to `''` neutralises this because the
 * second `'` is no longer adjacent to the backslash as an escape target.
 *
 * Rejection rule: values that contain NUL bytes (`\x00`) or other ASCII
 * control characters (U+0001–U+001F) are rejected outright because they have
 * no legitimate use in an id or scope key and cannot be represented safely
 * inside a SQL string literal on all LanceDB back-ends.
 */
function sqlLiteral(v: string): string {
  // Reject NUL and control characters (U+0000–U+001F).
  if (/[\x00-\x1f]/.test(v)) {
    throw new Error(
      `sqlLiteral: value contains a NUL or control character (U+${
        [...v].find((c) => c.codePointAt(0)! <= 0x1f)!.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")
      }) which is not permitted in a filter value`,
    );
  }
  // Standard SQL single-quote escaping.  Backslash is NOT escaped — see above.
  return `'${v.replace(/'/g, "''")}'`;
}

export class LanceDBVectorStore implements VectorPort {
  private constructor(
    private readonly db: Awaited<ReturnType<typeof lancedb.connect>>,
    private tbl: lancedb.Table,
    readonly dim: number,
  ) {}

  static async open(dbPath: string, tableName: string, dim: number): Promise<LanceDBVectorStore> {
    const db = await lancedb.connect(dbPath);
    const names = await db.tableNames();
    let tbl: lancedb.Table;
    if (names.includes(tableName)) {
      tbl = await db.openTable(tableName);
    } else {
      const schema = new Schema([
        new Field("id", new Utf8(), true),
        new Field("scope_key", new Utf8(), true),
        new Field("text", new Utf8(), true),
        new Field("vector", new FixedSizeList(dim, new Field("item", new Float32(), true)), true),
      ]);
      tbl = await db.createEmptyTable(tableName, schema);
    }
    return new LanceDBVectorStore(db, tbl, dim);
  }

  async upsert(entry: VectorEntry): Promise<void> {
    if (entry.vector.length !== this.dim) {
      throw new Error(`vector dim ${entry.vector.length} != table dim ${this.dim}`);
    }
    // Atomic upsert via mergeInsert keyed on ["id", "scope_key"] — composite key ensures a same-id
    // row in a DIFFERENT scope is never matched/overwritten (scope-safe). One round-trip vs the prior
    // delete-then-add pair, and no non-atomic window between the two operations.
    // API (LanceDB 0.30.0): table.mergeInsert(on).whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows)
    await this.tbl
      .mergeInsert(["id", "scope_key"])
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute([{ id: entry.id, scope_key: entry.scopeKey, text: entry.text, vector: entry.vector }]);
  }

  async search(queryVector: number[], scopeKey: string, topK = 10): Promise<VectorSearchResult[]> {
    // search(number[]) always returns VectorQuery; cast needed because TS sees the union
    const q = this.tbl.search(queryVector) as lancedb.VectorQuery;
    const rows = (await q
      .distanceType("cosine")
      .where(`scope_key = ${sqlLiteral(scopeKey)}`)
      .select(["id", "text", "_distance"])
      .limit(topK)
      .toArray()) as Array<{ id: string; text: string; _distance: number }>;
    // LanceDB cosine `_distance` = 1 - cosine_similarity, so score = 1 - _distance = cosine similarity.
    // Exact match: _distance = 0 → score = 1.0. Monotonically decreasing distance = increasing similarity.
    return rows.map((r) => ({ id: r.id, text: r.text, score: 1 - r._distance }));
  }

  async delete(id: string, scopeKey: string): Promise<void> {
    await this.tbl.delete(`id = ${sqlLiteral(id)} AND scope_key = ${sqlLiteral(scopeKey)}`);
  }

  async eraseScope(scopeKey: string): Promise<{ deleted: number }> {
    // Count before delete (LanceDB has no RETURNING; countRows is the cheapest way).
    const before = await this.tbl.countRows(`scope_key = ${sqlLiteral(scopeKey)}`);
    await this.tbl.delete(`scope_key = ${sqlLiteral(scopeKey)}`);
    return { deleted: before };
  }

  /**
   * Enumerate every entry in `scopeKey` (used by `Memory.deduplicateArchival` / `reindexEmbeddings`).
   * Plain filtered scan via the query builder (no vector search) — exact and scope-isolated.
   */
  async list(scopeKey: string): Promise<VectorEntry[]> {
    const rows = (await this.tbl
      .query()
      .where(`scope_key = ${sqlLiteral(scopeKey)}`)
      .select(["id", "scope_key", "text", "vector"])
      .toArray()) as Array<{ id: string; scope_key: string; text: string; vector: ArrayLike<number> }>;
    // The `vector` column comes back as an Arrow-backed list (Float32Array-like); normalise to number[].
    return rows.map((r) => ({
      id: r.id,
      scopeKey: r.scope_key,
      text: r.text,
      vector: Array.from(r.vector, Number),
    }));
  }
}
