import { describe, it, expect } from "vitest";
import { InMemoryStore, MockModel, FakeEmbedder, InMemoryVectorStore } from "@eidentic/types/testing";
import { SqliteStore } from "@eidentic/sqlite";
import {
  toolUseBlock,
  defaultConsentClassifier,
  type GraphPort,
  type StorePort,
  type Scope,
  type ConsentManifest,
} from "@eidentic/types";
import { Memory, ConsentRejectedError } from "../src/memory.js";
import { Consolidator } from "../src/consolidate.js";

type MakeStore = () => StorePort & GraphPort;
const backends: Array<[string, MakeStore]> = [
  ["InMemoryStore", () => new InMemoryStore()],
  ["SqliteStore", () => new SqliteStore(":memory:")],
];

const scope: Scope = { kind: "user", agentId: "a", userId: "u" };
const t1 = "2026-01-01T00:00:00.000Z";
const t2 = "2026-03-01T00:00:00.000Z";
const between = "2026-02-01T00:00:00.000Z";

// =====================================================================================
// Feature 1: State transitions (evolution, not replacement)
// =====================================================================================
describe.each(backends)("Feature 1 — state-transition timelines (%s)", (_label, makeStore) => {
  it("NY→SF: old invalidated with supersedes link; point-in-time correct for both eras; factTimeline returns both", async () => {
    const store = makeStore();
    await store.migrate();
    try {
      const mem = new Memory({ store, graph: store });
      const ny = await mem.assertFact(scope, { subject: "Baran", predicate: "lives_in", object: "NY", validFrom: t1 });
      const sf = await mem.assertFact(scope, { subject: "Baran", predicate: "lives_in", object: "SF", validFrom: t2 });

      // The new fact links to the prior via supersedes; the old is invalidated at t2.
      expect(sf.asserted.supersedes).toBe(ny.asserted.id);
      expect(sf.invalidated.map((f) => f.object)).toEqual(["NY"]);
      expect(sf.invalidated[0]!.validUntil).toBe(t2);

      // Point-in-time: in the NY era → NY; in the SF era → SF.
      const eraNY = await mem.queryFacts({ scope, subject: "Baran", validAt: between });
      expect(eraNY.map((f) => f.object)).toEqual(["NY"]);
      const eraSF = await mem.queryFacts({ scope, subject: "Baran", validAt: t2 });
      expect(eraSF.map((f) => f.object)).toEqual(["SF"]);

      // factTimeline returns the full ascending history (both versions).
      const timeline = await mem.factTimeline(scope, "Baran", "lives_in");
      expect(timeline.map((f) => f.object)).toEqual(["NY", "SF"]);
      expect(timeline[0]!.validUntil).toBe(t2);
      expect(timeline[1]!.validUntil).toBeUndefined();
      expect(timeline[1]!.supersedes).toBe(ny.asserted.id);
    } finally {
      await store.close();
    }
  });

  it("first version in a chain has no supersedes link", async () => {
    const store = makeStore();
    await store.migrate();
    try {
      const mem = new Memory({ store, graph: store });
      const r = await mem.assertFact(scope, { subject: "X", predicate: "p", object: "1", validFrom: t1 });
      expect(r.asserted.supersedes).toBeUndefined();
    } finally {
      await store.close();
    }
  });
});

