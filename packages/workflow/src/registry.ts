import type { StepTrace, WorkflowResult } from "./types.js";
import type { ReplayCache } from "./suspend.js";

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Principal that owns a workflow run.
 * All fields are optional; records with no owner fields set are treated as
 * ownerless / legacy (back-compat with NoAuth single-tenant deployments).
 */
export interface WorkflowRunOwner {
  userId?: string;
  orgId?: string;
  apiKey?: string;
}

/**
 * Lifecycle status of a workflow run.
 *  - `"completed"` — the run finished and produced an output.
 *  - `"error"`     — the run failed.
 *  - `"suspended"` — the run hit a `ctx.suspend(...)` gate and is awaiting a
 *                    human-in-the-loop decision (resumable via `resumeWorkflow`).
 */
export type WorkflowRunStatus = "completed" | "error" | "suspended";

/**
 * State persisted for a suspended run so it can be deterministically resumed.
 * Present only on records with `runStatus === "suspended"`.
 */
export interface WorkflowSuspension {
  /** Token of the gate currently awaiting a decision. */
  token: string;
  /** Optional payload the gate surfaced for the approver. */
  payload?: unknown;
  /** Serialized replay cache (memoized step results + prior decisions). */
  cache: ReplayCache;
  /** The original run input, needed to replay the body from the top. */
  input: unknown;
}

export interface WorkflowRunRecord {
  id: string;
  name: string;
  /**
   * Legacy binary status (`"ok" | "error"`) — retained for back-compat with
   * existing consumers (server/studio summaries) and existing API contracts.
   * For the full lifecycle (completed / error / suspended) read {@link runStatus}
   * or call {@link runStatusOf}.
   */
  status: "ok" | "error";
  /**
   * Full lifecycle status. Absent on legacy records — derive with
   * {@link runStatusOf} (which falls back to `status`/`error`).
   */
  runStatus?: WorkflowRunStatus;
  /** Optional workflow version tag (from the workflow definition). */
  version?: string;
  startedAt: number;
  durationMs: number;
  stepCount: number;
  trace: StepTrace[];
  output?: unknown;
  error?: string;
  /**
   * The principal that recorded this run.
   * Absent on legacy records (back-compat). Present when recorded with an owner.
   */
  owner?: WorkflowRunOwner;
  /** Replay state for a suspended run. Present iff `runStatus === "suspended"`. */
  suspension?: WorkflowSuspension;
  /**
   * Monotonic insertion sequence number. Assigned by the registry at record time
   * and persisted alongside the record. Used as a deterministic tiebreaker when
   * two records share the same `startedAt` millisecond — the record inserted later
   * always has a higher `seq`. Absent on legacy records (treated as 0 for sorting).
   */
  seq?: number;
}

/**
 * Resolve a record's full lifecycle status, back-compat with legacy records
 * that only carry the binary `status`.
 *  - explicit `runStatus` wins;
 *  - otherwise `error` present (or `status === "error"`) → `"error"`;
 *  - otherwise → `"completed"`.
 */
export function runStatusOf(rec: WorkflowRunRecord): WorkflowRunStatus {
  if (rec.runStatus !== undefined) return rec.runStatus;
  if (rec.status === "error" || rec.error !== undefined) return "error";
  return "completed";
}

/** Filter for {@link WorkflowRunStore.list} / registry list. */
export interface WorkflowRunFilter {
  /** Restrict to records whose owner matches all provided owner fields. */
  owner?: WorkflowRunOwner;
  /** Restrict to records with this lifecycle status. */
  runStatus?: WorkflowRunStatus;
  /** Restrict to records with this version tag. */
  version?: string;
}

