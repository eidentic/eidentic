/**
 * Schema / Prompt Evolution (§19) — infra-free demo.
 *
 * Three concrete §19 features shown without a real API key:
 *
 *   (a) §19.1 Event-schema upcasting: build a v0→v1 upcaster, feed a synthetic "old"
 *       log through upcastEvents, show the transformed events.
 *   (b) §19.3 Embedding model migration / re-index: ingest passages with embedder A
 *       (dim=8), then reindexEmbeddings with embedder B (dim=16), show the count and
 *       verify the new dimension.
 *   (c) §19.4 Instruction versioning: show that session.init includes instructionsVersion
 *       when configured on the agent (uses a scripted MockModel, no real calls).
 *
 * Run:  pnpm -C examples hello:schema-evolution
 */
import {
  upcastEvents,
  EVENT_SCHEMA_VERSION,
  type StoredEvent,
  type Upcaster,
} from "@eidentic/types";
import { FakeEmbedder, InMemoryStore, InMemoryVectorStore, MockModel } from "@eidentic/types/testing";
import { textBlock, type StreamEvent } from "@eidentic/types";
import { Agent } from "@eidentic/core";
import { Memory } from "@eidentic/memory";
import type { Scope } from "@eidentic/types";

// ---------------------------------------------------------------------------
// (a) §19.1 — Event-schema upcasting
// ---------------------------------------------------------------------------

console.log("=== §19.1 Event-schema upcasting ===\n");

// Pretend we have events persisted at schemaVersion 0.
// Old format: payload was { legacyText: string }.
// New format (v1): payload is the raw string.
const oldLog: StoredEvent[] = [
  {
    id: "old_evt_0",
    sessionId: "legacy_session",
    seq: 0,
    kind: "user",
    schemaVersion: 0, // old version
    payload: { legacyText: "What is the capital of France?" },
    createdAt: "2025-01-01T00:00:00.000Z",
  },
  {
    id: "old_evt_1",
    sessionId: "legacy_session",
    seq: 1,
    kind: "assistant",
    schemaVersion: 0,
    payload: { legacyContent: [{ t: "Paris" }] },
    createdAt: "2025-01-01T00:00:01.000Z",
  },
];

// Register a v0→v1 upcaster for each kind.
const upcasters: Record<number, Upcaster> = {
  0: (e) => {
    if (e.kind === "user") {
      const legacy = e.payload as { legacyText: string };
      return { ...e, schemaVersion: 1, payload: legacy.legacyText };
    }
    if (e.kind === "assistant") {
      const legacy = e.payload as { legacyContent: Array<{ t: string }> };
      return {
        ...e,
        schemaVersion: 1,
        payload: { content: legacy.legacyContent.map((b) => ({ type: "text", text: b.t })) },
      };
    }
    return { ...e, schemaVersion: 1 };
  },
};

const upcasted = upcastEvents(oldLog, upcasters);

console.log(`Old log: ${oldLog.length} events at schemaVersion ${oldLog[0]!.schemaVersion}`);
console.log(`Upcasted to: schemaVersion ${upcasted[0]!.schemaVersion} (EVENT_SCHEMA_VERSION = ${EVENT_SCHEMA_VERSION})`);
console.log(`User event payload: "${upcasted[0]!.payload}"`);
console.log(`Assistant event payload: ${JSON.stringify(upcasted[1]!.payload)}`);
console.log();

// Verify no-op path at v1 (same array reference)
const currentLog: StoredEvent[] = [
  { ...oldLog[0]!, schemaVersion: 1, payload: "already v1" },
];
const noopResult = upcastEvents(currentLog);
const sameRef = noopResult === currentLog;
console.log(`No-op at v1: same array reference = ${sameRef} (zero allocation fast path)`);
console.log();

// ---------------------------------------------------------------------------
// (b) §19.3 — Embedding model migration / re-index
// ---------------------------------------------------------------------------

console.log("=== §19.3 Embedding model migration / reindexEmbeddings ===\n");