// =====================================================================================
// Feature 2: Corroboration / staleness tiers
// =====================================================================================
describe.each(backends)("Feature 2 — corroboration + staleness flagging (%s)", (_label, makeStore) => {
  it("corroborate-on-match: re-consolidating the same triple corroborates (no duplicate fact)", async () => {
    const store = makeStore();
    await store.migrate();
    try {
      const rec = (facts: unknown[]) => ({
        content: [toolUseBlock("c1", "record_facts", { facts })],
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      const src = "Baran works at Acme Corp.";
      const factPayload = [{ subject: "Baran", predicate: "works_at", object: "Acme Corp", sourceQuote: "Baran works at Acme Corp" }];
      const model = new MockModel([rec(factPayload), rec(factPayload)]);
      const c = new Consolidator({ model, graph: store, now: () => t1 });

      const r1 = await c.consolidate({ scope, text: src });
      expect(r1.facts).toHaveLength(1);
      expect(r1.corroborated).toHaveLength(0);

      // Second pass: same triple → corroborated, NOT a new fact.
      const c2 = new Consolidator({ model, graph: store, now: () => t2 });
      const r2 = await c2.consolidate({ scope, text: src });
      expect(r2.facts).toHaveLength(0);
      expect(r2.corroborated).toHaveLength(1);

      // Exactly one fact row (no duplicate) and its corroboration was bumped to t2.
      const all = await store.queryFacts({ scope, subject: "Baran", includeInvalidated: true });
      expect(all).toHaveLength(1);
      expect(all[0]!.lastCorroboratedAt).toBe(Date.parse(t2));
    } finally {
      await store.close();
    }
  });

  it("stale flagging + context annotation: a fact past its corroboration window is flagged and annotated, not dropped", async () => {
    const store = makeStore();
    await store.migrate();
    try {
      // now is far in the future; works_at window is 90 days.
      const now = "2026-12-01T00:00:00.000Z";
      const mem = new Memory({
        store,
        graph: store,
        corroborationTtlMs: { works_at: 90 * 86_400_000 },
        now: () => now,
      });
      // Index a memory entry so the entity signal has something to match the query against,
      // and assert the fact (lastCorroboratedAt defaults to validFrom = t1, ~11 months ago).
      await mem.ingest([{ id: "m1", scope, text: "Where does Baran work" }]);
      await mem.assertFact(scope, { subject: "Baran", predicate: "works_at", object: "Acme", validFrom: t1 });

      const { snippets } = await mem.retrieve({ text: "Where does Baran work Acme", scope });
      const factSnippet = snippets.find((s) => s.id.startsWith("fact:"));
      expect(factSnippet).toBeDefined();
      expect(factSnippet!.stale).toBe(true);
      expect(factSnippet!.text).toMatch(/last confirmed >\d+d ago — may be outdated/);
    } finally {
      await store.close();
    }
  });

  it("fresh fact (recently corroborated) is NOT flagged stale", async () => {
    const store = makeStore();
    await store.migrate();
    try {
      const now = "2026-01-10T00:00:00.000Z"; // 9 days after t1, window is 90 days
      const mem = new Memory({ store, graph: store, corroborationTtlMs: { works_at: 90 * 86_400_000 }, now: () => now });
      await mem.ingest([{ id: "m1", scope, text: "Where does Baran work" }]);
      await mem.assertFact(scope, { subject: "Baran", predicate: "works_at", object: "Acme", validFrom: t1 });
      const { snippets } = await mem.retrieve({ text: "Where does Baran work Acme", scope });
      const factSnippet = snippets.find((s) => s.id.startsWith("fact:"));
      expect(factSnippet?.stale).toBeUndefined();
      expect(factSnippet?.text).not.toMatch(/may be outdated/);
    } finally {
      await store.close();
    }
  });

  it("corroborationTtlMs OFF by default: no staleness flagging", async () => {
    const store = makeStore();
    await store.migrate();
    try {
      const now = "2026-12-01T00:00:00.000Z";
      const mem = new Memory({ store, graph: store, now: () => now });
      await mem.ingest([{ id: "m1", scope, text: "Where does Baran work" }]);
      await mem.assertFact(scope, { subject: "Baran", predicate: "works_at", object: "Acme", validFrom: t1 });
      const { snippets } = await mem.retrieve({ text: "Where does Baran work Acme", scope });
      const factSnippet = snippets.find((s) => s.id.startsWith("fact:"));
      expect(factSnippet?.stale).toBeUndefined();
    } finally {
      await store.close();
    }
  });
});

// =====================================================================================
// Feature 3: ConsentManifest
// =====================================================================================
describe("Feature 3 — defaultConsentClassifier", () => {
  it("classifies obvious categories", () => {
    expect(defaultConsentClassifier("my email is a@b.com")).toBe("contact-info");
    expect(defaultConsentClassifier("I was diagnosed with diabetes")).toBe("health");
    expect(defaultConsentClassifier("I live in Berlin")).toBe("location");
    expect(defaultConsentClassifier("I love TypeScript")).toBeUndefined();
  });
});

describe.each(backends)("Feature 3 — ConsentManifest enforcement (%s)", (_label, makeStore) => {
  it("never: assertFact rejects a forbidden-category fact (ConsentRejectedError)", async () => {
    const store = makeStore();
    await store.migrate();
    try {
      const consent: ConsentManifest = { categories: { health: "never" } };
      const mem = new Memory({ store, graph: store, consent });
      await expect(
        mem.assertFact(scope, { subject: "Baran", predicate: "diagnosed_with", object: "diabetes", validFrom: t1 }),
      ).rejects.toBeInstanceOf(ConsentRejectedError);
      // Unrestricted fact passes.
      const ok = await mem.assertFact(scope, { subject: "Baran", predicate: "likes", object: "tea", validFrom: t1 });
      expect(ok.asserted.object).toBe("tea");
      const all = await store.queryFacts({ scope, includeInvalidated: true });
      expect(all.map((f) => f.object)).toEqual(["tea"]);
    } finally {
      await store.close();
    }
  });

  it("session: applies a short TTL so the fact expires on sweep", async () => {
    const store = makeStore();
    await store.migrate();
    try {
      const consent: ConsentManifest = { categories: { location: "session" }, sessionTtlMs: 60_000 };
      const mem = new Memory({ store, graph: store, consent });
      const r = await mem.assertFact(scope, { subject: "Baran", predicate: "lives_in", object: "Berlin", validFrom: t1 });
      expect(r.asserted.expiresAt).toBe("2026-01-01T00:01:00.000Z"); // validFrom + 60s
      // Sweep after expiry → invalidated.
      const swept = await mem.sweepExpiredFacts(scope, "2026-01-01T00:02:00.000Z");
      expect(swept).toBe(1);
    } finally {
      await store.close();
    }
  });

  it("number: applies the retention TTL as expiresAt", async () => {
    const store = makeStore();
    await store.migrate();
    try {
      const consent: ConsentManifest = { categories: { location: 86_400_000 } }; // 1 day
      const mem = new Memory({ store, graph: store, consent });
      const r = await mem.assertFact(scope, { subject: "Baran", predicate: "lives_in", object: "Berlin", validFrom: t1 });
      expect(r.asserted.expiresAt).toBe("2026-01-02T00:00:00.000Z");
    } finally {
      await store.close();
    }
  });

  it("retroactive applyConsent: sweeps now-forbidden facts (invalidated, audit-preserved) + counts", async () => {
    const store = makeStore();
    await store.migrate();
    try {
      // Ingest WITHOUT consent first (data already stored).
      const mem = new Memory({ store, graph: store });
      await mem.assertFact(scope, { subject: "Baran", predicate: "diagnosed_with", object: "diabetes", validFrom: t1 });
      await mem.assertFact(scope, { subject: "Baran", predicate: "likes", object: "tea", validFrom: t1 });
      expect((await store.queryFacts({ scope })).length).toBe(2);

      // Now apply a manifest forbidding health, retroactively.
      const manifest: ConsentManifest = { categories: { health: "never" } };
      const res = await mem.applyConsent(scope, manifest);
      expect(res.rejected).toBe(1);
      expect(res.sweptFacts).toBe(1);

      // The health fact is invalidated (gone from currently-valid) but preserved in the audit trail.
      const current = await store.queryFacts({ scope });
      expect(current.map((f) => f.object)).toEqual(["tea"]);
      const all = await store.queryFacts({ scope, includeInvalidated: true });
      expect(all.find((f) => f.object === "diabetes")?.validUntil).toBeDefined();
    } finally {
      await store.close();
    }
  });

  it("retroactive applyConsent: erases now-forbidden memory entries (counted, observable)", async () => {
    const store = makeStore();
    await store.migrate();
    try {
      const manifest: ConsentManifest = { categories: { "contact-info": "never" } };
      // Consent must be configured at ingest so the raw text is cached for re-classification.
      const mem = new Memory({ store, graph: store, consent: { categories: {} } });
      await mem.ingest([
        { id: "mem-contact", scope, text: "reach me at baran@example.com anytime" },
        { id: "mem-plain", scope, text: "I enjoy hiking on weekends" },
      ]);
      const res = await mem.applyConsent(scope, manifest);
      expect(res.sweptMemories).toBe(1);
      expect(res.rejected).toBe(1);
    } finally {
      await store.close();
    }
  });

  it("ingest drops never-category memory entries at write time", async () => {
    const store = makeStore();
    await store.migrate();
    try {
      const consent: ConsentManifest = { categories: { "contact-info": "never" } };
      const mem = new Memory({ store, graph: store, consent });
      await mem.ingest([
        { id: "c1", scope, text: "my phone is 555 123 4567" },
        { id: "p1", scope, text: "I like green tea very much" },
      ]);
      // The contact-info entry was rejected; only the plain one is searchable.
      const hits = await store.searchMemory(scope, "phone tea", 10);
      expect(hits.map((h) => h.id)).toEqual(["p1"]);
    } finally {
      await store.close();
    }
  });
});

// =====================================================================================
// Feature 4: GDPR-portable export
// =====================================================================================
describe.each(backends)("Feature 4 — exportScope (%s)", (_label, makeStore) => {
  it("returns a versioned envelope with memories, facts (temporal), blocks + history", async () => {
    const store = makeStore();
    await store.migrate();
    try {
      const mem = new Memory({ store, graph: store, consent: { categories: {} }, now: () => t2 });
      await mem.ingest([{ id: "m1", scope, text: "Baran enjoys hiking", metadata: { source: "chat" } }]);
      await mem.assertFact(scope, { subject: "Baran", predicate: "lives_in", object: "NY", validFrom: t1 });
      await mem.assertFact(scope, { subject: "Baran", predicate: "lives_in", object: "SF", validFrom: t2 });
      await mem.rewrite(scope, "persona", "I am helpful", 0).catch(() => {});
      await store.upsertBlock(scope, { label: "persona", value: "v0" });
      await store.upsertBlock(scope, { label: "persona", value: "v1" }, 0);

      const exp = await mem.exportScope(scope);
      expect(exp.schema).toBe("eidentic.memory.export.v1");
      expect(exp.exportedAt).toBe(t2);
      expect(exp.scope).toEqual(scope);
      // Facts: full timeline incl. supersedes + lastCorroboratedAt.
      expect(exp.facts.map((f) => f.object).sort()).toEqual(["NY", "SF"]);
      const sf = exp.facts.find((f) => f.object === "SF")!;
      expect(sf.supersedes).toBeDefined();
      expect(sf.lastCorroboratedAt).toBe(Date.parse(t2));
      // Memories present with provenance.
      expect(exp.memories.find((m) => m.id === "m1")?.text).toBe("Baran enjoys hiking");
      // Blocks + history.
      expect(exp.blocks.find((b) => b.label === "persona")?.value).toBe("v1");
      expect(exp.blockHistory["persona"]?.map((h) => h.value)).toEqual(["v0", "v1"]);
    } finally {
      await store.close();
    }
  });
});

// =====================================================================================
// Feature 5: Identity merge (anonymous → authenticated)
// =====================================================================================
describe.each(backends)("Feature 5 — mergeScopes (%s)", (_label, makeStore) => {
  const anon: Scope = { kind: "thread", agentId: "a", sessionId: "anon-1" };
  const user: Scope = { kind: "user", agentId: "a", userId: "alice" };

  it("memories + facts land in target with provenance; source erased; blocks copied conservatively", async () => {
    const store = makeStore();
    await store.migrate();
    try {
      const mem = new Memory({ store, graph: store, consent: { categories: {} } });
      await mem.ingest([{ id: "am1", scope: anon, text: "User prefers dark mode" }]);
      await mem.assertFact(anon, { subject: "alice", predicate: "prefers", object: "dark-mode", validFrom: t1 });
      await store.upsertBlock(anon, { label: "scratch", value: "anon notes" });

      const counts = await mem.mergeScopes(anon, user);
      expect(counts.memories).toBe(1);
      expect(counts.facts).toBe(1);
      expect(counts.blocks).toBe(1);

      // Data in target.
      expect((await store.searchMemory(user, "dark mode", 10)).length).toBe(1);
      const targetFacts = await store.queryFacts({ scope: user, subject: "alice" });
      expect(targetFacts.map((f) => f.object)).toEqual(["dark-mode"]);
      expect((await store.getBlock(user, "scratch"))?.value).toBe("anon notes");

      // Provenance on the merged memory.
      const exp = await mem.exportScope(user);
      const merged = exp.memories.find((m) => m.id === "am1");
      expect(merged?.metadata?.["mergedFrom"]).toBe("thread:a:anon-1");
      expect(merged?.metadata?.["mergedAt"]).toBeDefined();

      // Source erased.
      expect(await store.queryFacts({ scope: anon, subject: "alice" })).toEqual([]);
      expect(await store.searchMemory(anon, "dark mode", 10)).toEqual([]);
      expect(await store.getBlock(anon, "scratch")).toBeNull();
    } finally {
      await store.close();
    }
  });

  it("conflict keep-both: target contradictions invalidate per validFrom order; timeline shows both", async () => {
    const store = makeStore();
    await store.migrate();
    try {
      const mem = new Memory({ store, graph: store });
      // Target already has an OLDER fact; source has a NEWER contradicting fact.
      await mem.assertFact(user, { subject: "alice", predicate: "lives_in", object: "NY", validFrom: t1 });
      await mem.assertFact(anon, { subject: "alice", predicate: "lives_in", object: "SF", validFrom: t2 });

      await mem.mergeScopes(anon, user, { conflict: "keep-both" });

      const timeline = await mem.factTimeline(user, "alice", "lives_in");
      expect(timeline.map((f) => f.object)).toEqual(["NY", "SF"]);
      expect(timeline[0]!.validUntil).toBe(t2); // NY invalidated when SF merged in
      expect(timeline[1]!.validUntil).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it("conflict prefer-target: source fact skipped when target already has a current fact for (subject,predicate)", async () => {
    const store = makeStore();
    await store.migrate();
    try {
      const mem = new Memory({ store, graph: store });
      await mem.assertFact(user, { subject: "alice", predicate: "lives_in", object: "NY", validFrom: t1 });
      await mem.assertFact(anon, { subject: "alice", predicate: "lives_in", object: "SF", validFrom: t2 });

      const counts = await mem.mergeScopes(anon, user, { conflict: "prefer-target" });
      expect(counts.facts).toBe(0); // SF skipped — target already had a current lives_in fact

      const current = await store.queryFacts({ scope: user, subject: "alice" });
      expect(current.map((f) => f.object)).toEqual(["NY"]);
    } finally {
      await store.close();
    }
  });

  it("crash-safety: a failing erase step does NOT lose source data (copy happened first)", async () => {
    const store = makeStore();
    await store.migrate();
    try {
      const mem = new Memory({ store, graph: store, consent: { categories: {} } });
      await mem.ingest([{ id: "am1", scope: anon, text: "User prefers dark mode" }]);
      await mem.assertFact(anon, { subject: "alice", predicate: "prefers", object: "dark-mode", validFrom: t1 });

      // Force the erase step to fail by stubbing store.eraseScope to throw.
      const realErase = store.eraseScope.bind(store);
      (store as { eraseScope: (s: Scope) => Promise<{ deleted: number }> }).eraseScope = async () => {
        throw new Error("simulated crash during erase");
      };

      await expect(mem.mergeScopes(anon, user)).rejects.toThrow(/partial failure|simulated crash/);

      // COPY happened before the (failing) erase, so target has the data...
      expect((await store.queryFacts({ scope: user, subject: "alice" })).map((f) => f.object)).toEqual(["dark-mode"]);
      // ...and the source is still intact (no data lost).
      void realErase;
      expect((await store.queryFacts({ scope: anon, subject: "alice" })).map((f) => f.object)).toEqual(["dark-mode"]);
    } finally {
      await store.close();
    }
  });
});

// =====================================================================================
// Semantic-mode merge sanity (vector store re-indexed under target)
// =====================================================================================
describe("Feature 5 — mergeScopes re-indexes vectors under target (semantic mode)", () => {
  it("moves the vector entry to the target scope", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const vector = new InMemoryVectorStore();
    const embedder = new FakeEmbedder();
    const anon: Scope = { kind: "thread", agentId: "a", sessionId: "anon-1" };
    const user: Scope = { kind: "user", agentId: "a", userId: "alice" };
    const mem = new Memory({ store, graph: store, vector, embedder, consent: { categories: {} } });
    await mem.ingest([{ id: "am1", scope: anon, text: "alpha beta gamma vector content" }]);

    await mem.mergeScopes(anon, user);

    const hits = await mem.retrieve({ text: "alpha beta gamma", scope: user });
    expect(hits.snippets.some((s) => s.id === "am1")).toBe(true);
  });
});
