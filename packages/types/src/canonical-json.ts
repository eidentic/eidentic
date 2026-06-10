/**
 * Canonical JSON serializer with recursively-sorted object keys.
 *
 * Key ordering is deterministic so hash-sensitive consumers (checkpoint chain-hashes,
 * replay hashes, idempotency keys, ed25519 skill signatures) produce stable output
 * regardless of the JS engine's insertion-ordered key iteration.
 *
 * Rules:
 *  - primitives / null  → JSON.stringify (returns "null" for undefined via `?? "null"`)
 *  - arrays             → members serialized recursively, order preserved
 *  - objects            → keys sorted lexicographically before serializing
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson((v as Record<string, unknown>)[k])).join(",") + "}";
}