export interface WorkflowRunRegistry {
  /**
   * Derive and store a `WorkflowRunRecord` from a completed `WorkflowResult`.
   * Returns the new record so the caller can grab the generated id immediately.
   *
   * @param name   — human-readable workflow name
   * @param result — completed `WorkflowResult`
   * @param owner  — optional principal to attach for per-tenant filtering
   */
  record<O>(name: string, result: WorkflowResult<O>, owner?: WorkflowRunOwner, opts?: RecordOptions): WorkflowRunRecord;
  /**
   * Store a `WorkflowRunRecord` for a run that failed before producing an output.
   * The partial trace (steps completed before the crash) is recorded with
   * `status: "error"` and the top-level `error` field set to `errorMessage`.
   */
  recordError(name: string, trace: StepTrace[], errorMessage: string, owner?: WorkflowRunOwner, opts?: RecordOptions): WorkflowRunRecord;
  /**
   * Store a `WorkflowRunRecord` for a run that suspended on a HITL gate.
   * Recorded with `runStatus: "suspended"` and the {@link WorkflowSuspension}
   * state needed to resume it later via `resumeWorkflow()`.
   */
  recordSuspended(name: string, trace: StepTrace[], suspension: WorkflowSuspension, owner?: WorkflowRunOwner, opts?: RecordOptions): WorkflowRunRecord;
  /**
   * Replace an existing record in place, preserving its id and insertion
   * position. Used by `resumeWorkflow()` to transition a suspended run to
   * completed / error / re-suspended.
   */
  update(id: string, rec: WorkflowRunRecord): WorkflowRunRecord;
  /** Retrieve a single run record by id. Returns `undefined` for unknown ids. */
  get(id: string): WorkflowRunRecord | undefined;
  /** List stored run records, newest first. Optionally filtered. */
  list(filter?: WorkflowRunFilter): WorkflowRunRecord[];
  /**
   * Load persisted records from the backing {@link WorkflowRunStore} (if any).
   * No-op when the registry was created without a store. Call once on startup.
   */
  hydrate(): Promise<void>;
}

/** Optional per-record metadata at record time. */
export interface RecordOptions {
  /** Version tag to stamp on the record. */
  version?: string;
}

// ─── Durable persistence port ─────────────────────────────────────────────────

/**
 * Minimal async persistence port for workflow run records.
 *
 * The registry stays a synchronous, in-memory cache; when a store is attached
 * it is written through asynchronously (fire-and-forget) so the hot path never
 * becomes async. Implement this to back runs with a file, a database, etc.
 */
