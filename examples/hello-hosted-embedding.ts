import { Memory } from "@eidentic/memory";
import { AIEmbedder } from "@eidentic/model";
import { InMemoryStore, InMemoryVectorStore } from "@eidentic/types/testing";
import { MockEmbeddingModelV3 } from "ai/test";
import type { Scope } from "@eidentic/types";

// Bring your own provider + key + model. Any @ai-sdk/* embedding model works, e.g.:
//   import { openai } from "@ai-sdk/openai";
//   const embedder = await AIEmbedder.create(openai.embedding("text-embedding-3-small"));
// Here we use AI SDK's test mock so the example runs with no key and no native deps.
const model = new MockEmbeddingModelV3({
  doEmbed: async ({ values }) => ({ embeddings: values.map((v) => [v.length, 1, 0, 0]) }),
});
const embedder = await AIEmbedder.create(model);
console.log("hosted embedder dim:", embedder.dim);

const store = new InMemoryStore();
await store.migrate();
const memory = new Memory({ store, vector: new InMemoryVectorStore(), embedder });
const scope: Scope = { kind: "user", agentId: "demo", userId: "u" };

await memory.ingest([{ id: "m1", scope, text: "Eidentic is a TypeScript agentic SDK" }]);
const { snippets } = await memory.retrieve({ text: "what is Eidentic", scope });
console.log("recall:", snippets.map((s) => s.text));
console.log(
  "\nSwap the mock for openai.embedding(...) (or any @ai-sdk provider) to use real hosted embeddings — local @eidentic/transformers and hosted AIEmbedder are equal, interchangeable EmbeddingPort options.",
);
