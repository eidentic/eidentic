/**
 * @eidentic/server — BatchRunner: bounded-concurrency offline/batch agent processing.
 *
 * ## Overview
 *
 * `BatchRunner` takes an array of inputs and runs each through an agent with a
 * configurable concurrency cap (default 4). Items that throw are captured as
 * per-item errors — a single bad item never aborts the batch. Aggregate
 * usage/cost totals are accumulated using the existing `Usage` / `CostBreakdown`
 * types from `@eidentic/types`.
 *
 * ## Provider-native batch (e.g. Anthropic Message Batches API)
 *
 * The Anthropic Message Batches API offers ~50% cost savings for async jobs but
 * is exposed via a separate REST API, NOT through the AI SDK v6 `generateText` /
 * `streamText` surface. Wiring it would require either a dedicated HTTP client
 * per provider or a non-trivial AI-SDK fork — too large for v1.
 *
 * Instead, the `BatchRunner` accepts an optional `backend` parameter (the
 * `BatchBackend` interface). The default `"concurrent"` backend runs items via
 * `agent.query()` with bounded parallelism. A future `"anthropic-batch"` or
 * `"openai-batch"` backend could implement the provider REST APIs behind this
 * seam without changing any public BatchRunner API.
 *
 * ## Concurrency guarantee
 *
 * At most `concurrency` items are ever in-flight simultaneously. The runner uses
 * a slot-based semaphore — no library dep. Items are dispatched in input order;
 * results are collected as they complete (output order may differ when
 * `concurrency > 1`).
 *
 * ## Cancellation
 *
 * Pass an `AbortSignal` via `BatchRunOptions.signal`. Once aborted, no further
 * items are dispatched. Items already in-flight receive the signal and may abort
 * early (dependent on the agent's internal abort handling). A cancelled batch
 * returns partial results up to that point with `aggregate.cancelled: true`.
 *
 * ## Progress callback
 *
 * `onProgress(item)` is called once per completed item (success OR error),
 * passing the completed `BatchItemResult`. Useful for streaming output to a UI
 * or writing partial results to disk.
 */

import type { Agent } from "@eidentic/core";
import type { Usage, CostBreakdown } from "@eidentic/types";

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

/** A single item to process in a batch. */
export interface BatchItem {
  /**
   * Optional stable identifier for this item.
   * Defaults to the item's zero-based index string ("0", "1", …) when absent.
   */
  id?: string;
  /** The user message to pass to `agent.query()`. */
  input: string;
  /** Optional per-item `userId` forwarded to `agent.query()`. */
  userId?: string;
  /** Optional per-item `orgId` forwarded to `agent.query()`. */
  orgId?: string;
  /** Optional per-item `sessionId`. Generated (UUID) when absent. */
  sessionId?: string;
}

/** Outcome of a successfully completed item. */
export interface BatchItemSuccess {
  status: "success";
  id: string;
  /** The agent's final text output (from the terminal `result` event). */
  output: string;
  /** Per-item token usage (foreground totals, same units as `Usage`). */
  usage: Usage;
  /**
   * Per-item cost breakdown. Present only when the agent has a `PriceTable`
   * configured (same condition as `result.cost` being non-undefined).
   */
  cost?: CostBreakdown;
  /** The sessionId used for this item's run. */
  sessionId: string;
}

/** Outcome of a failed item (the error is captured; the batch continues). */
export interface BatchItemError {
  status: "error";
  id: string;
  /** Error message. */
  error: string;
  /** The sessionId used for this item's run (may be undefined if dispatch never started). */
  sessionId?: string;
}

export type BatchItemResult = BatchItemSuccess | BatchItemError;

/** Aggregate totals across all items in the batch. */
export interface BatchAggregate {
  /** Total input + output tokens across all SUCCESSFUL items. */
  totalUsage: Usage;
  /**
   * Summed USD cost across all successful items that had a `CostBreakdown`.
   * `undefined` when no items had pricing.
   */
  totalUsd?: number;
  /** Number of items that completed with `status: "success"`. */
  successCount: number;
  /** Number of items that completed with `status: "error"`. */
  errorCount: number;
  /**
   * `true` when the batch was stopped early by an AbortSignal.
   * Items that were not yet dispatched when the signal fired are absent from
   * `results` — they were never started.
   */
  cancelled: boolean;
}

