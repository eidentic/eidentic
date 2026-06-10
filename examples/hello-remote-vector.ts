import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { PgVectorStore } from "@eidentic/pgvector";
import { FakeEmbedder } from "@eidentic/types/testing";

// Remote vector adapter demo (no service needed: embedded Postgres in WASM via pglite).
// Swap `client` for a real `pg.Pool` and this same code talks to a hosted Postgres + pgvector.
const client = new PGlite({ extensions: { vector } });
const embedder = new FakeEmbedder(16); // deterministic, offline — real apps use @eidentic/transformers
const store = await PgVectorStore.create({ client, table: "memories", dim: embedder.dim });

const scopeKey = "user:demo:baran";
for (const [id, text] of [
  ["v1", "I really enjoy writing TypeScript code"],
  ["v2", "I love eating sushi for dinner"],
  ["v3", "The team uses Postgres + pgvector for vector storage"],
] as const) {
  await store.upsert({ id, scopeKey, text, vector: await embedder.embed(text) });
}

const q = await embedder.embed("favorite programming language");
const hits = await store.search(q, scopeKey, 3);
console.log("query: 'favorite programming language'");
console.log("top recall:", hits[0]?.text);
console.log("all:", hits.map((h) => `${h.score.toFixed(3)} ${h.text}`));
