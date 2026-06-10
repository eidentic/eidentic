/**
 * @eidentic/server — in-process agent scheduler.
 *
 * Registers tasks that fire an agent-run callback on a fixed interval or cron
 * expression. Designed for in-process background work; persistence and
 * multi-instance leader-election are **out of scope** (no DB, no distributed
 * lock). For durable/multi-instance scheduling, pair this with a purpose-built
 * durable job queue or distributed scheduler as a follow-up.
 *
 * ## Clock / timer injection
 *
 * The scheduler accepts an optional `ClockPort` (a thin `{ now(): number }`
 * interface) and an optional `TimerPort` (wraps `setInterval` / `clearInterval`).
 * In production, the defaults delegate to the real `Date.now()` and global
 * `setInterval`. In tests, inject fakes to drive time without real sleeping.
 *
 * ## Overlap / concurrency
 *
 * If a task's previous invocation is still in flight when the next tick fires,
 * the tick is **skipped silently** — runs never pile up. This is intentional: the
 * scheduler is optimistic ("at-most-once per interval") rather than catch-up
 * ("missed runs queue up"). Document this clearly to callers.
 *
 * ## Error isolation
 *
 * Each task's run callback is invoked in its own microtask chain. An unhandled
 * rejection or thrown error is caught, logged via the injected `LoggerPort`, and
 * swallowed so that one failing task never kills the scheduler or other tasks.
 */

import { CronExpressionParser } from "cron-parser";
import type { LoggerPort } from "@eidentic/types";

// ---------------------------------------------------------------------------
// Schedule types
// ---------------------------------------------------------------------------

/**
 * Fire the task every `everyMs` milliseconds (wall-clock elapsed since the
 * last trigger, not since epoch). First fire happens after one full interval.
 */
export interface IntervalSchedule {
  kind: "interval";
  everyMs: number;
}

/**
 * Fire the task according to a standard 5-field cron expression
 * (`"* * * * *"` — minute hour dom month dow). The next run time is computed
 * by `cron-parser` from the current clock value on each tick.
 *
 * Timezone is UTC by default; pass `tz` to override.
 */
export interface CronSchedule {
  kind: "cron";
  expression: string;
  /** IANA timezone identifier, e.g. `"America/New_York"`. Defaults to UTC. */
  tz?: string;
}

/** Union of all supported schedule shapes. */
export type Schedule = IntervalSchedule | CronSchedule;

// ---------------------------------------------------------------------------
// Run callback
// ---------------------------------------------------------------------------

/** Context passed to a task's run callback on each trigger. */
export interface RunContext {
  /** The task's registered id. */
  taskId: string;
  /** Wall-clock timestamp (ms since epoch) when this trigger fired. */
  triggeredAt: number;
}

/** A function that performs the agent work for a scheduled task. */
export type RunCallback = (ctx: RunContext) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Task definition
// ---------------------------------------------------------------------------

export interface ScheduledTask {
  /** Unique identifier for this task. Used with `remove(id)`. */
  id: string;
  /** When to fire. */
  schedule: Schedule;
  /**
   * Called on each trigger. Typically invokes `agent.query(...)` with the
   * relevant input and owner scope.
   *
   * The callback runs asynchronously; errors are caught and logged.
   * If the previous invocation is still in-flight when the next tick fires,
   * this fire is **skipped** (no overlap — at-most-once-per-interval semantics).
   */
  run: RunCallback;
}

// ---------------------------------------------------------------------------
// Internal state per task
// ---------------------------------------------------------------------------

interface TaskState {
  task: ScheduledTask;
  /**
   * For interval tasks: timestamp of the last fire (or task-registration time
   * when no fire has occurred yet). The task fires when `now >= lastFiredAt + everyMs`.
   */
  lastFiredAt: number;
  /**
   * For cron tasks: the pre-computed next scheduled fire time (ms since epoch).
   * Advances to the next interval after each fire.
   */
  nextFireAt: number | null;
  /** True if a run callback is currently executing. Used for overlap-skip. */
  inFlight: boolean;
}

// ---------------------------------------------------------------------------
// Clock / timer ports (injection seams for tests)
// ---------------------------------------------------------------------------

