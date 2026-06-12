// Compile-time regression guard. This file is type-checked by `tsc` (the package tsconfig globs
// all of `src`) but is NOT reachable from the package entry, so tsup never bundles it and it adds
// nothing to the published dist / public types.
//
// It asserts that a concrete `@qdrant/js-client-rest` client stays structurally assignable to the
// `QdrantLike` surface the adapter accepts — so users can pass `new QdrantClient(...)` straight into
// `QdrantVectorStore.create({ client })`. A too-narrow method return type on `QdrantLike` (e.g. the
// `scroll` point `vector` field omitting Qdrant's multi-vector `number[][]` shape) breaks that
// assignment; this guard turns that into a typecheck failure instead of a downstream user error.
import type { QdrantClient } from "@qdrant/js-client-rest";
import type { QdrantLike } from "./index.js";

export const _qdrantClientIsAssignableToQdrantLike = (client: QdrantClient): QdrantLike => client;