export interface WorkflowRunStore {
  /** Persist (insert or replace) a record. */
  save(record: WorkflowRunRecord): Promise<void>;
  /** Load a single record by id, or `undefined` if absent. */
  load(id: string): Promise<WorkflowRunRecord | undefined>;
  /** List all persisted records (optionally filtered), newest first. */
  list(filter?: WorkflowRunFilter): Promise<WorkflowRunRecord[]>;
  /** Optionally delete a record by id. */
  delete?(id: string): Promise<void>;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export interface WorkflowRunRegistryOptions {
  /** Maximum number of records to keep in memory (ring-buffer eviction). Default 100. */
  limit?: number;
  /**
   * @deprecated alias for {@link limit}; kept for back-compat. `limit` wins if both set.
   */
  maxRuns?: number;
  /** Durable backing store. When set, records are written through asynchronously. */
  store?: WorkflowRunStore;
  /**
   * Called when an async write-through to the store rejects. Defaults to a
   * `console.error`. Use this to surface persistence failures (the in-memory
   * record is still kept regardless).
   */
  onStoreError?: (err: unknown, record: WorkflowRunRecord) => void;
}

/**
 * Create a bounded `WorkflowRunRegistry` with an in-memory ring buffer and an
 * optional durable backing {@link WorkflowRunStore}.
 *
 * Derivation logic (record):
 *  - `status`    — "error" if ANY step has `status === "error"`, otherwise "ok".
 *  - `runStatus` — "error" / "completed" mirroring `status` (or "suspended" for
 *                  suspended records).
 *  - `startedAt` — `min(step.startedAt)` across the trace (0 when trace is empty).
 *  - `durationMs`— `max(step.startedAt + step.durationMs) - startedAt` (0 when empty).
 *  - `stepCount` — `trace.length`.
 *  - `output`    — `result.output` (omitted when undefined).
 *  - `error`     — first step error message (omitted when no error step).
 *
 * Write-through: when a `store` is provided, every record/update is persisted
 * via `store.save()` asynchronously. The synchronous registry API never blocks
 * on the store; failures go to `onStoreError`. Call `hydrate()` once on startup
 * to load persisted records back into memory.
 *
 * When the ring buffer is full the oldest entry is evicted before inserting.
 */
export function createWorkflowRunRegistry(
  opts?: WorkflowRunRegistryOptions,
): WorkflowRunRegistry {
  const limit = opts?.limit ?? opts?.maxRuns ?? 100;
  const store = opts?.store;
  const onStoreError =
    opts?.onStoreError ??
    ((err: unknown, record: WorkflowRunRecord) => {
      // eslint-disable-next-line no-console
      console.error(`[WorkflowRunRegistry] failed to persist run ${record.id}:`, err);
    });

  // Monotonic counter — incremented once per insert so records recorded in the
  // same millisecond still have a deterministic, strictly-increasing sequence number.
  let nextSeq = 0;

  // We store ids in insertion order so we can evict the oldest (front) quickly.
  const order: string[] = [];
  const mem = new Map<string, WorkflowRunRecord>();

  /** Fire-and-forget write-through to the durable store (never blocks callers). */
  function writeThrough(rec: WorkflowRunRecord): void {
    if (store === undefined) return;
    void Promise.resolve()
      .then(() => store.save(rec))
      .catch((err: unknown) => onStoreError(err, rec));
  }

  /** Insert a brand-new record into the ring buffer + store. */
  function insert(rec: WorkflowRunRecord): WorkflowRunRecord {
    // Stamp with the next monotonic sequence number so same-millisecond records
    // have a deterministic ordering tiebreaker.
    const stamped: WorkflowRunRecord = { ...rec, seq: nextSeq++ };
    if (mem.size >= limit && order.length > 0) {
      const oldest = order.shift()!;
      mem.delete(oldest);
    }
    mem.set(stamped.id, stamped);
    order.push(stamped.id);
    writeThrough(stamped);
    return stamped;
  }

  function deriveSpan(trace: StepTrace[]): { startedAt: number; durationMs: number } {
    if (trace.length === 0) return { startedAt: 0, durationMs: 0 };
    const startedAt = trace.reduce((min, s) => Math.min(min, s.startedAt), Infinity);
    const endAt = trace.reduce((max, s) => Math.max(max, s.startedAt + s.durationMs), 0);
    return { startedAt, durationMs: Math.max(0, endAt - startedAt) };
  }

  function matches(rec: WorkflowRunRecord, filter?: WorkflowRunFilter): boolean {
    if (filter === undefined) return true;
    if (filter.version !== undefined && rec.version !== filter.version) return false;
    if (filter.runStatus !== undefined && runStatusOf(rec) !== filter.runStatus) return false;
    if (filter.owner !== undefined) {
      const o = rec.owner ?? {};
      const f = filter.owner;
      if (f.userId !== undefined && o.userId !== f.userId) return false;
      if (f.orgId !== undefined && o.orgId !== f.orgId) return false;
      if (f.apiKey !== undefined && o.apiKey !== f.apiKey) return false;
    }
    return true;
  }

  return {
    record<O>(name: string, result: WorkflowResult<O>, owner?: WorkflowRunOwner, recOpts?: RecordOptions): WorkflowRunRecord {
      const { trace: rawTrace, output } = result;
      const trace: StepTrace[] = rawTrace.map((s) => ({ ...s }));
      const status: "ok" | "error" = trace.some((s) => s.status === "error") ? "error" : "ok";
      const { startedAt, durationMs } = deriveSpan(trace);
      const firstError = trace.find((s) => s.status === "error");

      const rec: WorkflowRunRecord = {
        id: crypto.randomUUID(),
        name,
        status,
        runStatus: status === "error" ? "error" : "completed",
        startedAt,
        durationMs,
        stepCount: trace.length,
        trace,
        ...(recOpts?.version !== undefined ? { version: recOpts.version } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(firstError?.error !== undefined ? { error: firstError.error } : {}),
        ...(owner !== undefined ? { owner: { ...owner } } : {}),
      };
      return insert(rec);
    },

    recordError(name: string, rawTrace: StepTrace[], errorMessage: string, owner?: WorkflowRunOwner, recOpts?: RecordOptions): WorkflowRunRecord {
      const trace: StepTrace[] = rawTrace.map((s) => ({ ...s }));
      const { startedAt, durationMs } = deriveSpan(trace);
      const rec: WorkflowRunRecord = {
        id: crypto.randomUUID(),
        name,
        status: "error",
        runStatus: "error",
        startedAt,
        durationMs,
        stepCount: trace.length,
        trace,
        error: errorMessage,
        ...(recOpts?.version !== undefined ? { version: recOpts.version } : {}),
        ...(owner !== undefined ? { owner: { ...owner } } : {}),
      };
      return insert(rec);
    },

    recordSuspended(name: string, rawTrace: StepTrace[], suspension: WorkflowSuspension, owner?: WorkflowRunOwner, recOpts?: RecordOptions): WorkflowRunRecord {
      const trace: StepTrace[] = rawTrace.map((s) => ({ ...s }));
      const { startedAt, durationMs } = deriveSpan(trace);
      const rec: WorkflowRunRecord = {
        id: crypto.randomUUID(),
        name,
        // Legacy binary status: a suspended run is not an error → "ok".
        status: "ok",
        runStatus: "suspended",
        startedAt,
        durationMs,
        stepCount: trace.length,
        trace,
        suspension: {
          token: suspension.token,
          ...(suspension.payload !== undefined ? { payload: suspension.payload } : {}),
          cache: suspension.cache,
          input: suspension.input,
        },
        ...(recOpts?.version !== undefined ? { version: recOpts.version } : {}),
        ...(owner !== undefined ? { owner: { ...owner } } : {}),
      };
      return insert(rec);
    },

    update(id: string, rec: WorkflowRunRecord): WorkflowRunRecord {
      // Preserve insertion position; just swap the value in place.
      if (!mem.has(id) && !order.includes(id)) {
        // Unknown id — treat as a fresh insert to be permissive.
        return insert(rec);
      }
      mem.set(id, rec);
      writeThrough(rec);
      return rec;
    },

    get(id: string): WorkflowRunRecord | undefined {
      return mem.get(id);
    },

    list(filter?: WorkflowRunFilter): WorkflowRunRecord[] {
      // newest first
      const all = order.map((rid) => mem.get(rid)!).filter((r) => r !== undefined);
      const filtered = filter !== undefined ? all.filter((r) => matches(r, filter)) : all;
      return filtered.reverse();
    },

    async hydrate(): Promise<void> {
      if (store === undefined) return;
      const persisted = await store.list();
      // Persisted records come newest-first; insert oldest-first so the in-memory
      // ring buffer keeps the most recent `limit` records with correct order.
      const oldestFirst = [...persisted].reverse();
      for (const rec of oldestFirst) {
        if (mem.has(rec.id)) continue;
        if (mem.size >= limit && order.length > 0) {
          const oldest = order.shift()!;
          mem.delete(oldest);
        }
        mem.set(rec.id, rec);
        order.push(rec.id);
        // Advance the local counter past any seq already on disk so post-hydrate
        // inserts never collide with persisted sequence numbers.
        if (rec.seq !== undefined && rec.seq >= nextSeq) {
          nextSeq = rec.seq + 1;
        }
      }
    },
  };
}
