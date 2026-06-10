import { Memory } from "@eidentic/memory";
import { InMemoryStore } from "@eidentic/types/testing";
import type { Scope } from "@eidentic/types";

const store = new InMemoryStore();
await store.migrate();

// The store is also a GraphPort, so we pass it as both `store` and `graph`.
const memory = new Memory({ store, graph: store });
const scope: Scope = { kind: "user", agentId: "graph-demo", userId: "baran" };

const t1 = "2026-01-01T00:00:00.000Z"; // when we first learn Baran loves TypeScript
const t2 = "2026-03-01T00:00:00.000Z"; // later, he switches to Rust

// 1) Assert the first fact.
const a1 = await memory.assertFact(scope, {
  subject: "Baran", predicate: "favorite_language", object: "TypeScript", validFrom: t1,
});
console.log("asserted #1:", a1.asserted.object, "| invalidated:", a1.invalidated.length);

// 2) Assert a CONTRADICTING fact (same subject+predicate, different object).
//    The prior fact is invalidated (validUntil set), NOT deleted.
const a2 = await memory.assertFact(scope, {
  subject: "Baran", predicate: "favorite_language", object: "Rust", validFrom: t2,
});
console.log("asserted #2:", a2.asserted.object, "| invalidated:", a2.invalidated.map((f) => `${f.object} (until ${f.validUntil})`));

// 3) Currently-valid query → Rust.
const current = await memory.queryFacts({ scope, subject: "Baran", predicate: "favorite_language" });
console.log("\ncurrently believes:", current.map((f) => f.object)); // ["Rust"]

// 4) Point-in-time query "as of" a date BEFORE the switch → TypeScript.
const asOfFeb = await memory.queryFacts({ scope, subject: "Baran", predicate: "favorite_language", validAt: "2026-02-01T00:00:00.000Z" });
console.log("believed on 2026-02-01:", asOfFeb.map((f) => f.object)); // ["TypeScript"]

// 5) Full history (valid + invalidated).
const all = await memory.queryFacts({ scope, subject: "Baran", predicate: "favorite_language", includeInvalidated: true });
console.log("\nfull history:");
for (const f of all) console.log(`  ${f.object}  [${f.validFrom} → ${f.validUntil ?? "now"}]`);