/** Minimal clock interface — injectable for deterministic tests. */
export interface ClockPort {
  now(): number;
}

/** Injectable timer port — wraps setInterval / clearInterval. */
export interface TimerPort {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Real-clock default. */
const realClock: ClockPort = {
  now: () => Date.now(),
};

/** Real-timer default. */
const realTimer: TimerPort = {
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

// ---------------------------------------------------------------------------
// Scheduler options
// ---------------------------------------------------------------------------

export interface SchedulerOptions {
  /**
   * How often the scheduler checks for due tasks.
   * Defaults to `1000` ms (1 second). Tune lower for sub-second granularity;
   * cron resolution is 1 minute regardless (cron-parser is minute-granular).
   */
  tickIntervalMs?: number;
  /** Injectable clock — defaults to `Date.now()`. Inject a fake in tests. */
  clock?: ClockPort;
  /** Injectable timer — defaults to `globalThis.setInterval`. Inject a fake in tests. */
  timer?: TimerPort;
  /**
   * Structured logger for task error reporting.
   * Pass `NoopLogger` to silence all output.
   * Defaults to a minimal `console.error` shim.
   */
  logger?: LoggerPort;
}

// ---------------------------------------------------------------------------
// Default logger (console shim — swaps out in production via injection)
// ---------------------------------------------------------------------------

function defaultLogger(): LoggerPort {
  return {
    log(level, namespace, message, fields) {
      if (level === "error" || level === "warn") {
        console.error(`[${level.toUpperCase()}] ${namespace}: ${message}`, fields ?? "");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * In-process agent scheduler.
 *
 * ```ts
 * const scheduler = new Scheduler({ logger: myLogger });
 *
 * scheduler.add({
 *   id: "digest",
 *   schedule: { kind: "cron", expression: "0 9 * * *", tz: "America/New_York" },
 *   run: async () => {
 *     for await (const _ of agent.query("Generate daily digest", { sessionId: crypto.randomUUID() })) {}
 *   },
 * });
 *
 * scheduler.start();
 * // …
 * scheduler.stop();
 * ```
 *
 * ### Overlap skip
 * If a task's previous run is still in flight when its next fire time arrives,
 * the tick is silently skipped. This prevents unbounded pile-up on slow tasks.
 *
 * ### Error isolation
 * Each task's `run` callback error is caught and logged; it does NOT propagate
 * to the scheduler or affect other tasks.
 *
 * ### Persistence / distribution
 * This is a **purely in-process** scheduler — state lives in memory, is lost
 * on restart, and is NOT coordinated across multiple instances. For durable or
 * multi-instance scheduling, wire an external queue/workflow engine.
 */
export class Scheduler {
  private readonly tickIntervalMs: number;
  private readonly clock: ClockPort;
  private readonly timer: TimerPort;
  private readonly logger: LoggerPort;

  private readonly tasks = new Map<string, TaskState>();
  private timerHandle: unknown = null;
  private running = false;

  constructor(opts: SchedulerOptions = {}) {
    this.tickIntervalMs = opts.tickIntervalMs ?? 1000;
    this.clock = opts.clock ?? realClock;
    this.timer = opts.timer ?? realTimer;
    this.logger = opts.logger ?? defaultLogger();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the scheduler's internal tick loop.
   * Calling `start()` while already running is a no-op.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.timerHandle = this.timer.setInterval(() => {
      this.tick(this.clock.now());
    }, this.tickIntervalMs);
  }

  /**
   * Stop the scheduler. All in-flight callbacks are allowed to complete
   * (they are not aborted), but no new runs will be triggered.
   * Calling `stop()` while not running is a no-op.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timerHandle !== null) {
      this.timer.clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Task management
  // ---------------------------------------------------------------------------

  /**
   * Register a scheduled task. If a task with the same `id` already exists,
   * it is replaced (the old state is discarded).
   *
   * For cron tasks, the first next-fire time is computed immediately from the
   * current clock value.
   */
  add(task: ScheduledTask): void {
    const now = this.clock.now();
    let nextFireAt: number | null = null;

    if (task.schedule.kind === "cron") {
      // Validate the cron expression eagerly — throw synchronously on invalid input
      // so callers discover misconfiguration at registration time, not silently at runtime.
      validateCronExpression(task.schedule.expression);
      nextFireAt = computeNextCron(task.schedule, now, this.logger);
    }

    this.tasks.set(task.id, {
      task,
      lastFiredAt: now,
      nextFireAt,
      inFlight: false,
    });
  }

  /**
   * Remove a registered task by id.
   * Any in-flight callback for this task will be allowed to complete, but no
   * further fires will occur.
   * Returns `true` if the task was found and removed, `false` otherwise.
   */
  remove(id: string): boolean {
    return this.tasks.delete(id);
  }

  /** Returns the ids of all currently registered tasks. */
  taskIds(): string[] {
    return [...this.tasks.keys()];
  }

  // ---------------------------------------------------------------------------
  // Tick — can be called manually in tests
  // ---------------------------------------------------------------------------

  /**
   * Evaluate all registered tasks against the given timestamp and fire any
   * that are due.
   *
   * This is the core scheduling method. The `start()` loop calls it
   * automatically at `tickIntervalMs` granularity, but tests can call it
   * directly to drive time without real timers.
   */
  tick(now: number): void {
    for (const state of this.tasks.values()) {
      if (isDue(state, now)) {
        this._fire(state, now);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal fire
  // ---------------------------------------------------------------------------

  private _fire(state: TaskState, now: number): void {
    // Overlap-skip: if previous run is still in-flight, skip this tick.
    if (state.inFlight) {
      this.logger.log("debug", "scheduler", "task skipped (overlap)", {
        taskId: state.task.id,
        now,
      });
      return;
    }

    // Update scheduling state before firing so the *next* tick can correctly
    // see the task as "already fired" even if the callback is slow.
    state.inFlight = true;
    state.lastFiredAt = now;

    // Advance cron next-fire-at.
    if (state.task.schedule.kind === "cron") {
      state.nextFireAt = computeNextCron(state.task.schedule, now, this.logger);
    }

    const ctx: RunContext = { taskId: state.task.id, triggeredAt: now };

    // Run in a detached microtask chain; errors are isolated.
    Promise.resolve()
      .then(() => state.task.run(ctx))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.log("error", "scheduler", "task run failed", {
          taskId: state.task.id,
          error: msg,
          stack: err instanceof Error ? err.stack : undefined,
        });
      })
      .finally(() => {
        state.inFlight = false;
      });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDue(state: TaskState, now: number): boolean {
  const { task } = state;
  if (task.schedule.kind === "interval") {
    return now >= state.lastFiredAt + task.schedule.everyMs;
  }
  // cron
  if (state.nextFireAt === null) return false;
  return now >= state.nextFireAt;
}

/**
 * Validate that `expression` can be parsed by cron-parser. Throws a clear
 * `Error` on failure so callers see the problem at registration time rather
 * than silently never firing.
 */
function validateCronExpression(expression: string): void {
  try {
    CronExpressionParser.parse(expression, { tz: "UTC" });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Invalid cron expression "${expression}": ${detail}`,
    );
  }
}

/**
 * Compute the next fire timestamp (ms since epoch) for a cron schedule,
 * starting from `afterMs` (ms since epoch).
 *
 * `cron-parser` works in second-granularity when given a Date, so we
 * construct a Date from `afterMs` and ask for the next interval.
 *
 * Runtime parse errors (which should not occur after upfront validation in
 * `add()`) are logged through the injected logger and return `null`.
 */
function computeNextCron(schedule: CronSchedule, afterMs: number, logger: LoggerPort): number | null {
  try {
    const expr = CronExpressionParser.parse(schedule.expression, {
      currentDate: new Date(afterMs),
      tz: schedule.tz ?? "UTC",
    });
    return expr.next().getTime();
  } catch (err) {
    // Should not normally reach here after validateCronExpression, but guard
    // against edge cases (e.g. timezone string invalid at runtime).
    logger.log("error", "scheduler", "failed to compute next cron time", {
      expression: schedule.expression,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
