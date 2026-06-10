import { SqliteStore } from "@eidentic/sqlite";
import { LanceDBVectorStore } from "@eidentic/lancedb";
import { LocalEmbedder } from "@eidentic/transformers";
import { Memory } from "@eidentic/memory";

// Semantic recall demo: a paraphrased query with NO shared keywords still recalls the right memory.
const store = new SqliteStore("./eidentic-demo.sqlite");
await store.migrate();
const embedder = await LocalEmbedder.load(); // downloads ~129MB on first run
const vector = await LanceDBVectorStore.open("./eidentic-lance", "memories", embedder.dim);
const memory = new Memory({ store, vector, embedder });

const scope = { kind: "user", agentId: "vec", userId: "baran" } as const;
await memory.ingest([
  { id: "v1", scope, text: "I really enjoy writing TypeScript code" },
  { id: "v2", scope, text: "I love eating sushi for dinner" },
  { id: "v3", scope, text: "The team uses LanceDB for vector storage" },
]);

const { snippets } = await memory.retrieve({ text: "favorite programming language", scope });
console.log("query: 'favorite programming language' (no shared keywords)");
console.log("top recall:", snippets[0]?.text);
console.log("all:", snippets.map((s) => `${s.score.toFixed(3)} ${s.text}`));
await store.close();
