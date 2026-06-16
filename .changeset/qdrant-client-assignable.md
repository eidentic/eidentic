---
"@eidentic/qdrant": patch
---

Fix: a concrete `QdrantClient` from `@qdrant/js-client-rest` was not assignable to the `QdrantLike`
interface `QdrantVectorStore.create({ client })` accepts. The `scroll` return type added for
`VectorPort.list` was too narrow — the real client's points can carry a multi-vector (`number[][]`)
or named-vector `vector`, and `next_page_offset` can be a point-id record. Both are now widened to
supertypes of the real shapes, so `new QdrantClient(...)` type-checks directly. A compile-time guard
(`src/_compat.ts`, type-checked but not bundled) prevents this regression.
