import { describe, it } from "vitest";
import { vectorConformanceCases } from "@eidentic/types/testing";
import { PineconeVectorStore } from "../src/index.js";

// Hits a real Pinecone. SKIPPED unless EIDENTIC_TEST_PINECONE_API_KEY and EIDENTIC_TEST_PINECONE_INDEX are set.
// The target index MUST be pre-created with dimension 4 and the cosine metric. Never runs in CI.
const apiKey = process.env.EIDENTIC_TEST_PINECONE_API_KEY;
const indexName = process.env.EIDENTIC_TEST_PINECONE_INDEX;
const live = apiKey && indexName ? describe : describe.skip;

live("PineconeVectorStore conformance (live Pinecone)", () => {
  for (const c of vectorConformanceCases(async () => {
    const { Pinecone } = await import("@pinecone-database/pinecone");
    const pc = new Pinecone({ apiKey: apiKey! });
    // Namespace per-run to isolate; the conformance suite already isolates by scope_key metadata filter.
    const index = pc.index(indexName!).namespace(`conf_${Math.random().toString(36).slice(2, 8)}`);
    return PineconeVectorStore.create({ index, dim: 4 });
  })) it(c.name, c.run, 30_000);
});
