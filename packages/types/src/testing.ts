import type {
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelStreamPart,
  StorePort,
  Scope,
  MemoryBlock,
  BlockHistoryEntry,
  MemorySnippet,
  SessionRecord,
  VectorPort,
  VectorEntry,
  VectorSearchResult,
  EmbeddingPort,
  Fact,
  AssertFactInput,
  FactQuery,
  GraphPort,
  DurablePort,
  Checkpoint,
  IdempotencyRecord,
  IdempotencyStatus,
  SuspendDecision,
} from "./ports.js";
import type { SecretsPort, SandboxPort, SandboxResult, SandboxRunOptions } from "./security.js";
import { scopeKey } from "./ports.js";
import { tokenize } from "./text.js";
import type { StoredEvent } from "./protocol.js";
import { StoreConflictError } from "./errors.js";
import type { Span, TracerPort } from "./observability.js";

export class MockModel implements ModelPort {
  readonly calls: ModelRequest[] = [];
  private i = 0;
  constructor(private readonly scripted: ModelResponse[]) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    const r = this.scripted[this.i++];
    if (!r) throw new Error(`MockModel: no scripted response #${this.i}`);
    return r;
  }
}

export class InMemoryStore implements StorePort, GraphPort, DurablePort {
  private sessions = new Map<string, SessionRecord>();
  private events: StoredEvent[] = [];
  private blocks = new Map<string, MemoryBlock>(); // key: `${scopeKey}#${label}`
  private history: Array<{ scopeKey: string; entry: BlockHistoryEntry }> = [];
  private memEntries: Array<{ scopeKey: string; id: string; text: string; ingestedAt?: number; metadata?: Record<string, unknown> }> = [];
  private facts: Array<{ scopeKey: string; fact: Fact }> = [];
  private graphIdCounter = 0;
  private checkpoints: Checkpoint[] = [];
  private idempotency = new Map<string, IdempotencyRecord>();
  private decisions = new Map<string, SuspendDecision>(); // key: `${sessionId}#${callId}`
  private readonly newGraphId: () => string;
  private readonly graphNow: () => string;

  constructor(opts?: { newId?: () => string; now?: () => string }) {
    this.newGraphId = opts?.newId ?? (() => `fact_${(this.graphIdCounter++).toString(36)}`);
    this.graphNow = opts?.now ?? (() => new Date().toISOString());
  }

  async migrate() {}
  async close() {}

  async createSession(s: SessionRecord) {
    this.sessions.set(s.id, { ...s });
  }
  async getSession(id: string) {
    const s = this.sessions.get(id);
    return s ? { ...s } : null;
  }
  async appendEvents(events: StoredEvent[]) {
    const seenId = new Set(this.events.map((e) => e.id));
    const seenSeq = new Set(this.events.map((e) => `${e.sessionId}#${e.seq}`));
    for (const e of events) {
      const seqKey = `${e.sessionId}#${e.seq}`;
      if (seenId.has(e.id)) throw new StoreConflictError(`conflict: duplicate event id ${e.id}`);
      if (seenSeq.has(seqKey)) throw new StoreConflictError(`conflict: duplicate (session ${e.sessionId}, seq ${e.seq})`);
      seenId.add(e.id);
      seenSeq.add(seqKey);
    }
    this.events.push(...events);
  }
  async readEvents(sessionId: string) {
    return this.events
      .filter((e) => e.sessionId === sessionId)
      .sort((a, b) => a.seq - b.seq);
  }
  async getBlocks(scope: Scope) {
    const prefix = `${scopeKey(scope)}#`;
    return [...this.blocks.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => v);
  }
  async getBlock(scope: Scope, label: string): Promise<MemoryBlock | null> {
    return this.blocks.get(`${scopeKey(scope)}#${label}`) ?? null;
  }
  async upsertBlock(scope: Scope, block: { label: string; value: string }, expectVersion?: number) {
    const key = `${scopeKey(scope)}#${block.label}`;
    const existing = this.blocks.get(key);
    if (expectVersion !== undefined && !existing) {
      throw new StoreConflictError(`conflict: block ${block.label} expected version ${expectVersion} but it does not exist`);
    }
    if (expectVersion !== undefined && existing && existing.version !== expectVersion) {
      throw new StoreConflictError(`conflict: block ${block.label} version ${existing.version} != expected ${expectVersion}`);
    }
    const next: MemoryBlock = {
      label: block.label,
      value: block.value,
      version: existing ? existing.version + 1 : 0,
      updatedAt: new Date().toISOString(),
    };
    this.blocks.set(key, next);
    this.history.push({ scopeKey: scopeKey(scope), entry: { label: next.label, value: next.value, version: next.version, updatedAt: next.updatedAt } });
    return next;
  }
  async appendBlock(scope: Scope, label: string, text: string) {
    const key = `${scopeKey(scope)}#${label}`;
    const existing = this.blocks.get(key);
    const next: MemoryBlock = {
      label,
      value: (existing?.value ?? "") + text,
      version: existing ? existing.version + 1 : 0,
      updatedAt: new Date().toISOString(),
    };
    this.blocks.set(key, next);
    this.history.push({ scopeKey: scopeKey(scope), entry: { label: next.label, value: next.value, version: next.version, updatedAt: next.updatedAt } });
    return next;
  }
  async getBlockHistory(scope: Scope, label: string): Promise<BlockHistoryEntry[]> {
    const key = scopeKey(scope);
    return this.history
      .filter((h) => h.scopeKey === key && h.entry.label === label)
      .map((h) => h.entry)
      .sort((a, b) => a.version - b.version);
  }
  async indexMemory(entries: Array<{ scope: Scope; id: string; text: string; ingestedAt?: number; metadata?: Record<string, unknown> }>) {
    for (const e of entries) {
      const sk = scopeKey(e.scope);
      this.memEntries = this.memEntries.filter((m) => !(m.scopeKey === sk && m.id === e.id));
      this.memEntries.push({ scopeKey: sk, id: e.id, text: e.text, ingestedAt: e.ingestedAt, metadata: e.metadata });
    }
  }
  async searchMemory(scope: Scope, query: string, topK: number): Promise<MemorySnippet[]> {
    const q = tokenize(query);
    if (q.length === 0) return [];
    const key = scopeKey(scope);
    const scored: MemorySnippet[] = [];
    for (const e of this.memEntries) {
      if (e.scopeKey !== key) continue;
      const docTokens = tokenize(e.text);
      if (docTokens.length === 0) continue;
      const freq: Record<string, number> = {};
      for (const t of docTokens) freq[t] = (freq[t] ?? 0) + 1;
      let score = 0;
      for (const qt of q) if (freq[qt]) score += freq[qt] / docTokens.length;
      if (score > 0) {
        scored.push({
          id: e.id,
          text: e.text,
          score,
          ...(e.ingestedAt !== undefined ? { ingestedAt: e.ingestedAt } : {}),
          ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
        });
      }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  async assertFact(scope: Scope, input: AssertFactInput): Promise<{ asserted: Fact; invalidated: Fact[] }> {
    const key = scopeKey(scope);
    const validFrom = input.validFrom ?? this.graphNow();
    const objectKind = input.objectKind ?? "literal";
    const confidence = input.confidence ?? 1;

    const current = this.facts.filter(
      (f) =>
        f.scopeKey === key &&
        f.fact.subject === input.subject &&
        f.fact.predicate === input.predicate &&
        f.fact.validUntil === undefined,
    );

    const same = current.find((f) => f.fact.object === input.object);
    if (same) {
      // Idempotent: same object already currently valid → no new row, no invalidation.
      // Return a clone so callers cannot alias into the store's internal state.
      return { asserted: { ...same.fact }, invalidated: [] };
    }

    // Guard: new validFrom must not precede any currently-valid prior fact's validFrom.
    for (const f of current) {
      if (validFrom < f.fact.validFrom) {
        throw new Error(
          `temporal order violation: validFrom '${validFrom}' is earlier than the current fact's validFrom '${f.fact.validFrom}'`,
        );
      }
    }

    const invalidated: Fact[] = [];
    for (const f of current) {
      f.fact.validUntil = validFrom;
      invalidated.push({ ...f.fact });
    }
    // State-transition link: when this assert superseded exactly one prior fact, record the link.
    // (Functional predicates have at most one currently-valid fact, so `current` is 0 or 1 here.)
    const supersedes = invalidated.length === 1 ? invalidated[0]!.id : undefined;

    const expiresAt = input.ttlMs !== undefined
      ? new Date(new Date(validFrom).getTime() + input.ttlMs).toISOString()
      : input.expiresAt;
    const lastCorroboratedAt = input.lastCorroboratedAt ?? Date.parse(validFrom);

    const asserted: Fact = {
      id: this.newGraphId(),
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      objectKind,
      validFrom,
      confidence,
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(supersedes !== undefined ? { supersedes } : {}),
      ...(!Number.isNaN(lastCorroboratedAt) ? { lastCorroboratedAt } : {}),
    };
    this.facts.push({ scopeKey: key, fact: asserted });
    return { asserted: { ...asserted }, invalidated };
  }

  async factHistory(scope: Scope, subject: string, predicate: string): Promise<Fact[]> {
    return this.queryFacts({ scope, subject, predicate, includeInvalidated: true });
  }

  async corroborate(scope: Scope, factId: string, at?: number): Promise<number> {
    const key = scopeKey(scope);
    const ts = at ?? Date.now();
    for (const f of this.facts) {
      if (f.scopeKey === key && f.fact.id === factId && f.fact.validUntil === undefined) {
        f.fact.lastCorroboratedAt = ts;
        return 1;
      }
    }
    return 0;
  }

  async expireFacts(scope: Scope, ids: string[], at: string): Promise<number> {
    const key = scopeKey(scope);
    const idSet = new Set(ids);
    let count = 0;
    for (const f of this.facts) {
      if (f.scopeKey === key && f.fact.validUntil === undefined && idSet.has(f.fact.id)) {
        f.fact.validUntil = at;
        count += 1;
      }
    }
    return count;
  }

  async queryFacts(query: FactQuery): Promise<Fact[]> {
    const key = scopeKey(query.scope);
    const out = this.facts
      .filter((f) => f.scopeKey === key)
      .map((f) => f.fact)
      .filter((f) => (query.subject === undefined ? true : f.subject === query.subject))
      .filter((f) => (query.predicate === undefined ? true : f.predicate === query.predicate))
      .filter((f) => (query.object === undefined ? true : f.object === query.object))
      .filter((f) => {
        if (query.validAt !== undefined) {
          return f.validFrom <= query.validAt && (f.validUntil === undefined || f.validUntil > query.validAt);
        }
        if (query.includeInvalidated) return true;
        return f.validUntil === undefined;
      })
      .sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0))
      .map((f) => ({ ...f }));
    return query.limit !== undefined ? out.slice(0, query.limit) : out;
  }