/** The return value of `BatchRunner.run()`. */
export interface BatchResult {
  /** Per-item outcome, in completion order. May be shorter than `items` if cancelled. */
  results: BatchItemResult[];
  /** Aggregate totals. */
  aggregate: BatchAggregate;
}

// ---------------------------------------------------------------------------
// Progress callback
// ---------------------------------------------------------------------------

/** Called once per completed item (success or error), in completion order. */
export type OnProgress = (item: BatchItemResult) => void;

// ---------------------------------------------------------------------------
// Backend seam (strategy pattern — for future provider-native batch)
// ---------------------------------------------------------------------------

/**
 * Interface for the batch execution backend.
 *
 * The default `"concurrent"` backend calls `agent.query()` directly with
 * bounded parallelism. Future implementations may use provider-native APIs:
 *
 * ```ts
 * // Future usage (not implemented in v1):
 * const runner = new BatchRunner(agent, {
 *   backend: new AnthropicBatchBackend({ apiKey: process.env.ANTHROPIC_API_KEY }),
 * });
 * ```
 *
 * A backend receives one item at a time and is responsible for:
 * 1. Dispatching the item to the underlying inference service.
 * 2. Returning a `BatchItemResult` (NEVER throwing — capture errors as `status:"error"`).
 * 3. Respecting `signal` for cancellation.
 *
 * The `BatchRunner` handles concurrency, cancellation bookkeeping, progress
 * callbacks, and aggregate accumulation — the backend only needs to run ONE item.
 */
export interface BatchBackend {
  /**
   * Execute a single batch item and return its result.
   *
   * Called by `BatchRunner` up to `concurrency` times in parallel. The backend
   * MUST honour `signal.aborted` and terminate early when the signal fires.
   *
   * @param item - The resolved item (id, input, sessionId, userId, orgId all populated).
   * @param signal - The batch's cancellation signal (may already be aborted).
   * @returns The per-item outcome. Should not throw; capture errors as `{ status: "error" }`.
   */
  run(item: Required<Pick<BatchItem, "id" | "input">> & { userId: string; orgId: string; sessionId: string }, signal: AbortSignal): Promise<BatchItemResult>;
}

// ---------------------------------------------------------------------------
// Default backend: agent.query() with per-item session
// ---------------------------------------------------------------------------

/**
 * Default `BatchBackend` that delegates each item to `agent.query()` and
 * drains the async iterable, capturing the terminal `result` event.
 *
 * This is an internal implementation detail; callers interact with `BatchRunner`.
 */
class ConcurrentAgentBackend implements BatchBackend {
  constructor(private readonly agent: Agent) {}

