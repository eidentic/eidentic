import { Memory } from "@eidentic/memory";
import { InMemoryStore, InMemoryVectorStore, FakeEmbedder } from "@eidentic/types/testing";
import { scopeKey } from "@eidentic/types";
import type { Scope } from "@eidentic/types";

// Infra-free demo of GDPR right-to-erasure (§15).
// Uses InMemoryStore + InMemoryVectorStore + FakeEmbedder — no external services needed.

const store = new InMemoryStore();
await store.migrate();

const vector = new InMemoryVectorStore();
const embedder = new FakeEmbedder(16);

const memory = new Memory({ store, graph: store, vector, embedder });

const scope: Scope = { kind: "user", agentId: "erasure-demo", userId: "alice" };
const other: Scope = { kind: "user", agentId: "erasure-demo", userId: "bob" };

const t1 = "2026-01-01T00:00:00.000Z";

// --- Seed scope (Alice) ---

// Ingest memories (lexical + semantic)
await memory.ingest([
  { id: "m1", scope, text: "Alice loves hiking and being in nature" },
  { id: "m2", scope, text: "Alice lives in Berlin, Germany" },
]);

// Assert facts into the temporal KG
await memory.assertFact(scope, { subject: "Alice", predicate: "lives_in", object: "Berlin", validFrom: t1 });
await memory.assertFact(scope, { subject: "Alice", predicate: "hobby", object: "hiking", validFrom: t1 });

// --- Seed another scope (Bob) — must survive erasure ---
await memory.ingest([{ id: "m3", scope: other, text: "Bob enjoys cooking" }]);
await memory.assertFact(other, { subject: "Bob", predicate: "hobby", object: "cooking", validFrom: t1 });

// --- Verify recall works before erasure ---
const recallBefore = await memory.retrieve({ text: "hiking nature", scope, topK: 5 });
console.log("Before erasure — Alice recall hits:", recallBefore.snippets.map((s) => s.id));

const factsBefore = await memory.queryFacts({ scope, subject: "Alice" });
console.log("Before erasure — Alice facts:", factsBefore.map((f) => `${f.predicate}=${f.object}`));

// --- Erase Alice's scope (GDPR §15) ---
const counts = await memory.eraseScope(scope);
console.log(`\neraseScope done — store rows deleted: ${counts.store}, vector entries deleted: ${counts.vector}`);

// --- Verify Alice's data is gone ---
const recallAfter = await memory.retrieve({ text: "hiking nature", scope, topK: 5 });
console.log("\nAfter erasure — Alice recall hits:", recallAfter.snippets.map((s) => s.id)); // []

const factsAfter = await memory.queryFacts({ scope, subject: "Alice" });
console.log("After erasure — Alice facts:", factsAfter.map((f) => `${f.predicate}=${f.object}`)); // []

// Verify Alice's scope_key has no vector entries
const vectorHits = await vector.search(await embedder.embed("hiking"), scopeKey(scope), 10);
console.log("After erasure — Alice vector hits:", vectorHits.map((h) => h.id)); // []

// --- Verify Bob's data is intact ---
const bobFacts = await memory.queryFacts({ scope: other, subject: "Bob" });
console.log("\nBob's facts (untouched):", bobFacts.map((f) => `${f.predicate}=${f.object}`)); // ["hobby=cooking"]

const bobRecall = await memory.retrieve({ text: "cooking", scope: other, topK: 5 });
console.log("Bob's recall (untouched):", bobRecall.snippets.map((s) => s.id)); // ["m3"]

console.log("\nAll assertions passed — right-to-erasure (§15) working correctly.");