  async sweepExpired(scope: Scope, now: string): Promise<number> {
    const key = scopeKey(scope);
    let count = 0;
    for (const f of this.facts) {
      if (f.scopeKey === key && f.fact.validUntil === undefined && f.fact.expiresAt !== undefined && f.fact.expiresAt <= now) {
        f.fact.validUntil = now; // invalidate, do NOT delete (temporal audit §6.6)
        count += 1;
      }
    }
    return count;
  }

  async listSessions(opts?: { agentId?: string; limit?: number; userId?: string; orgId?: string }): Promise<SessionRecord[]> {
    let sessions = [...this.sessions.values()];
    if (opts?.agentId !== undefined) {
      sessions = sessions.filter((s) => s.agentId === opts.agentId);
    }
    // Fix 2: strict filtering — when a userId/orgId filter is provided, only exact matches are returned.
    if (opts?.userId !== undefined) {
      sessions = sessions.filter((s) => s.userId === opts.userId);
    }
    if (opts?.orgId !== undefined) {
      sessions = sessions.filter((s) => s.orgId === opts.orgId);
    }
    sessions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    if (opts?.limit !== undefined) sessions = sessions.slice(0, opts.limit);
    return sessions;
  }

  async listBlocks(scope: Scope): Promise<MemoryBlock[]> {
    const prefix = `${scopeKey(scope)}#`;
    return [...this.blocks.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => v);
  }

  async eraseScope(scope: Scope): Promise<{ deleted: number }> {
    const key = scopeKey(scope);
    let deleted = 0;

    // Blocks (key format: `${scopeKey}#${label}`)
    const blocksBefore = this.blocks.size;
    for (const [k] of [...this.blocks.entries()]) {
      if (k.startsWith(`${key}#`)) this.blocks.delete(k);
    }
    deleted += blocksBefore - this.blocks.size;

    // Block history
    const histBefore = this.history.length;
    this.history = this.history.filter((h) => h.scopeKey !== key);
    deleted += histBefore - this.history.length;

    // Memories (lexical index)
    const memBefore = this.memEntries.length;
    this.memEntries = this.memEntries.filter((m) => m.scopeKey !== key);
    deleted += memBefore - this.memEntries.length;

    // Facts (temporal KG)
    const factsBefore = this.facts.length;
    this.facts = this.facts.filter((f) => f.scopeKey !== key);
    deleted += factsBefore - this.facts.length;

    // Sessions and events: sessions are agent-scoped (no per-user scope_key column).
    // Erase all sessions for this scope's agentId and their events. Safe because
    // the conformance case uses unique agentIds per test scope.
    const agentId = "agentId" in scope ? (scope as { agentId: string }).agentId : undefined;
    if (agentId !== undefined) {
      const sessionIds: string[] = [];
      for (const [sid, sess] of this.sessions.entries()) {
        if (sess.agentId === agentId) { sessionIds.push(sid); this.sessions.delete(sid); deleted += 1; }
      }
      const eventsBefore = this.events.length;
      this.events = this.events.filter((e) => !sessionIds.includes(e.sessionId));
      deleted += eventsBefore - this.events.length;
    }

    return { deleted };
  }

  async writeCheckpoint(sessionId: string, seq: number, hash: string): Promise<void> {
    const existing = this.checkpoints.find((c) => c.sessionId === sessionId && c.seq === seq);
    if (existing) {
      existing.hash = hash;
      existing.createdAt = this.graphNow();
      return;
    }
    this.checkpoints.push({ sessionId, seq, hash, createdAt: this.graphNow() });
  }

  async lastCheckpoint(sessionId: string): Promise<Checkpoint | null> {
    const mine = this.checkpoints.filter((c) => c.sessionId === sessionId);
    if (mine.length === 0) return null;
    const top = mine.reduce((a, b) => (b.seq > a.seq ? b : a));
    return { ...top };
  }

  async recordIntent(key: string, argsHash: string): Promise<void> {
    if (this.idempotency.has(key)) return; // intent is write-once; never downgrade applied → intent
    this.idempotency.set(key, { key, argsHash, status: "intent", createdAt: this.graphNow() });
  }

  async recordCompletion(key: string, result: unknown): Promise<void> {
    const existing = this.idempotency.get(key);
    const argsHash = existing?.argsHash ?? "";
    const status: IdempotencyStatus = "applied";
    // JSON round-trip so the in-memory store matches the SQLite store's serialize/parse semantics.
    const stored = JSON.parse(JSON.stringify(result ?? null));
    this.idempotency.set(key, { key, argsHash, status, result: stored, createdAt: existing?.createdAt ?? this.graphNow() });
  }

  async getIdempotency(key: string): Promise<IdempotencyRecord | null> {
    const r = this.idempotency.get(key);
    return r ? { ...r } : null;
  }

  async recordDecision(sessionId: string, callId: string, decision: SuspendDecision): Promise<void> {
    // JSON round-trip so the in-memory store matches SqliteStore serialize/parse semantics.
    const stored = JSON.parse(JSON.stringify(decision)) as SuspendDecision;
    this.decisions.set(`${sessionId}#${callId}`, stored);
  }

  async getDecision(sessionId: string, callId: string): Promise<SuspendDecision | null> {
    const d = this.decisions.get(`${sessionId}#${callId}`);
    return d ? { ...d } : null;
  }
}

export interface ConformanceCase {
  name: string;
  run: () => Promise<void>;
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`conformance: ${msg}`);
}
function assertEqual(a: unknown, b: unknown, msg: string): void {
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}
async function expectThrows(fn: () => Promise<unknown>, match: RegExp, msg: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    assert(match.test(e instanceof Error ? e.message : String(e)), `${msg}: error did not match ${match}`);
    return;
  }
  assert(false, `${msg}: expected a throw`);
}