  async run(
    item: Required<Pick<BatchItem, "id" | "input">> & { userId: string; orgId: string; sessionId: string },
    signal: AbortSignal,
  ): Promise<BatchItemResult> {
    try {
      let finalOutput = "";
      let finalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
      let finalCost: CostBreakdown | undefined;

      for await (const ev of this.agent.query(item.input, {
        sessionId: item.sessionId,
        ...(item.userId ? { userId: item.userId } : {}),
        ...(item.orgId ? { orgId: item.orgId } : {}),
        signal,
      })) {
        if (ev.type === "result") {
          finalOutput =
            typeof ev.output === "string"
              ? ev.output
              : ev.output == null
                ? ""
                : String(ev.output);
          finalUsage = ev.usage;
          finalCost = ev.cost;
        }
      }

      return {
        status: "success",
        id: item.id,
        output: finalOutput,
        usage: finalUsage,
        cost: finalCost,
        sessionId: item.sessionId,
      };
    } catch (err: unknown) {
      return {
        status: "error",
        id: item.id,
        error: err instanceof Error ? err.message : String(err),
        sessionId: item.sessionId,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// BatchRunner options
// ---------------------------------------------------------------------------

export interface BatchRunnerOptions {
  /**
   * Maximum number of items to process concurrently.
   * @default 4
   */
  concurrency?: number;
  /**
   * Batch execution backend.
   * Defaults to `ConcurrentAgentBackend` (calls `agent.query()` directly).
   *
   * Swap this to integrate provider-native batch APIs (e.g. Anthropic Message
   * Batches, OpenAI Batch API) in a future release without changing any other
   * `BatchRunner` API surface.
   */
  backend?: BatchBackend;
}

export interface BatchRunOptions {
  /**
   * AbortSignal for cancelling the batch. Once aborted, no further items are
   * dispatched. In-flight items receive the signal and may terminate early.
   */
  signal?: AbortSignal;
  /**
   * Optional callback invoked once per completed item (success or error).
   * Called in completion order (not necessarily input order when `concurrency > 1`).
   */
  onProgress?: OnProgress;
  /**
   * Whether to accumulate per-item results in the returned `BatchResult.results` array.
   *
   * @default true
   *
   * For large batches (thousands of items or more) holding all results in memory may
   * exhaust the heap. Set `collectResults: false` to skip in-memory accumulation;
   * `BatchResult.results` will be an empty array while `aggregate` totals remain accurate.
   * Use the `onProgress` callback to drain results incrementally instead:
   *
   * ```ts
   * await runner.run(items, {
   *   collectResults: false,
   *   onProgress: (item) => db.insert(item), // stream results to persistent storage
   * });
   * ```
   */
  collectResults?: boolean;
}

// ---------------------------------------------------------------------------
// BatchRunner
// ---------------------------------------------------------------------------

/** Resolved item with all optional fields filled. */
type ResolvedItem = Required<Pick<BatchItem, "id" | "input">> & {
  userId: string;
  orgId: string;
  sessionId: string;
};

/**
 * Bounded-concurrency batch processor for agent inputs.
 *
 * ```ts
 * const runner = new BatchRunner(agent, { concurrency: 8 });
 *
 * const { results, aggregate } = await runner.run(
 *   inputs.map((text) => ({ input: text })),
 *   {
 *     signal: controller.signal,
 *     onProgress: (item) => console.log(item.status, item.id),
 *   },
 * );
 *
 * console.log(
 *   `${aggregate.successCount} ok, ${aggregate.errorCount} err, ` +
 *   `${aggregate.totalUsage.inputTokens + aggregate.totalUsage.outputTokens} tokens total`,
 * );
 * ```
 *
 * ### Error isolation
 * A failed item (agent error, network error, aborted sub-run) is captured as
 * `{ status: "error", ... }` — it does NOT abort the batch.
 *
 * ### Provider-native batch (deferred, v1)
 * v1 uses `agent.query()` directly (the `"concurrent"` backend). To integrate
 * Anthropic Message Batches or OpenAI Batch API, implement `BatchBackend` and
 * pass it via `options.backend`.
 */
export class BatchRunner {
  private readonly concurrency: number;
  private readonly backend: BatchBackend;

  constructor(agent: Agent, options: BatchRunnerOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.backend = options.backend ?? new ConcurrentAgentBackend(agent);
  }

  /**
   * Process a list of inputs with bounded concurrency.
   *
   * @param items - Items to process. Each must have at least `input` set.
   * @param opts - Run-level options (signal, progress callback, collectResults).
   * @returns `BatchResult` containing per-item outcomes and aggregate totals.
   *
   * ### Large-batch tip
   * For very large batches (thousands of items), holding all results in memory may
   * be impractical. Pass `collectResults: false` to skip in-memory accumulation:
   * `BatchResult.results` will be empty while `aggregate` totals remain accurate.
   * Drain results incrementally via `onProgress` instead.
   */
  async run(items: BatchItem[], opts: BatchRunOptions = {}): Promise<BatchResult> {
    const { signal, onProgress, collectResults = true } = opts;

    // Resolve items: fill in ids and sessionIds.
    const resolved: ResolvedItem[] = items.map((item, idx) => ({
      id: item.id ?? String(idx),
      input: item.input,
      userId: item.userId ?? "",
      orgId: item.orgId ?? "",
      sessionId: item.sessionId ?? crypto.randomUUID(),
    }));

    const results: BatchItemResult[] = [];
    let cancelled = false;

    // Inline aggregate accumulators used when collectResults:false to avoid
    // holding all results in memory while still tracking totals correctly.
    let inlineTotalInputTokens = 0;
    let inlineTotalOutputTokens = 0;
    let inlineTotalUsd: number | undefined;
    let inlineSuccessCount = 0;
    let inlineErrorCount = 0;

    if (resolved.length === 0) {
      return { results, aggregate: computeAggregate(results, cancelled) };
    }

    // Slot-based semaphore: run up to `concurrency` items in parallel.
    // We use a promise queue pattern: maintain a pool of `concurrency` "lanes",
    // each of which processes one item at a time and chains to the next.
    let nextIndex = 0;

    const processOne = async (): Promise<void> => {
      while (true) {
        // Check cancellation before picking the next item.
        if (signal?.aborted) {
          cancelled = true;
          return;
        }

        // Atomically claim the next item.
        const idx = nextIndex;
        if (idx >= resolved.length) return; // no more items for this lane
        nextIndex++;

        const item = resolved[idx]!;
        // Use the batch signal directly; each item gets the same signal.
        const itemSignal = signal ?? new AbortController().signal;

        let result: BatchItemResult;
        try {
          result = await this.backend.run(item, itemSignal);
        } catch (err: unknown) {
          // Backend should not throw, but defensively capture anyway.
          result = {
            status: "error",
            id: item.id,
            error: err instanceof Error ? err.message : String(err),
            sessionId: item.sessionId,
          };
        }

        if (collectResults) {
          results.push(result);
        } else {
          // Accumulate totals inline without holding the result object.
          if (result.status === "success") {
            inlineSuccessCount++;
            inlineTotalInputTokens += result.usage.inputTokens;
            inlineTotalOutputTokens += result.usage.outputTokens;
            if (result.cost?.usd !== undefined) {
              inlineTotalUsd = (inlineTotalUsd ?? 0) + result.cost.usd;
            }
          } else {
            inlineErrorCount++;
          }
        }

        onProgress?.(result);
      }
    };

    // Launch `concurrency` lanes concurrently; each drains as many items as it can.
    const lanes = Array.from({ length: Math.min(this.concurrency, resolved.length) }, () =>
      processOne(),
    );
    await Promise.all(lanes);

    // Re-check cancellation in case all lanes ended due to abort.
    if (signal?.aborted) cancelled = true;

    if (collectResults) {
      return { results, aggregate: computeAggregate(results, cancelled) };
    }

    // Build aggregate from inline accumulators (results array is empty).
    return {
      results,
      aggregate: {
        totalUsage: { inputTokens: inlineTotalInputTokens, outputTokens: inlineTotalOutputTokens },
        ...(inlineTotalUsd !== undefined ? { totalUsd: inlineTotalUsd } : {}),
        successCount: inlineSuccessCount,
        errorCount: inlineErrorCount,
        cancelled,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Aggregate helper
// ---------------------------------------------------------------------------

function computeAggregate(results: BatchItemResult[], cancelled: boolean): BatchAggregate {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalUsd: number | undefined;
  let successCount = 0;
  let errorCount = 0;

  for (const r of results) {
    if (r.status === "success") {
      successCount++;
      totalInputTokens += r.usage.inputTokens;
      totalOutputTokens += r.usage.outputTokens;
      if (r.cost?.usd !== undefined) {
        totalUsd = (totalUsd ?? 0) + r.cost.usd;
      }
    } else {
      errorCount++;
    }
  }

  return {
    totalUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
    ...(totalUsd !== undefined ? { totalUsd } : {}),
    successCount,
    errorCount,
    cancelled,
  };
}
