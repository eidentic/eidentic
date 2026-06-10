import { describe, it } from "vitest";
import { randomUUID } from "node:crypto";
import { vectorConformanceCases } from "@eidentic/types/testing";
import { QdrantVectorStore } from "../src/index.js";

// Hits a real Qdrant. SKIPPED unless EIDENTIC_TEST_QDRANT_URL is set. Never runs in CI.
// Local:  docker run -p 6333:6333 qdrant/qdrant ; EIDENTIC_TEST_QDRANT_URL=http://localhost:6333 pnpm --filter @eidentic/qdrant test
const url = process.env["EIDENTIC_TEST_QDRANT_URL"];
const live = url ? describe : describe.skip;

live("QdrantVectorStore conformance (live Qdrant)", () => {
  for (const c of vectorConformanceCases(async () => {
    const { QdrantClient } = await import("@qdrant/js-client-rest");
    const client = new QdrantClient({ url, ...(process.env["EIDENTIC_TEST_QDRANT_API_KEY"] ? { apiKey: process.env["EIDENTIC_TEST_QDRANT_API_KEY"] } : {}) });
    const collection = `memories_${randomUUID().slice(0, 8)}`;
    // The conformance suite drives ids like "a"/"b" — Qdrant needs UUID/int ids, so map them deterministically.
    const store = await QdrantVectorStore.create({ client, collection, dim: 4 });
    return store;
  })) it(c.name, c.run);
});