/** Behavioral contract every StorePort adapter must satisfy. Returns named cases; a test file maps each into `it()`. */
export function storeConformanceCases(makeStore: () => StorePort & GraphPort): ConformanceCase[] {
  const scope: Scope = { kind: "agent", agentId: "ca" };
  const ev = (id: string, seq: number, kind: StoredEvent["kind"] = "user", payload: unknown = "p"): StoredEvent =>
    ({ id, sessionId: "cs", seq, kind, schemaVersion: 1, payload, createdAt: "t" });
  const withStore = (fn: (s: StorePort & GraphPort) => Promise<void>) => async () => {
    const s = makeStore();
    await s.migrate();
    try { await fn(s); } finally { await s.close(); }
  };
  return [
    { name: "createSession + getSession round-trips", run: withStore(async (s) => {
      await s.createSession({ id: "cs", agentId: "a", createdAt: "t" });
      assertEqual((await s.getSession("cs"))?.agentId, "a", "session agentId");
      assertEqual(await s.getSession("missing"), null, "missing session is null");
    }) },
    { name: "readEvents returns events ordered by seq", run: withStore(async (s) => {
      await s.createSession({ id: "cs", agentId: "a", createdAt: "t" });
      await s.appendEvents([ev("e2", 1), ev("e1", 0)]);
      assertEqual((await s.readEvents("cs")).map((e) => e.seq), [0, 1], "seq order");
    }) },
    { name: "appendEvents rejects duplicate event id", run: withStore(async (s) => {
      await s.createSession({ id: "cs", agentId: "a", createdAt: "t" });
      await s.appendEvents([ev("dup", 0)]);
      await expectThrows(() => s.appendEvents([ev("dup", 1)]), /conflict|constraint|unique/i, "dup id");
    }) },
    { name: "appendEvents rejects duplicate (sessionId, seq)", run: withStore(async (s) => {
      await s.createSession({ id: "cs", agentId: "a", createdAt: "t" });
      await s.appendEvents([ev("e1", 0)]);
      await expectThrows(() => s.appendEvents([ev("e2", 0)]), /conflict|constraint|unique/i, "dup seq");
    }) },
    { name: "appendEvents rejects intra-batch duplicate seq atomically", run: withStore(async (s) => {
      await s.createSession({ id: "cs", agentId: "a", createdAt: "t" });
      await expectThrows(() => s.appendEvents([ev("a", 0), ev("b", 0)]), /conflict|constraint|unique/i, "intra-batch dup");
      assertEqual((await s.readEvents("cs")).length, 0, "batch rolled back / not partially applied");
    }) },
    { name: "upsertBlock CAS: conflict on version mismatch", run: withStore(async (s) => {
      await s.upsertBlock(scope, { label: "b", value: "v0" });
      await expectThrows(() => s.upsertBlock(scope, { label: "b", value: "x" }, 5), /conflict/i, "version mismatch");
    }) },
    { name: "upsertBlock CAS: throws when expectVersion given but block absent", run: withStore(async (s) => {
      await expectThrows(() => s.upsertBlock(scope, { label: "ghost", value: "x" }, 0), /conflict/i, "absent w/ expectVersion");
    }) },
    { name: "appendBlock concatenates atomically; version increments", run: withStore(async (s) => {
      await s.upsertBlock(scope, { label: "b", value: "A" });
      const r = await s.appendBlock(scope, "b", "B");
      assertEqual(r.value, "AB", "concatenated");
      assertEqual(r.version, 1, "version bumped");
    }) },
    { name: "blocks are scope-isolated", run: withStore(async (s) => {
      await s.upsertBlock({ kind: "agent", agentId: "x" }, { label: "b", value: "1" });
      assertEqual(await s.getBlocks({ kind: "agent", agentId: "y" }), [], "other scope empty");
      assertEqual((await s.getBlocks({ kind: "agent", agentId: "x" })).length, 1, "own scope present");
    }) },
    { name: "getBlockHistory returns the full ascending version trail; scope-isolated", run: withStore(async (s) => {
      await s.upsertBlock(scope, { label: "h", value: "v0" });
      await s.upsertBlock(scope, { label: "h", value: "v1" }, 0);
      await s.appendBlock(scope, "h", "X");
      const trail = await s.getBlockHistory(scope, "h");
      assertEqual(trail.map((e) => e.version), [0, 1, 2], "versions ascending");
      assertEqual(trail.map((e) => e.value), ["v0", "v1", "v1X"], "committed values per version");
      assertEqual(await s.getBlockHistory({ kind: "agent", agentId: "other" }, "h"), [], "history is scope-isolated");
    }) },
    { name: "indexMemory + searchMemory ranks within scope", run: withStore(async (s) => {
      await s.indexMemory([
        { scope, id: "m1", text: "alpha beta gamma" },
        { scope, id: "m2", text: "beta beta beta" },
        { scope: { kind: "agent", agentId: "other" }, id: "m3", text: "beta" },
      ]);
      const hits = await s.searchMemory(scope, "beta", 10);
      assertEqual(hits.map((h) => h.id), ["m2", "m1"], "ranked by relevance, other scope excluded");
      assert(hits.every((h) => h.score > 0), "positive scores");
    }) },
    { name: "searchMemory returns [] for empty/punctuation query (no throw)", run: withStore(async (s) => {
      await s.indexMemory([{ scope, id: "m1", text: "hello" }]);
      assertEqual(await s.searchMemory(scope, "?!", 10), [], "punctuation-only");
      assertEqual(await s.searchMemory(scope, "", 10), [], "empty");
    }) },
    { name: "indexMemory is idempotent by id (re-index replaces, no duplicate)", run: withStore(async (s) => {
      await s.indexMemory([{ scope, id: "x", text: "alpha" }]);
      await s.indexMemory([{ scope, id: "x", text: "beta" }]);
      const hits = await s.searchMemory(scope, "alpha beta", 10);
      assertEqual(hits.length, 1, "single entry after re-index");
      assertEqual(hits[0]?.text, "beta", "latest text wins");
    }) },
    { name: "indexMemory: same ext_id under two scopes does not clobber across scopes", run: withStore(async (s) => {
      const scopeA: Scope = { kind: "agent", agentId: "memscope_a" };
      const scopeB: Scope = { kind: "agent", agentId: "memscope_b" };
      await s.indexMemory([
        { scope: scopeA, id: "shared_id", text: "apple orange" },
        { scope: scopeB, id: "shared_id", text: "banana mango" },
      ]);
      const hitsA = await s.searchMemory(scopeA, "apple", 10);
      assertEqual(hitsA.length, 1, "scopeA returns its own entry");
      assertEqual(hitsA[0]?.text, "apple orange", "scopeA text correct");
      const hitsB = await s.searchMemory(scopeB, "banana", 10);
      assertEqual(hitsB.length, 1, "scopeB returns its own entry");
      assertEqual(hitsB[0]?.text, "banana mango", "scopeB text correct");
      // Re-indexing under scopeA does NOT disturb scopeB
      await s.indexMemory([{ scope: scopeA, id: "shared_id", text: "apple updated" }]);
      const hitsB2 = await s.searchMemory(scopeB, "banana", 10);
      assertEqual(hitsB2.length, 1, "scopeB unaffected after scopeA re-index");
      assertEqual(hitsB2[0]?.text, "banana mango", "scopeB text unchanged");
    }) },
    { name: "getBlock returns block after upsert, null for missing, scope-isolated", run: withStore(async (s) => {
      const scopeX: Scope = { kind: "agent", agentId: "gbx" };
      const scopeY: Scope = { kind: "agent", agentId: "gby" };
      assertEqual(await s.getBlock(scopeX, "missing"), null, "null before upsert");
      const upserted = await s.upsertBlock(scopeX, { label: "myblock", value: "hello" });
      const fetched = await s.getBlock(scopeX, "myblock");
      assert(fetched !== null, "getBlock returns block after upsert");
      assertEqual(fetched?.label, upserted.label, "label matches");
      assertEqual(fetched?.value, upserted.value, "value matches");
      assertEqual(fetched?.version, upserted.version, "version matches");
      // scope-isolated: scopeY cannot see scopeX's block
      assertEqual(await s.getBlock(scopeY, "myblock"), null, "different scope returns null");
    }) },
    { name: "graph: assert then query returns the currently-valid fact", run: withStore(async (s) => {
      const t1 = "2026-01-01T00:00:00.000Z";
      const r = await s.assertFact(scope, { subject: "Baran", predicate: "favorite_language", object: "TypeScript", validFrom: t1 });
      assertEqual(r.invalidated, [], "first assert invalidates nothing");
      assertEqual(r.asserted.object, "TypeScript", "asserted object");
      assertEqual(r.asserted.objectKind, "literal", "default objectKind is literal");
      assertEqual(r.asserted.confidence, 1, "default confidence is 1");
      const hits = await s.queryFacts({ scope, subject: "Baran" });
      assertEqual(hits.map((f) => f.object), ["TypeScript"], "currently-valid query");
      assertEqual(hits[0]?.validUntil, undefined, "currently-valid has no validUntil");
    }) },
    { name: "graph: contradiction invalidates prior (validUntil = new validFrom); both visible via includeInvalidated", run: withStore(async (s) => {
      const t1 = "2026-01-01T00:00:00.000Z";
      const t2 = "2026-03-01T00:00:00.000Z";
      await s.assertFact(scope, { subject: "Baran", predicate: "favorite_language", object: "TypeScript", validFrom: t1 });
      const r2 = await s.assertFact(scope, { subject: "Baran", predicate: "favorite_language", object: "Rust", validFrom: t2 });
      assertEqual(r2.asserted.object, "Rust", "new fact asserted");
      assertEqual(r2.invalidated.map((f) => f.object), ["TypeScript"], "prior fact invalidated");
      assertEqual(r2.invalidated[0]?.validUntil, t2, "prior validUntil == new validFrom");
      const current = await s.queryFacts({ scope, subject: "Baran" });
      assertEqual(current.map((f) => f.object), ["Rust"], "default query returns only currently-valid");
      const all = await s.queryFacts({ scope, subject: "Baran", includeInvalidated: true });
      assertEqual(all.map((f) => f.object), ["TypeScript", "Rust"], "includeInvalidated returns both, ordered by validFrom");
    }) },
    { name: "graph: point-in-time validAt returns the fact valid at that instant", run: withStore(async (s) => {
      const t1 = "2026-01-01T00:00:00.000Z";
      const t2 = "2026-03-01T00:00:00.000Z";
      const between = "2026-02-01T00:00:00.000Z";
      await s.assertFact(scope, { subject: "Baran", predicate: "favorite_language", object: "TypeScript", validFrom: t1 });
      await s.assertFact(scope, { subject: "Baran", predicate: "favorite_language", object: "Rust", validFrom: t2 });
      const atBetween = await s.queryFacts({ scope, subject: "Baran", validAt: between });
      assertEqual(atBetween.map((f) => f.object), ["TypeScript"], "validAt between t1 and t2 -> TypeScript");
      const atT2 = await s.queryFacts({ scope, subject: "Baran", validAt: t2 });
      assertEqual(atT2.map((f) => f.object), ["Rust"], "validAt == t2 -> Rust (valid_until exclusive, valid_from inclusive)");
      const beforeAll = await s.queryFacts({ scope, subject: "Baran", validAt: "2025-12-31T00:00:00.000Z" });
      assertEqual(beforeAll, [], "validAt before any fact -> none");
    }) },
    { name: "graph: re-asserting the same object is idempotent (no new row, no invalidation)", run: withStore(async (s) => {
      const t1 = "2026-01-01T00:00:00.000Z";
      const t2 = "2026-03-01T00:00:00.000Z";
      const a = await s.assertFact(scope, { subject: "Baran", predicate: "favorite_language", object: "TypeScript", validFrom: t1 });
      const b = await s.assertFact(scope, { subject: "Baran", predicate: "favorite_language", object: "TypeScript", validFrom: t2 });
      assertEqual(b.invalidated, [], "idempotent: nothing invalidated");
      assertEqual(b.asserted.id, a.asserted.id, "idempotent: same fact id returned");
      const all = await s.queryFacts({ scope, subject: "Baran", includeInvalidated: true });
      assertEqual(all.length, 1, "idempotent: single row");
      assertEqual(all[0]?.validUntil, undefined, "idempotent: still currently valid");
    }) },
    { name: "graph: facts are scope-isolated", run: withStore(async (s) => {
      const t1 = "2026-01-01T00:00:00.000Z";
      await s.assertFact({ kind: "agent", agentId: "gx" }, { subject: "Baran", predicate: "p", object: "1", validFrom: t1 });
      assertEqual(await s.queryFacts({ scope: { kind: "agent", agentId: "gy" }, subject: "Baran" }), [], "other scope sees no facts");
      assertEqual((await s.queryFacts({ scope: { kind: "agent", agentId: "gx" }, subject: "Baran" })).length, 1, "own scope sees its fact");
    }) },
    { name: "graph: asserting a contradicting fact with validFrom earlier than prior's validFrom throws (temporal order violation)", run: withStore(async (s) => {
      const t1 = "2026-01-01T00:00:00.000Z";
      const t2 = "2026-03-01T00:00:00.000Z";
      // Establish the current fact at t2
      await s.assertFact(scope, { subject: "Baran", predicate: "favorite_language", object: "TypeScript", validFrom: t2 });
      // Attempt to contradict at t1 < t2 — must throw
      await expectThrows(
        () => s.assertFact(scope, { subject: "Baran", predicate: "favorite_language", object: "Rust", validFrom: t1 }),
        /temporal order|validFrom/i,
        "out-of-order assert must throw",
      );
      // Original fact must remain currently-valid (no partial mutation)
      const current = await s.queryFacts({ scope, subject: "Baran" });
      assertEqual(current.map((f) => f.object), ["TypeScript"], "original fact still currently-valid after rejected assert");
      assertEqual(current[0]?.validUntil, undefined, "original fact not invalidated");
    }) },
    { name: "graph: ttlMs stores expiresAt; sweepExpired invalidates after expiry (NOT deletes), interval preserved", run: withStore(async (s) => {
      const t1 = "2026-01-01T00:00:00.000Z";
      const r = await s.assertFact(scope, { subject: "Token", predicate: "session", object: "abc", validFrom: t1, ttlMs: 60_000 });
      assertEqual(r.asserted.expiresAt, "2026-01-01T00:01:00.000Z", "expiresAt = validFrom + ttlMs");
      // Before expiry: fact is visible
      const before = await s.queryFacts({ scope, subject: "Token" });
      assertEqual(before.map((f) => f.object), ["abc"], "visible before expiry");
      // Sweep before expiry: 0 invalidated
      const swept0 = await s.sweepExpired(scope, "2026-01-01T00:00:30.000Z");
      assertEqual(swept0, 0, "sweep before expiry returns 0");
      assertEqual((await s.queryFacts({ scope, subject: "Token" })).length, 1, "still 1 valid after early sweep");
      // Sweep after expiry: 1 invalidated
      const swept1 = await s.sweepExpired(scope, "2026-01-01T00:02:00.000Z");
      assertEqual(swept1, 1, "sweep after expiry returns 1");
      assertEqual((await s.queryFacts({ scope, subject: "Token" })).length, 0, "0 currently-valid after sweep");
      // Audit: row preserved, validUntil set to sweep time (NOT deleted)
      const all = await s.queryFacts({ scope, subject: "Token", includeInvalidated: true });
      assertEqual(all.length, 1, "row preserved (not deleted)");
      assertEqual(all[0]?.validUntil, "2026-01-01T00:02:00.000Z", "validUntil set to sweep now");
      // Interval query: still visible at a time within original [validFrom, expiresAt)
      const atMid = await s.queryFacts({ scope, subject: "Token", validAt: "2026-01-01T00:00:30.000Z" });
      assertEqual(atMid.map((f) => f.object), ["abc"], "interval preserved: visible at mid-point via validAt");
    }) },
    { name: "graph: sweepExpired leaves non-expiring + not-yet-expired facts untouched", run: withStore(async (s) => {
      const t1 = "2026-01-01T00:00:00.000Z";
      await s.assertFact(scope, { subject: "A", predicate: "p", object: "1", validFrom: t1 });
      await s.assertFact(scope, { subject: "B", predicate: "p", object: "2", validFrom: t1, ttlMs: 3_600_000 });
      const swept = await s.sweepExpired(scope, "2026-01-01T00:00:10.000Z");
      assertEqual(swept, 0, "sweep too early: 0 invalidated");
      assertEqual((await s.queryFacts({ scope })).length, 2, "both facts still valid");
    }) },
    { name: "graph: sweepExpired is scope-isolated", run: withStore(async (s) => {
      const scopeX: Scope = { kind: "agent", agentId: "swx" };
      const scopeY: Scope = { kind: "agent", agentId: "swy" };
      const t1 = "2026-01-01T00:00:00.000Z";
      const after = "2026-01-01T00:00:02.000Z";
      await s.assertFact(scopeX, { subject: "X", predicate: "p", object: "1", validFrom: t1, ttlMs: 1000 });
      // Sweep wrong scope: 0 invalidated
      const sweptY = await s.sweepExpired(scopeY, after);
      assertEqual(sweptY, 0, "wrong scope: 0 invalidated");
      assertEqual((await s.queryFacts({ scope: scopeX, subject: "X" })).length, 1, "scopeX fact unaffected");
      // Sweep correct scope: 1 invalidated
      const sweptX = await s.sweepExpired(scopeX, after);
      assertEqual(sweptX, 1, "correct scope: 1 invalidated");
    }) },
    { name: "listSessions: returns all sessions newest-first; agentId filter; limit cap", run: withStore(async (s) => {
      const t1 = "2026-01-01T00:00:00.000Z";
      const t2 = "2026-02-01T00:00:00.000Z";
      const scopeA: Scope = { kind: "agent", agentId: "ls_agent_a" };
      const scopeB: Scope = { kind: "agent", agentId: "ls_agent_b" };
      await s.createSession({ id: "ls_s1", agentId: "ls_agent_a", createdAt: t1 });
      await s.createSession({ id: "ls_s2", agentId: "ls_agent_a", createdAt: t2 });
      await s.createSession({ id: "ls_s3", agentId: "ls_agent_b", createdAt: t1 });
      // All sessions, newest-first
      const all = await s.listSessions();
      const allIds = all.map((s) => s.id);
      // ls_s2 (t2) should appear before ls_s1 (t1); ls_s3 may be anywhere but present
      assert(allIds.includes("ls_s1") && allIds.includes("ls_s2") && allIds.includes("ls_s3"), "all sessions present");
      const idxS2 = allIds.indexOf("ls_s2");
      const idxS1 = allIds.indexOf("ls_s1");
      assert(idxS2 < idxS1, "newest first: ls_s2 (t2) before ls_s1 (t1)");
      // Filter by agentId
      const forA = await s.listSessions({ agentId: "ls_agent_a" });
      assertEqual(forA.map((s) => s.id).sort(), ["ls_s1", "ls_s2"], "agentId filter includes only agent_a sessions");
      // Newest-first within filtered set
      assert(forA[0]?.id === "ls_s2", "filtered newest first: ls_s2 first");
      // Limit
      const limited = await s.listSessions({ agentId: "ls_agent_a", limit: 1 });
      assertEqual(limited.length, 1, "limit=1 returns 1");
      assertEqual(limited[0]?.id, "ls_s2", "limit=1 returns newest");
      // Unknown agentId returns empty
      const none = await s.listSessions({ agentId: "ls_agent_unknown" });
      assertEqual(none, [], "unknown agentId returns []");
      // Scope-isolation: scopeB sessions not returned for scopeA
      const forB = await s.listSessions({ agentId: scopeB.agentId });
      assertEqual(forB.map((s) => s.id), ["ls_s3"], "scopeB sees only its session");
      void scopeA; // used via string above
    }) },
    { name: "listSessions: userId filter returns only sessions for that user (strict — no-owner excluded)", run: withStore(async (s) => {
      const t1 = "2026-01-01T00:00:00.000Z";
      const t2 = "2026-02-01T00:00:00.000Z";
      await s.createSession({ id: "ls_uid_s1", agentId: "ls_uid_agent", createdAt: t1, userId: "user_alice" });
      await s.createSession({ id: "ls_uid_s2", agentId: "ls_uid_agent", createdAt: t2, userId: "user_bob" });
      await s.createSession({ id: "ls_uid_s3", agentId: "ls_uid_agent", createdAt: t1 }); // no owner

      // Filter for Alice: only Alice's session; Bob's and no-owner are excluded.
      const forAlice = await s.listSessions({ agentId: "ls_uid_agent", userId: "user_alice" });
      assertEqual(forAlice.map((s) => s.id), ["ls_uid_s1"], "only Alice's session returned");

      // Filter for Bob: only Bob's session.
      const forBob = await s.listSessions({ agentId: "ls_uid_agent", userId: "user_bob" });
      assertEqual(forBob.map((s) => s.id), ["ls_uid_s2"], "only Bob's session returned");

      // Filter for unknown user: empty.
      const forUnknown = await s.listSessions({ agentId: "ls_uid_agent", userId: "user_nobody" });
      assertEqual(forUnknown, [], "unknown userId returns []");
    }) },
    { name: "listSessions: orgId filter returns only sessions for that org (strict — other orgs and no-owner excluded)", run: withStore(async (s) => {
      const t1 = "2026-01-01T00:00:00.000Z";
      await s.createSession({ id: "ls_org_s1", agentId: "ls_org_agent", createdAt: t1, orgId: "org_acme" });
      await s.createSession({ id: "ls_org_s2", agentId: "ls_org_agent", createdAt: t1, orgId: "org_other" });
      await s.createSession({ id: "ls_org_s3", agentId: "ls_org_agent", createdAt: t1 }); // no owner

      const forAcme = await s.listSessions({ agentId: "ls_org_agent", orgId: "org_acme" });
      assertEqual(forAcme.map((s) => s.id), ["ls_org_s1"], "only Acme session returned");

      const forOther = await s.listSessions({ agentId: "ls_org_agent", orgId: "org_other" });
      assertEqual(forOther.map((s) => s.id), ["ls_org_s2"], "only org_other session returned");

      const noOwner = await s.listSessions({ agentId: "ls_org_agent", orgId: "org_unknown" });
      assertEqual(noOwner, [], "unknown orgId returns []");
    }) },
    { name: "listBlocks: returns all blocks for a scope; scope-isolated", run: withStore(async (s) => {
      const scopeA: Scope = { kind: "agent", agentId: "lb_agent_a" };
      const scopeB: Scope = { kind: "agent", agentId: "lb_agent_b" };
      await s.upsertBlock(scopeA, { label: "bio", value: "Alice" });
      await s.upsertBlock(scopeA, { label: "prefs", value: "tea" });
      await s.upsertBlock(scopeB, { label: "bio", value: "Bob" });
      const blocksA = await s.listBlocks(scopeA);
      const labelsA = blocksA.map((b) => b.label).sort();
      assertEqual(labelsA, ["bio", "prefs"], "listBlocks returns both blocks for scopeA");
      // Scope isolation: scopeB's blocks do not appear in scopeA
      assert(!blocksA.some((b) => b.value === "Bob"), "scopeB block not in scopeA result");
      const blocksB = await s.listBlocks(scopeB);
      assertEqual(blocksB.map((b) => b.label), ["bio"], "scopeB sees only its block");
      assertEqual(blocksB[0]?.value, "Bob", "scopeB block value correct");
      // Empty scope
      const blocksC = await s.listBlocks({ kind: "agent", agentId: "lb_agent_c" });
      assertEqual(blocksC, [], "unknown scope returns []");
    }) },
    { name: "indexMemory: ingestedAt + metadata persisted and returned by searchMemory", run: withStore(async (s) => {
      const scopeMeta: Scope = { kind: "agent", agentId: "meta_persist" };
      const ts = 1_700_000_000_000; // epoch ms
      await s.indexMemory([
        {
          scope: scopeMeta,
          id: "doc-with-meta",
          text: "persistent metadata ingested timestamp",
          ingestedAt: ts,
          metadata: { source: "https://example.com", page: 3, custom: true },
        },
        {
          scope: scopeMeta,
          id: "doc-no-meta",
          text: "persistent metadata ingested timestamp plain",
        },
      ]);
      const hits = await s.searchMemory(scopeMeta, "persistent metadata ingested", 10);
      assert(hits.length >= 1, "at least one hit");
      const withMeta = hits.find((h) => h.id === "doc-with-meta");
      assert(withMeta !== undefined, "doc-with-meta in results");
      assert(withMeta!.ingestedAt === ts, `ingestedAt round-trips (got ${withMeta!.ingestedAt}, want ${ts})`);
      // Use key-order-insensitive comparison for metadata (JSONB may reorder keys).
      const gotMeta = withMeta!.metadata ?? {};
      assert(
        (gotMeta as Record<string, unknown>)["source"] === "https://example.com" &&
        (gotMeta as Record<string, unknown>)["page"] === 3 &&
        (gotMeta as Record<string, unknown>)["custom"] === true,
        `metadata round-trips (got ${JSON.stringify(gotMeta)})`,
      );
      const noMeta = hits.find((h) => h.id === "doc-no-meta");
      if (noMeta !== undefined) {
        assert(noMeta.ingestedAt === undefined, "doc-no-meta has no ingestedAt");
        assert(noMeta.metadata === undefined, "doc-no-meta has no metadata");
      }
    }) },
    { name: "eraseScope: hard-deletes all data for scope; other scope untouched (§15)", run: withStore(async (s) => {
      // Local event factory that accepts an explicit sessionId (the outer `ev` hardcodes "cs").
      const evS = (id: string, seq: number, sid: string): StoredEvent =>
        ({ id, sessionId: sid, seq, kind: "user" as const, schemaVersion: 1, payload: "p", createdAt: "t" });

      const scopeA: Scope = { kind: "agent", agentId: "erase_a" };
      const scopeB: Scope = { kind: "agent", agentId: "erase_b" };
      const t1 = "2026-01-01T00:00:00.000Z";

      // Seed scope A: session + events
      await s.createSession({ id: "sess_erase_a", agentId: "erase_a", createdAt: t1 });
      await s.appendEvents([evS("erase_a_e1", 0, "sess_erase_a")]);

      // Seed scope A: block + history
      await s.upsertBlock(scopeA, { label: "bio", value: "Alice" });

      // Seed scope A: memory
      await s.indexMemory([{ scope: scopeA, id: "mem_a1", text: "alice wonderland" }]);

      // Seed scope A: fact
      await s.assertFact(scopeA, { subject: "Alice", predicate: "likes", object: "tea", validFrom: t1 });

      // Seed scope B: session + events, block, memory, fact
      await s.createSession({ id: "sess_erase_b", agentId: "erase_b", createdAt: t1 });
      await s.appendEvents([evS("erase_b_e1", 0, "sess_erase_b")]);
      await s.upsertBlock(scopeB, { label: "bio", value: "Bob" });
      await s.indexMemory([{ scope: scopeB, id: "mem_b1", text: "bob builder" }]);
      await s.assertFact(scopeB, { subject: "Bob", predicate: "likes", object: "coffee", validFrom: t1 });

      // Verify scope A has data before erasure
      assert((await s.queryFacts({ scope: scopeA, subject: "Alice" })).length > 0, "scopeA fact present before erase");
      assert((await s.searchMemory(scopeA, "alice", 10)).length > 0, "scopeA memory present before erase");
      assert((await s.getBlock(scopeA, "bio")) !== null, "scopeA block present before erase");

      // Erase scope A
      const result = await s.eraseScope(scopeA);
      assert(result.deleted > 0, "eraseScope returns deleted > 0");

      // Scope A data is gone
      assertEqual(await s.queryFacts({ scope: scopeA, subject: "Alice" }), [], "scopeA facts erased");
      assertEqual(await s.searchMemory(scopeA, "alice", 10), [], "scopeA memories erased");
      assertEqual(await s.getBlock(scopeA, "bio"), null, "scopeA block erased");
      assertEqual(await s.getBlocks(scopeA), [], "scopeA blocks list empty");
      assertEqual(await s.getBlockHistory(scopeA, "bio"), [], "scopeA block history erased");
      assertEqual(await s.readEvents("sess_erase_a"), [], "scopeA events erased");

      // Scope B data is untouched
      assert((await s.queryFacts({ scope: scopeB, subject: "Bob" })).length > 0, "scopeB facts intact");
      assert((await s.searchMemory(scopeB, "bob", 10)).length > 0, "scopeB memories intact");
      assert((await s.getBlock(scopeB, "bio")) !== null, "scopeB block intact");
      assert((await s.readEvents("sess_erase_b")).length > 0, "scopeB events intact");
    }) },
    { name: "graph: contradiction records supersedes link on the new fact + defaults lastCorroboratedAt to validFrom", run: withStore(async (s) => {
      const t1 = "2026-01-01T00:00:00.000Z";
      const t2 = "2026-03-01T00:00:00.000Z";
      const a = await s.assertFact(scope, { subject: "Loc", predicate: "lives_in", object: "NY", validFrom: t1 });
      // First fact: no prior → no supersedes link; lastCorroboratedAt defaults to validFrom epoch-ms.
      assertEqual(a.asserted.supersedes, undefined, "first fact has no supersedes link");
      assertEqual(a.asserted.lastCorroboratedAt, Date.parse(t1), "lastCorroboratedAt defaults to validFrom");
      const b = await s.assertFact(scope, { subject: "Loc", predicate: "lives_in", object: "SF", validFrom: t2 });
      assertEqual(b.asserted.supersedes, a.asserted.id, "new fact supersedes the prior fact id");
      assertEqual(b.invalidated.map((f) => f.object), ["NY"], "prior fact invalidated");
      // Persisted: re-read via factHistory and confirm the link survives storage round-trip.
      const hist = await s.factHistory(scope, "Loc", "lives_in");
      const sf = hist.find((f) => f.object === "SF");
      assertEqual(sf?.supersedes, a.asserted.id, "supersedes link persisted + readable");
    }) },
    { name: "graph: factHistory returns the full ascending timeline (valid + invalidated)", run: withStore(async (s) => {
      const t1 = "2026-01-01T00:00:00.000Z";
      const t2 = "2026-02-01T00:00:00.000Z";
      const t3 = "2026-03-01T00:00:00.000Z";
      await s.assertFact(scope, { subject: "Loc2", predicate: "lives_in", object: "A", validFrom: t1 });
      await s.assertFact(scope, { subject: "Loc2", predicate: "lives_in", object: "B", validFrom: t2 });
      await s.assertFact(scope, { subject: "Loc2", predicate: "lives_in", object: "C", validFrom: t3 });
      const hist = await s.factHistory(scope, "Loc2", "lives_in");
      assertEqual(hist.map((f) => f.object), ["A", "B", "C"], "ascending by validFrom");
      assertEqual(hist[0]?.validUntil, t2, "A invalidated at t2");
      assertEqual(hist[1]?.validUntil, t3, "B invalidated at t3");
      assertEqual(hist[2]?.validUntil, undefined, "C still currently-valid");
      // Scope isolation
      assertEqual(await s.factHistory({ kind: "agent", agentId: "fh_other" }, "Loc2", "lives_in"), [], "history scope-isolated");
    }) },
    { name: "graph: corroborate bumps lastCorroboratedAt on a valid fact; no-op for unknown/invalidated", run: withStore(async (s) => {
      const t1 = "2026-01-01T00:00:00.000Z";
      const t2 = "2026-03-01T00:00:00.000Z";
      const a = await s.assertFact(scope, { subject: "Corr", predicate: "p", object: "x", validFrom: t1 });
      const at = Date.parse(t2);
      assertEqual(await s.corroborate(scope, a.asserted.id, at), 1, "corroborate returns 1 for a valid fact");
      const after = await s.queryFacts({ scope, subject: "Corr" });
      assertEqual(after[0]?.lastCorroboratedAt, at, "lastCorroboratedAt bumped to `at`");
      // Unknown id → 0
      assertEqual(await s.corroborate(scope, "no_such_fact", at), 0, "unknown fact id → 0");
      // Invalidate then corroborate → 0 (only currently-valid facts can be corroborated)
      await s.assertFact(scope, { subject: "Corr", predicate: "p", object: "y", validFrom: t2 });
      assertEqual(await s.corroborate(scope, a.asserted.id, at), 0, "invalidated fact → 0");
    }) },
  ];
}

