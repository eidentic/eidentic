import { describe, it, expect, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import {
  createWorkflowRunRegistry,
  fileWorkflowRunStore,
  runStatusOf,
} from "@eidentic/workflow";
import type {
  StepTrace,
  WorkflowResult,
  WorkflowRunRecord,
  WorkflowRunStore,
} from "@eidentic/workflow";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeResult<O>(output: O, trace: StepTrace[] = []): WorkflowResult<O> {
  return { output, trace };
}

function mkdtemp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ─── Durable store round-trip ─────────────────────────────────────────────────

describe("durable store — write-through + hydrate", () => {
  it("write-through persists records to the store (round-trip)", async () => {
    const dir = mkdtemp("eidentic-dur-");
    try {
      const path = join(dir, "runs.json");
      const reg = createWorkflowRunRegistry({ store: fileWorkflowRunStore(path) });
      const rec = reg.record("w", makeResult({ answer: 42 }));
      await reg.flush();

      const fresh = createWorkflowRunRegistry({ store: fileWorkflowRunStore(path) });
      await fresh.hydrate();
      const loaded = fresh.get(rec.id);
      expect(loaded).toBeDefined();
      expect(loaded!.output).toEqual({ answer: 42 });
      expect(loaded!.name).toBe("w");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hydrate loads multiple records newest-first ordering preserved", async () => {
    // Records are created synchronously — they share the same Date.now() millisecond
    // in fast environments. Ordering must be stable regardless: the registry stamps
    // each record with a monotonically-increasing `seq` field that acts as a
    // deterministic tiebreaker, so this test is race-free with no sleep required.
    const dir = mkdtemp("eidentic-dur-");
    try {
      const path = join(dir, "runs.json");
      const reg = createWorkflowRunRegistry({ store: fileWorkflowRunStore(path) });
      const a = reg.record("a", makeResult(1));
      const b = reg.record("b", makeResult(2));
      const c = reg.record("c", makeResult(3));
      await reg.flush();

      const fresh = createWorkflowRunRegistry({ store: fileWorkflowRunStore(path) });
      await fresh.hydrate();
      const names = fresh.list().map((r) => r.name);
      expect(names).toEqual(["c", "b", "a"]); // newest (highest seq) first
      const ids = fresh.list().map((r) => r.id);
      expect(ids).toEqual([c.id, b.id, a.id]); // newest first
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registry without a store behaves exactly as before (hydrate is a no-op)", async () => {
    const reg = createWorkflowRunRegistry();
    const rec = reg.record("w", makeResult("x"));
    await reg.hydrate(); // no throw, no-op
    expect(reg.get(rec.id)).toBe(rec);
    expect(reg.list()).toHaveLength(1);
  });

  it("onStoreError is called when the store rejects (record still kept in memory)", async () => {
    const onStoreError = vi.fn();
    const failingStore: WorkflowRunStore = {
      save: async () => {
        throw new Error("disk full");
      },
      load: async () => undefined,
      list: async () => [],
    };
    const reg = createWorkflowRunRegistry({ store: failingStore, onStoreError });
    const rec = reg.record("w", makeResult("x"));
    await reg.flush();
    expect(onStoreError).toHaveBeenCalledOnce();
    expect((onStoreError.mock.calls[0]![0] as Error).message).toBe("disk full");
    // In-memory record is unaffected.
    expect(reg.get(rec.id)).toBe(rec);
  });

  it("maxRuns option is honored as an alias for limit", async () => {
    const reg = createWorkflowRunRegistry({ maxRuns: 2 });
    const a = reg.record("a", makeResult(1));
    reg.record("b", makeResult(2));
    reg.record("c", makeResult(3)); // evicts a
    expect(reg.get(a.id)).toBeUndefined();
    expect(reg.list()).toHaveLength(2);
  });
});

// ─── File store crash safety ──────────────────────────────────────────────────

describe("fileWorkflowRunStore — crash safety", () => {
  it("survives a simulated crash: write, recreate store, records intact", async () => {
    const dir = mkdtemp("eidentic-crash-");
    try {
      const path = join(dir, "runs.json");

      // Process #1 writes some records, then "crashes" (we just drop the ref).
      const reg1 = createWorkflowRunRegistry({ store: fileWorkflowRunStore(path) });
      const r1 = reg1.record("first", makeResult("one"));
      const r2 = reg1.record("second", makeResult("two"));
      await reg1.flush();

      // Process #2 starts fresh from the same file.
      const reg2 = createWorkflowRunRegistry({ store: fileWorkflowRunStore(path) });
      await reg2.hydrate();
      expect(reg2.get(r1.id)?.output).toBe("one");
      expect(reg2.get(r2.id)?.output).toBe("two");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a corrupt/partial tmp file does not corrupt the committed JSON", async () => {
    const dir = mkdtemp("eidentic-crash-");
    try {
      const path = join(dir, "runs.json");
      const store = fileWorkflowRunStore(path);
      await store.save({
        id: "abc",
        name: "w",
        status: "ok",
        runStatus: "completed",
        startedAt: 0,
        durationMs: 0,
        stepCount: 0,
        trace: [],
      } as WorkflowRunRecord);

      // Simulate a torn write to the tmp sidecar — the committed file is untouched.
      writeFileSync(`${path}.tmp`, "{ this is not valid json", "utf8");

      const committed = JSON.parse(readFileSync(path, "utf8")) as WorkflowRunRecord[];
      expect(committed).toHaveLength(1);
      expect(committed[0]!.id).toBe("abc");

      // A fresh store reads the committed file, ignoring the tmp sidecar.
      const fresh = fileWorkflowRunStore(path);
      expect((await fresh.load("abc"))?.name).toBe("w");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missing file → empty store (no throw)", async () => {
    const dir = mkdtemp("eidentic-crash-");
    try {
      const store = fileWorkflowRunStore(join(dir, "does-not-exist.json"));
      expect(await store.list()).toEqual([]);
      expect(await store.load("x")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("delete removes a record from the persisted set", async () => {
    const dir = mkdtemp("eidentic-crash-");
    try {
      const path = join(dir, "runs.json");
      const store = fileWorkflowRunStore(path);
      const rec = {
        id: "del-me",
        name: "w",
        status: "ok",
        runStatus: "completed",
        startedAt: 0,
        durationMs: 0,
        stepCount: 0,
        trace: [],
      } as WorkflowRunRecord;
      await store.save(rec);
      await store.delete!("del-me");
      expect(await store.load("del-me")).toBeUndefined();

      const fresh = fileWorkflowRunStore(path);
      expect(await fresh.list()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Filtering (owner / runStatus / version) ─────────────────────────────────

describe("registry — list filters", () => {
  it("filters by owner", () => {
    const reg = createWorkflowRunRegistry();
    reg.record("a", makeResult(1), { userId: "u1" });
    reg.record("b", makeResult(2), { userId: "u2" });
    const u1 = reg.list({ owner: { userId: "u1" } });
    expect(u1).toHaveLength(1);
    expect(u1[0]!.name).toBe("a");
  });

  it("filters by version", () => {
    const reg = createWorkflowRunRegistry();
    reg.record("a", makeResult(1), undefined, { version: "1.0.0" });
    reg.record("b", makeResult(2), undefined, { version: "2.0.0" });
    const v2 = reg.list({ version: "2.0.0" });
    expect(v2).toHaveLength(1);
    expect(v2[0]!.name).toBe("b");
  });

  it("filters by runStatus", () => {
    const reg = createWorkflowRunRegistry();
    reg.record("ok", makeResult(1));
    reg.recordError("bad", [], "boom");
    const errors = reg.list({ runStatus: "error" });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.name).toBe("bad");
    const completed = reg.list({ runStatus: "completed" });
    expect(completed).toHaveLength(1);
    expect(completed[0]!.name).toBe("ok");
  });
});

// ─── runStatus derivation back-compat ────────────────────────────────────────

describe("runStatusOf — back-compat derivation", () => {
  it("derives 'error' from a legacy record with status=error and no runStatus", () => {
    const legacy = {
      id: "x", name: "w", status: "error", startedAt: 0, durationMs: 0, stepCount: 0, trace: [], error: "e",
    } as WorkflowRunRecord;
    expect(runStatusOf(legacy)).toBe("error");
  });

  it("derives 'completed' from a legacy record with status=ok and no runStatus", () => {
    const legacy = {
      id: "x", name: "w", status: "ok", startedAt: 0, durationMs: 0, stepCount: 0, trace: [],
    } as WorkflowRunRecord;
    expect(runStatusOf(legacy)).toBe("completed");
  });

  it("explicit runStatus wins over derivation", () => {
    const rec = {
      id: "x", name: "w", status: "ok", runStatus: "suspended", startedAt: 0, durationMs: 0, stepCount: 0, trace: [],
    } as WorkflowRunRecord;
    expect(runStatusOf(rec)).toBe("suspended");
  });
});
