import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it } from "vitest";
import { Pinecone } from "@pinecone-database/pinecone";
import { vectorConformanceCases } from "@eidentic/types/testing";
import { PineconeVectorStore } from "../src/index.js";

// Hits real Pinecone. SKIPPED unless EIDENTIC_TEST_PINECONE_API_KEY is set. When no index is
// supplied, the suite creates a disposable dimension-4 cosine serverless index and deletes it in
// afterAll. A supplied index is never deleted; only the random test namespaces are removed.
const apiKey = process.env.EIDENTIC_TEST_PINECONE_API_KEY;
let indexName = process.env.EIDENTIC_TEST_PINECONE_INDEX;
const live = apiKey ? describe : describe.skip;
const pc = apiKey ? new Pinecone({ apiKey }) : undefined;
let createdIndex = false;
const namespaces = new Set<string>();

beforeAll(async () => {
  if (!pc || indexName) return;
  indexName = `eidentic-live-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  await pc.createIndex({
    name: indexName,
    dimension: 4,
    metric: "cosine",
    spec: {
      serverless: {
        cloud: process.env.EIDENTIC_TEST_PINECONE_CLOUD ?? "aws",
        region: process.env.EIDENTIC_TEST_PINECONE_REGION ?? "us-east-1",
      },
    },
    deletionProtection: "disabled",
    tags: { purpose: "eidentic-live-conformance" },
    waitUntilReady: true,
  });
  createdIndex = true;
}, 180_000);

afterAll(async () => {
  if (!pc || !indexName) return;
  if (createdIndex) {
    await pc.deleteIndex(indexName);
    return;
  }
  const index = pc.index(indexName);
  const cleanup = await Promise.allSettled(
    [...namespaces].map((namespace) => index.deleteNamespace(namespace)),
  );
  const failures = cleanup.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((result) => result.reason),
      `failed to delete ${failures.length} Pinecone test namespace(s)`,
    );
  }
}, 180_000);

live("PineconeVectorStore conformance (live Pinecone)", () => {
  for (const c of vectorConformanceCases(async () => {
    if (!pc || !indexName) throw new Error("live Pinecone index is not initialized");
    const namespace = `conf_${randomUUID().replaceAll("-", "")}`;
    namespaces.add(namespace);
    const index = pc.index(indexName).namespace(namespace);
    return PineconeVectorStore.create({ index, dim: 4 });
  })) it(c.name, c.run, 30_000);
});