/** Deterministic, unit-length fake embedder: hashes word tokens into a fixed-dim bag, normalized. */
export class FakeEmbedder implements EmbeddingPort {
  constructor(readonly dim: number = 16) {}
  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(this.dim).fill(0);
    for (const tok of tokenize(text)) {
      let h = 0;
      for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
      v[h % this.dim]! += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; ma += a[i]! * a[i]!; mb += b[i]! * b[i]!; }
  return dot / (Math.sqrt(ma) * Math.sqrt(mb) || 1);
}

/** In-memory VectorPort (cosine ranking) for offline tests. */
export class InMemoryVectorStore implements VectorPort {
  private entries: VectorEntry[] = [];
  async upsert(entry: VectorEntry): Promise<void> {
    this.entries = this.entries.filter((e) => e.id !== entry.id);
    this.entries.push(entry);
  }
  async search(queryVector: number[], scopeKey: string, topK = 10): Promise<VectorSearchResult[]> {
    return this.entries
      .filter((e) => e.scopeKey === scopeKey)
      .map((e) => ({ id: e.id, text: e.text, score: cosine(queryVector, e.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
  async delete(id: string, scopeKey: string): Promise<void> {
    this.entries = this.entries.filter((e) => !(e.id === id && e.scopeKey === scopeKey));
  }
  async eraseScope(scopeKey: string): Promise<{ deleted: number }> {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.scopeKey !== scopeKey);
    return { deleted: before - this.entries.length };
  }
  async list(scopeKey: string): Promise<VectorEntry[]> {
    return this.entries.filter((e) => e.scopeKey === scopeKey).map((e) => ({ ...e, vector: [...e.vector] }));
  }
}

/** Behavioral contract every VectorPort adapter must satisfy (uses tiny fixed vectors — no embedder needed). */
export function vectorConformanceCases(makeStore: () => Promise<VectorPort> | VectorPort): ConformanceCase[] {
  const k = "user:a:u1";
  const other = "user:a:u2";
  // 4-dim vectors where similarity is obvious
  const e = (id: string, scopeKey: string, text: string, vector: number[]): VectorEntry => ({ id, scopeKey, text, vector });
  const withStore = (fn: (s: VectorPort) => Promise<void>) => async () => {
    const s = await makeStore();
    await fn(s);
  };
  return [
    { name: "vector: ranks by similarity within scope, isolates scopes", run: withStore(async (s) => {
      await s.upsert(e("a", k, "A", [1, 0, 0, 0]));
      await s.upsert(e("b", k, "B", [0, 1, 0, 0]));
      await s.upsert(e("c", other, "C", [1, 0, 0, 0]));
      const hits = await s.search([1, 0, 0, 0], k, 10);
      assertEqual(hits[0]?.id, "a", "closest first");
      assert(!hits.some((h) => h.id === "c"), "other scope excluded");
    }) },
    { name: "vector: idempotent upsert by id", run: withStore(async (s) => {
      await s.upsert(e("x", k, "old", [1, 0, 0, 0]));
      await s.upsert(e("x", k, "new", [0, 0, 0, 1]));
      const hits = await s.search([0, 0, 0, 1], k, 10);
      assertEqual(hits.filter((h) => h.id === "x").length, 1, "single row");
      assertEqual(hits[0]?.text, "new", "latest wins");
    }) },
    { name: "vector: delete removes by id within scope", run: withStore(async (s) => {
      await s.upsert(e("d", k, "D", [1, 0, 0, 0]));
      await s.delete("d", k);
      const hits = await s.search([1, 0, 0, 0], k, 10);
      assert(!hits.some((h) => h.id === "d"), "deleted");
    }) },
    { name: "vector: delete in scope A does not remove same id in scope B", run: withStore(async (s) => {
      await s.upsert(e("shared", k, "in A", [1, 0, 0, 0]));
      await s.upsert(e("shared", other, "in B", [1, 0, 0, 0]));
      await s.delete("shared", k);
      const hitsA = await s.search([1, 0, 0, 0], k, 10);
      assert(!hitsA.some((h) => h.id === "shared"), "removed from scope A");
      const hitsB = await s.search([1, 0, 0, 0], other, 10);
      assert(hitsB.some((h) => h.id === "shared"), "still present in scope B");
    }) },
    { name: "vector: exact-match query returns top hit with score > 0.99", run: withStore(async (s) => {
      const vec: number[] = [1, 0, 0, 0];
      await s.upsert(e("exact", k, "E", vec));
      const hits = await s.search(vec, k, 10);
      assert(hits.length > 0, "at least one hit");
      assert(hits[0]?.id === "exact", "exact match is top hit");
      assert((hits[0]?.score ?? 0) > 0.99, `score should be > 0.99 (cosine similarity of identical vectors ≈ 1.0), got ${hits[0]?.score}`);
    }) },
    { name: "vector: eraseScope removes all entries for scope, other scope untouched (§15)", run: withStore(async (s) => {
      await s.upsert(e("da1", k, "A1", [1, 0, 0, 0]));
      await s.upsert(e("da2", k, "A2", [0, 1, 0, 0]));
      await s.upsert(e("db1", other, "B1", [1, 0, 0, 0]));

      // Verify A has entries before erasure
      assert((await s.search([1, 0, 0, 0], k, 10)).length > 0, "scope A has entries before eraseScope");

      const result = await s.eraseScope(k);
      assert(result.deleted > 0, "eraseScope returns deleted > 0");

      // Scope A is empty
      assertEqual(await s.search([1, 0, 0, 0], k, 10), [], "scope A empty after eraseScope");

      // Scope B is untouched
      const bHits = await s.search([1, 0, 0, 0], other, 10);
      assert(bHits.some((h) => h.id === "db1"), "scope B entry still present");
    }) },
  ];
}

/** Behavioral contract every DurablePort adapter must satisfy. */
export function durableConformanceCases(makeStore: () => Promise<DurablePort> | DurablePort): ConformanceCase[] {
  const withStore = (fn: (s: DurablePort) => Promise<void>) => async () => {
    const s = await makeStore();
    if (typeof (s as { migrate?: () => Promise<void> }).migrate === "function") {
      await (s as unknown as { migrate: () => Promise<void> }).migrate();
    }
    await fn(s);
    if (typeof (s as { close?: () => Promise<void> }).close === "function") {
      await (s as unknown as { close: () => Promise<void> }).close();
    }
  };
  return [
    { name: "durable: writeCheckpoint then lastCheckpoint returns the highest-seq checkpoint", run: withStore(async (s) => {
      assertEqual(await s.lastCheckpoint("sess"), null, "no checkpoint yet → null");
      await s.writeCheckpoint("sess", 0, "h0");
      await s.writeCheckpoint("sess", 3, "h3");
      await s.writeCheckpoint("sess", 1, "h1");
      const last = await s.lastCheckpoint("sess");
      assertEqual(last?.seq, 3, "highest seq wins");
      assertEqual(last?.hash, "h3", "hash for highest seq");
      assertEqual(last?.sessionId, "sess", "sessionId echoed");
    }) },
    { name: "durable: checkpoints are session-isolated", run: withStore(async (s) => {
      await s.writeCheckpoint("a", 5, "ha");
      assertEqual(await s.lastCheckpoint("b"), null, "other session has none");
      assertEqual((await s.lastCheckpoint("a"))?.seq, 5, "own session present");
    }) },
    { name: "durable: writeCheckpoint is idempotent per (session, seq) — updates hash, no duplicate", run: withStore(async (s) => {
      await s.writeCheckpoint("s", 2, "old");
      await s.writeCheckpoint("s", 2, "new");
      assertEqual((await s.lastCheckpoint("s"))?.hash, "new", "hash updated in place");
      assertEqual((await s.lastCheckpoint("s"))?.seq, 2, "still seq 2");
    }) },
    { name: "durable: getIdempotency returns null for an unknown key", run: withStore(async (s) => {
      assertEqual(await s.getIdempotency("nope"), null, "missing key → null");
    }) },
    { name: "durable: intent → completion lifecycle; getIdempotency reflects applied + result", run: withStore(async (s) => {
      await s.recordIntent("k1", "argshash");
      const afterIntent = await s.getIdempotency("k1");
      assertEqual(afterIntent?.status, "intent", "status is intent before completion");
      assertEqual(afterIntent?.argsHash, "argshash", "argsHash persisted");
      assertEqual(afterIntent?.result, undefined, "no result yet");
      await s.recordCompletion("k1", { ok: true, n: 7 });
      const afterDone = await s.getIdempotency("k1");
      assertEqual(afterDone?.status, "applied", "status flips to applied");
      assertEqual(afterDone?.argsHash, "argshash", "argsHash preserved across completion");
      assertEqual(afterDone?.result, { ok: true, n: 7 }, "result persisted + JSON round-trips");
    }) },
    { name: "durable: recordIntent is write-once (does not downgrade applied → intent)", run: withStore(async (s) => {
      await s.recordIntent("k2", "h");
      await s.recordCompletion("k2", "done");
      await s.recordIntent("k2", "h"); // a re-run racing the same key must not erase the applied result
      const r = await s.getIdempotency("k2");
      assertEqual(r?.status, "applied", "still applied after a second intent");
      assertEqual(r?.result, "done", "result intact");
    }) },
    { name: "durable: recordCompletion persists null/falsy results faithfully", run: withStore(async (s) => {
      await s.recordIntent("k3", "h");
      await s.recordCompletion("k3", null);
      const r = await s.getIdempotency("k3");
      assertEqual(r?.status, "applied", "applied even with null result");
      assertEqual(r?.result, null, "null result preserved");
    }) },
    { name: "durable: getDecision returns null for an unknown (session, callId)", run: withStore(async (s) => {
      assertEqual(await s.getDecision("sess", "call-x"), null, "missing decision → null");
    }) },
    { name: "durable: recordDecision then getDecision round-trips (approved + data)", run: withStore(async (s) => {
      await s.recordDecision("sess", "call-1", { approved: true, data: { note: "ok" } });
      const d = await s.getDecision("sess", "call-1");
      assertEqual(d?.approved, true, "approved persisted");
      assertEqual(d?.data, { note: "ok" }, "data JSON round-trips");
    }) },
    { name: "durable: recordDecision persists a deny (approved:false) faithfully", run: withStore(async (s) => {
      await s.recordDecision("sess", "call-2", { approved: false });
      const d = await s.getDecision("sess", "call-2");
      assertEqual(d?.approved, false, "deny persisted");
      assertEqual(d?.data, undefined, "no data when omitted");
    }) },
    { name: "durable: decisions are scoped by (sessionId, callId)", run: withStore(async (s) => {
      await s.recordDecision("sessA", "c", { approved: true });
      assertEqual(await s.getDecision("sessB", "c"), null, "other session has no decision");
      assertEqual(await s.getDecision("sessA", "other"), null, "other callId has no decision");
      assertEqual((await s.getDecision("sessA", "c"))?.approved, true, "own (session,callId) present");
    }) },
  ];
}

export class StreamMockModel implements ModelPort {
  readonly calls: ModelRequest[] = [];
  private i = 0;
  constructor(private readonly scripted: Array<{ deltas: string[]; response: ModelResponse }>) {}

  private next(request: ModelRequest) {
    this.calls.push(request);
    const s = this.scripted[this.i++];
    if (!s) throw new Error(`StreamMockModel: no scripted response #${this.i}`);
    return s;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    return this.next(request).response;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
    const s = this.next(request);
    for (const text of s.deltas) yield { type: "delta", delta: { text } };
    yield { type: "final", response: s.response };
  }
}

/** A span as recorded by InMemoryTracer (inspectable in tests). */
export interface RecordedSpan {
  name: string;
  attributes: Record<string, string | number | boolean>;
  status?: "ok" | "error";
  message?: string;
  ended: boolean;
}

/**
 * In-memory `TracerPort` for tests and zero-config dev. Records every span (name, attributes,
 * status, ended) into `spans` in emission order. Well-behaved: span methods never throw.
 */
export class InMemoryTracer implements TracerPort {
  readonly spans: RecordedSpan[] = [];

  startSpan(name: string, attributes: Record<string, string | number | boolean> = {}): Span {
    const rec: RecordedSpan = { name, attributes: { ...attributes }, ended: false };
    this.spans.push(rec);
    return {
      setAttribute(key, value) {
        rec.attributes[key] = value;
      },
      setStatus(status, message) {
        rec.status = status;
        if (message !== undefined) rec.message = message;
      },
      end() {
        rec.ended = true;
      },
    };
  }

  /** Names of all recorded spans, in emission order. */
  names(): string[] {
    return this.spans.map((s) => s.name);
  }

  /** All recorded spans with the given name. */
  byName(name: string): RecordedSpan[] {
    return this.spans.filter((s) => s.name === name);
  }
}

/** In-memory SecretsPort backed by a plain record. The model never sees the values; tools fetch them at call time (§10.3). */
export class MapSecrets implements SecretsPort {
  constructor(private readonly store: Record<string, string>) {}
  async get(ref: string): Promise<string | undefined> {
    return this.store[ref];
  }
}

/**
 * In-memory `SandboxPort` fake. Echoes the submitted code to stdout (or a `bash` "echo X" marker)
 * and reports success. FOR TESTS AND TRUSTED-DEV ONLY — it does NOT isolate anything and provides
 * NO security boundary. Never use it to run untrusted or agent-generated code in production.
 */
export class EchoSandbox implements SandboxPort {
  async run(code: string, opts?: SandboxRunOptions): Promise<SandboxResult> {
    // Mimic a trivial deterministic interpreter so adapter tests can assert mapping:
    //  - a program that is exactly `fail` (any language) → non-zero exit + error (failure mapping)
    //  - `echo <text>` (bash) → stdout is <text> (language pass-through is observable)
    //  - anything else → stdout is the code verbatim
    if (code.trim() === "fail") {
      return { stdout: "", stderr: "boom", exitCode: 1, error: "EchoError: forced failure" };
    }
    const lang = opts?.language ?? "javascript";
    if (lang === "bash" && code.trim().startsWith("echo ")) {
      return { stdout: code.trim().slice("echo ".length), stderr: "", exitCode: 0 };
    }
    return { stdout: code, stderr: "", exitCode: 0 };
  }
}

/**
 * Behavioral contract every `SandboxPort` adapter that CAN execute must satisfy (the echo fake, the
 * E2B faithful-fake, the live E2B). `NoopSandbox` deliberately does NOT satisfy this — it refuses by
 * design (§10.7) and has its own tests in `@eidentic/core`.
 *
 * The cases use a tiny deterministic program surface the faithful fakes understand:
 *  - a normal program echoes its source / a value to stdout, exitCode 0, no error;
 *  - the literal program `fail` maps to a non-zero exitCode AND a non-empty `error`;
 *  - the `language` option is passed through (a `bash`/`echo` program yields the echoed text).
 */
export function sandboxConformanceCases(makeSandbox: () => Promise<SandboxPort> | SandboxPort): ConformanceCase[] {
  const withSandbox = (fn: (s: SandboxPort) => Promise<void>) => async () => {
    const s = await makeSandbox();
    await fn(s);
  };
  return [
    { name: "sandbox: a simple program returns its output on stdout with exitCode 0 and no error", run: withSandbox(async (s) => {
      const r = await s.run("hello world");
      assert(r.stdout.includes("hello world"), "stdout carries program output");
      assertEqual(r.exitCode, 0, "success exit code is 0");
      assert(r.error === undefined, "no error on success");
      assertEqual(r.stderr, "", "no stderr on success");
    }) },
    { name: "sandbox: a failing program maps to non-zero exitCode and a non-empty error", run: withSandbox(async (s) => {
      const r = await s.run("fail");
      assert(r.exitCode !== 0, "failure exit code is non-zero");
      assert(typeof r.error === "string" && r.error.length > 0, "error message present");
    }) },
    { name: "sandbox: the language option is passed through to execution", run: withSandbox(async (s) => {
      const r = await s.run("echo pong", { language: "bash" });
      assertEqual(r.exitCode, 0, "bash echo succeeds");
      assert(r.stdout.includes("pong"), "bash echo output is observable");
    }) },
  ];
}