const store = new InMemoryStore();
const vector = new InMemoryVectorStore();
const embedderA = new FakeEmbedder(8); // initial embedder: dim=8
const scope: Scope = { kind: "agent", agentId: "schema-evo-demo" };

const memA = new Memory({ store, vector, embedder: embedderA });

// Ingest passages with embedder A
const passages = [
  "The capital of France is Paris.",
  "Quantum entanglement is a fundamental phenomenon in physics.",
  "Eidentic is an open-source TypeScript agentic SDK.",
];

for (let i = 0; i < passages.length; i++) {
  await memA.ingest([{ scope, id: `passage_${i}`, text: passages[i]! }]);
}

console.log(`Ingested ${passages.length} passages with embedder A (dim=${embedderA.dim})`);

const skBefore = "agent:schema-evo-demo";
const beforeEntries = await vector.list(skBefore);
console.log(`Before reindex: ${beforeEntries.length} entries, vector dim = ${beforeEntries[0]?.vector.length}`);

// Swap to embedder B (dim=16) and reindex
const embedderB = new FakeEmbedder(16);
const memB = new Memory({ store, vector, embedder: embedderB });
const { reindexed } = await memB.reindexEmbeddings(scope);

console.log(`After reindexEmbeddings: reindexed = ${reindexed}`);
const afterEntries = await vector.list(skBefore);
console.log(`After reindex: ${afterEntries.length} entries, vector dim = ${afterEntries[0]?.vector.length}`);

// Retrieval still works
const qv = await embedderB.embed("capital France");
const hits = await vector.search(qv, skBefore, 3);
console.log(`Retrieval after reindex (query: "capital France"): ${hits.length} hits`);
if (hits[0]) {
  console.log(`  Top hit: "${hits[0].text.slice(0, 50)}" (score: ${hits[0].score.toFixed(3)})`);
}
console.log();

// ---------------------------------------------------------------------------
// (c) §19.4 — Instruction versioning in session.init
// ---------------------------------------------------------------------------

console.log("=== §19.4 Instruction versioning in session.init ===\n");

const agentStore = new InMemoryStore();
await agentStore.migrate();

const model = new MockModel([
  { content: [textBlock("Hello, I am running on prompt version v3!")], usage: { inputTokens: 10, outputTokens: 8 } },
]);

const agent = new Agent({
  id: "schema-evo-agent",
  instructions: "You are a helpful assistant.",
  model,
  store: agentStore,
  instructionsVersion: "v3",   // §19.4: stamp the prompt version
  maxTurns: 4,
});

const events: StreamEvent[] = [];
for await (const ev of agent.query("hello", { sessionId: "sess_iv_demo" })) {
  events.push(ev);
}

const init = events.find((e) => e.type === "session.init");
if (init && init.type === "session.init") {
  console.log(`session.init.instructionsVersion: "${init.instructionsVersion}"`);
} else {
  console.log("ERROR: session.init not found");
}

// No instructionsVersion → absent from payload (byte-identical)
const agentStore2 = new InMemoryStore();
await agentStore2.migrate();
const model2 = new MockModel([
  { content: [textBlock("hi")], usage: { inputTokens: 5, outputTokens: 2 } },
]);
const agent2 = new Agent({
  id: "schema-evo-agent-2",
  instructions: "You are a helpful assistant.",
  model: model2,
  store: agentStore2,
  maxTurns: 4,
  // instructionsVersion: not set
});

const events2: StreamEvent[] = [];
for await (const ev of agent2.query("hello", { sessionId: "sess_no_iv" })) {
  events2.push(ev);
}
const init2 = events2.find((e) => e.type === "session.init");
const hasVersion = init2 && "instructionsVersion" in init2;
console.log(`Without instructionsVersion: key present in session.init = ${hasVersion ?? false} (should be false)`);

console.log();
console.log("=== Done. All three §19 pieces demonstrated without a real API key. ===");
