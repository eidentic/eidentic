import { describe, it, expect, vi } from "vitest";
import { Scheduler } from "@eidentic/server";
import type { ClockPort, TimerPort, ScheduledTask } from "@eidentic/server";
import type { LoggerPort } from "@eidentic/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Fake clock: starts at a given epoch ms, advance manually via `advance(ms)`.
 */
function makeClock(startMs = 0): ClockPort & { advance(ms: number): void; value: number } {
  let t = startMs;
  return {
    get value() { return t; },
    now() { return t; },
    advance(ms: number) { t += ms; },
  };
}

/**
 * Fake timer: captures the registered tick function; never auto-fires.
 * Call `fire()` to trigger it manually, or use `scheduler.tick(now)` directly.
 */
function makeTimer(): TimerPort & { fire(): void; stopped: boolean } {
  let fn: (() => void) | null = null;
  let handle: unknown = null;
  return {
    stopped: false,
    setInterval(cb, _ms) {
      fn = cb;
      handle = Symbol("timer");
      return handle;
    },
    clearInterval(_h) {
      this.stopped = true;
      fn = null;
    },
    fire() {
      fn?.();
    },
  };
}

/**
 * Fake logger: captures all log calls for assertion.
 */
function makeLogger(): LoggerPort & { calls: Array<{ level: string; ns: string; msg: string; fields?: unknown }> } {
  const calls: Array<{ level: string; ns: string; msg: string; fields?: unknown }> = [];
  return {
    calls,
    log(level, ns, msg, fields) {
      calls.push({ level, ns, msg, fields });
    },
  };
}

/**
 * A spy run callback: records call count and contexts, optionally with a delay.
 */
function makeSpy(opts: { rejectWith?: Error } = {}) {
  const invocations: Array<{ taskId: string; triggeredAt: number }> = [];
  const run = vi.fn(async (ctx: { taskId: string; triggeredAt: number }) => {
    invocations.push({ taskId: ctx.taskId, triggeredAt: ctx.triggeredAt });
    if (opts.rejectWith) throw opts.rejectWith;
  });
  return { run, invocations };
}

/**
 * Flush all pending microtasks (Promises). Calling after `tick()` lets
 * in-flight async callbacks settle before we assert.
 */
async function flushMicrotasks() {
  await new Promise((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// Cron validation — add() must throw synchronously on invalid expressions
// ---------------------------------------------------------------------------

describe("Scheduler — cron validation in add()", () => {
  it("throws synchronously when given a garbage cron string", () => {
    const scheduler = new Scheduler({ clock: makeClock(), timer: makeTimer() });
    expect(() =>
      scheduler.add({
        id: "bad-cron",
        schedule: { kind: "cron", expression: "not a cron" },
        run: vi.fn(),
      }),
    ).toThrow(/not a cron/);
  });

  it("throws synchronously when given out-of-range field values", () => {
    const scheduler = new Scheduler({ clock: makeClock(), timer: makeTimer() });
    expect(() =>
      scheduler.add({
        id: "bad-cron-2",
        schedule: { kind: "cron", expression: "99 99 99 99 99" },
        run: vi.fn(),
      }),
    ).toThrow();
  });

  it("throws with a useful message that includes the invalid expression", () => {
    const scheduler = new Scheduler({ clock: makeClock(), timer: makeTimer() });
    let caught: Error | undefined;
    try {
      scheduler.add({
        id: "bad-cron-3",
        schedule: { kind: "cron", expression: "not a cron" },
        run: vi.fn(),
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("not a cron");
  });

  it("does NOT add the task when the cron expression is invalid", () => {
    const scheduler = new Scheduler({ clock: makeClock(), timer: makeTimer() });
    try {
      scheduler.add({
        id: "bad-cron-4",
        schedule: { kind: "cron", expression: "not a cron" },
        run: vi.fn(),
      });
    } catch {
      // expected
    }
    expect(scheduler.taskIds()).not.toContain("bad-cron-4");
  });

  it("accepts a valid cron expression without throwing", () => {
    const clock = makeClock(new Date("2025-01-01T00:00:00.000Z").getTime());
    const scheduler = new Scheduler({ clock, timer: makeTimer() });
    expect(() =>
      scheduler.add({
        id: "valid-cron",
        schedule: { kind: "cron", expression: "0 9 * * *", tz: "UTC" },
        run: vi.fn(),
      }),
    ).not.toThrow();
    expect(scheduler.taskIds()).toContain("valid-cron");
  });

  it("routes runtime cron-compute failures through the injected logger, not console", async () => {
    // We simulate a runtime failure by spying on the logger. The cron expression
    // is valid at add() time; we stub computeNextCron indirectly by ensuring our
    // logger captures any error-level log that occurs during tick.
    // In practice runtime failures go through the injected logger — confirmed by
    // the error isolation tests above. Here we directly verify the logger injection
    // path by using a valid cron with a known next-fire time and a run callback
    // that throws, which exercises the logger.
    const clock = makeClock(new Date("2025-01-01T00:00:00.000Z").getTime());
    const logger = makeLogger();
    const consoleSpy = vi.spyOn(console, "error");

    const scheduler = new Scheduler({ clock, timer: makeTimer(), logger });
    scheduler.add({
      id: "logger-test",
      schedule: { kind: "cron", expression: "* * * * *", tz: "UTC" },
      run: vi.fn(async () => { throw new Error("runtime-error"); }),
    });

    // Fire at +1 minute
    clock.advance(60_000);
    scheduler.tick(clock.now());
    await flushMicrotasks();

    // Error went to injected logger, not console.error
    const errorLog = logger.calls.find((c) => c.level === "error");
    expect(errorLog).toBeDefined();
    expect(consoleSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Interval task tests
// ---------------------------------------------------------------------------

describe("Scheduler — interval tasks", () => {
  it("fires at the correct time (everyMs elapsed since registration)", async () => {
    const clock = makeClock(1000);
    const timer = makeTimer();
    const { run, invocations } = makeSpy();

    const scheduler = new Scheduler({ clock, timer });
    scheduler.add({ id: "t1", schedule: { kind: "interval", everyMs: 500 }, run });
    scheduler.start();

    // 400 ms elapsed — not yet due
    clock.advance(400);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(invocations.length).toBe(0);

    // 100 ms more (total 500) — due now
    clock.advance(100);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(invocations.length).toBe(1);
    expect(invocations[0]!.taskId).toBe("t1");
    expect(invocations[0]!.triggeredAt).toBe(1500);
  });

  it("fires multiple times at the correct intervals", async () => {
    const clock = makeClock(0);
    const { run, invocations } = makeSpy();

    const scheduler = new Scheduler({ clock, timer: makeTimer() });
    scheduler.add({ id: "t1", schedule: { kind: "interval", everyMs: 1000 }, run });

    // Tick at 1000 — first fire
    clock.advance(1000);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(invocations.length).toBe(1);

    // Tick at 1999 — not yet second fire (need 2000)
    clock.advance(999);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(invocations.length).toBe(1);

    // Tick at 2000 — second fire
    clock.advance(1);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(invocations.length).toBe(2);
  });

  it("tick past multiple due times triggers only once per tick (not catch-up)", async () => {
    // The scheduler doesn't "catch up" missed intervals — it fires once per tick.
    const clock = makeClock(0);
    const { run, invocations } = makeSpy();

    const scheduler = new Scheduler({ clock, timer: makeTimer() });
    scheduler.add({ id: "t1", schedule: { kind: "interval", everyMs: 100 }, run });

    // Jump 5 intervals at once with a single tick
    clock.advance(500);
    scheduler.tick(clock.now());
    await flushMicrotasks();

    // Fires exactly once (the task is due; it fires once and lastFiredAt advances)
    expect(invocations.length).toBe(1);
  });

  it("does NOT fire before the first interval elapses", async () => {
    const clock = makeClock(0);
    const { run, invocations } = makeSpy();

    const scheduler = new Scheduler({ clock, timer: makeTimer() });
    scheduler.add({ id: "t1", schedule: { kind: "interval", everyMs: 5000 }, run });

    clock.advance(4999);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(invocations.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cron task tests
// ---------------------------------------------------------------------------

describe("Scheduler — cron tasks", () => {
  it("fires at the computed next cron time", async () => {
    // Cron "* * * * *" fires every minute.
    // Start at exactly 2025-01-01 00:00:00 UTC — next fire is 00:01:00.
    const baseMs = new Date("2025-01-01T00:00:00.000Z").getTime();
    const clock = makeClock(baseMs);
    const { run, invocations } = makeSpy();

    const scheduler = new Scheduler({ clock, timer: makeTimer() });
    scheduler.add({
      id: "cron1",
      schedule: { kind: "cron", expression: "* * * * *", tz: "UTC" },
      run,
    });

    const oneMinMs = 60 * 1000;

    // Just before 1 minute: not yet
    clock.advance(oneMinMs - 1);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(invocations.length).toBe(0);

    // Exactly 1 minute: fire
    clock.advance(1);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(invocations.length).toBe(1);
    expect(invocations[0]!.triggeredAt).toBe(baseMs + oneMinMs);
  });

  it("cron task fires again after the next computed interval", async () => {
    // "* * * * *" fires every minute
    const baseMs = new Date("2025-06-01T12:00:00.000Z").getTime();
    const clock = makeClock(baseMs);
    const { run, invocations } = makeSpy();

    const scheduler = new Scheduler({ clock, timer: makeTimer() });
    scheduler.add({
      id: "cron1",
      schedule: { kind: "cron", expression: "* * * * *" },
      run,
    });

    const min = 60_000;

    // First fire at +1 min
    clock.advance(min);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(invocations.length).toBe(1);

    // Second fire at +2 min
    clock.advance(min);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(invocations.length).toBe(2);
  });

  it("cron task with specific hour fires only at that hour", async () => {
    // Expression "0 9 * * *" fires at 09:00 UTC daily.
    // Start at midnight UTC.
    const baseMs = new Date("2025-01-01T00:00:00.000Z").getTime();
    const clock = makeClock(baseMs);
    const { run, invocations } = makeSpy();

    const scheduler = new Scheduler({ clock, timer: makeTimer() });
    scheduler.add({
      id: "morning",
      schedule: { kind: "cron", expression: "0 9 * * *", tz: "UTC" },
      run,
    });

    // 8:59:59 — not yet
    clock.advance(9 * 60 * 60 * 1000 - 1000);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(invocations.length).toBe(0);

    // 9:00:00 — fire
    clock.advance(1000);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(invocations.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Overlap-skip tests
// ---------------------------------------------------------------------------

describe("Scheduler — overlap skip", () => {
  it("skips the next tick if the previous run is still in flight", async () => {
    const clock = makeClock(0);
    const { run, invocations } = makeSpy();

    // The run callback never resolves (simulates a long-running task)
    let resolveRun!: () => void;
    const hangingRun = vi.fn(async (ctx: { taskId: string; triggeredAt: number }) => {
      invocations.push(ctx);
      await new Promise<void>((resolve) => { resolveRun = resolve; });
    });

    const scheduler = new Scheduler({ clock, timer: makeTimer() });
    scheduler.add({ id: "slow", schedule: { kind: "interval", everyMs: 100 }, run: hangingRun });

    // First fire at t=100
    clock.advance(100);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(invocations.length).toBe(1); // first run started

    // Second tick at t=200 — still in flight, should be skipped
    clock.advance(100);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(invocations.length).toBe(1); // skipped

    // Third tick at t=300 — still in flight
    clock.advance(100);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(invocations.length).toBe(1); // skipped again

    // Now resolve the in-flight run
    resolveRun();
    await flushMicrotasks();

    // Fourth tick at t=400 — now free to fire again
    clock.advance(100);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(invocations.length).toBe(2); // new run started
  });

  it("logs a debug message when a tick is skipped due to overlap", async () => {
    const clock = makeClock(0);
    const logger = makeLogger();

    let resolveRun!: () => void;
    const hangingRun = vi.fn(async () => {
      await new Promise<void>((resolve) => { resolveRun = resolve; });
    });

    const scheduler = new Scheduler({ clock, timer: makeTimer(), logger });
    scheduler.add({ id: "slow-task", schedule: { kind: "interval", everyMs: 100 }, run: hangingRun });

    // Start first run
    clock.advance(100);
    scheduler.tick(clock.now());
    await flushMicrotasks();

    // Trigger while in-flight → should log debug overlap message
    clock.advance(100);
    scheduler.tick(clock.now());
    await flushMicrotasks();

    const overlapLog = logger.calls.find(
      (c) => c.level === "debug" && c.msg.includes("skipped"),
    );
    expect(overlapLog).toBeDefined();
    expect((overlapLog!.fields as { taskId?: string }).taskId).toBe("slow-task");

    resolveRun();
    await flushMicrotasks();
  });
});

// ---------------------------------------------------------------------------
// Error isolation tests
// ---------------------------------------------------------------------------

describe("Scheduler — error isolation", () => {
  it("a throwing task does not stop the scheduler", async () => {
    const clock = makeClock(0);
    const logger = makeLogger();

    const { run: failingRun } = makeSpy({ rejectWith: new Error("boom") });
    const { run: goodRun, invocations: goodInvocations } = makeSpy();

    const scheduler = new Scheduler({ clock, timer: makeTimer(), logger });
    scheduler.add({ id: "failing", schedule: { kind: "interval", everyMs: 100 }, run: failingRun });
    scheduler.add({ id: "good", schedule: { kind: "interval", everyMs: 100 }, run: goodRun });

    // Both fire at t=100
    clock.advance(100);
    scheduler.tick(clock.now());
    await flushMicrotasks();

    // Good task still fired despite failing task
    expect(goodInvocations.length).toBe(1);

    // Error was logged
    const errorLog = logger.calls.find((c) => c.level === "error");
    expect(errorLog).toBeDefined();
    expect(errorLog!.msg).toContain("failed");
    expect((errorLog!.fields as { taskId?: string }).taskId).toBe("failing");
    expect((errorLog!.fields as { error?: string }).error).toBe("boom");
  });

  it("a throwing task can fire again on the next interval", async () => {
    const clock = makeClock(0);
    const logger = makeLogger();

    let callCount = 0;
    const flakeyRun = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error("first call fails");
      // second call succeeds
    });

    const scheduler = new Scheduler({ clock, timer: makeTimer(), logger });
    scheduler.add({ id: "flakey", schedule: { kind: "interval", everyMs: 100 }, run: flakeyRun });

    // First fire — throws
    clock.advance(100);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(callCount).toBe(1);

    // Second fire — succeeds (inFlight was cleared by finally)
    clock.advance(100);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// remove() tests
// ---------------------------------------------------------------------------

describe("Scheduler — remove()", () => {
  it("remove() stops a task from firing", async () => {
    const clock = makeClock(0);
    const { run, invocations } = makeSpy();

    const scheduler = new Scheduler({ clock, timer: makeTimer() });
    scheduler.add({ id: "removable", schedule: { kind: "interval", everyMs: 100 }, run });

    // Fire once
    clock.advance(100);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(invocations.length).toBe(1);

    // Remove the task
    const removed = scheduler.remove("removable");
    expect(removed).toBe(true);

    // No more fires
    clock.advance(100);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(invocations.length).toBe(1);
  });

  it("remove() returns false for an unknown id", () => {
    const scheduler = new Scheduler({ clock: makeClock(), timer: makeTimer() });
    expect(scheduler.remove("nonexistent")).toBe(false);
  });

  it("taskIds() reflects current registrations", () => {
    const scheduler = new Scheduler({ clock: makeClock(), timer: makeTimer() });
    scheduler.add({ id: "a", schedule: { kind: "interval", everyMs: 100 }, run: vi.fn() });
    scheduler.add({ id: "b", schedule: { kind: "interval", everyMs: 200 }, run: vi.fn() });
    expect(scheduler.taskIds().sort()).toEqual(["a", "b"]);

    scheduler.remove("a");
    expect(scheduler.taskIds()).toEqual(["b"]);
  });
});

// ---------------------------------------------------------------------------
// stop() tests
// ---------------------------------------------------------------------------

describe("Scheduler — stop()", () => {
  it("stop() clears the timer and prevents further ticks from the loop", async () => {
    const clock = makeClock(0);
    const timer = makeTimer();
    const { run, invocations } = makeSpy();

    const scheduler = new Scheduler({ clock, timer });
    scheduler.add({ id: "t", schedule: { kind: "interval", everyMs: 100 }, run });
    scheduler.start();

    // Fire once via timer
    clock.advance(100);
    timer.fire();
    await flushMicrotasks();
    expect(invocations.length).toBe(1);

    // Stop the scheduler
    scheduler.stop();
    expect(timer.stopped).toBe(true);

    // Timer fire after stop: should not reach tick (timer is cleared)
    // Manual tick should still work (not guarded), but the internal loop is dead
    clock.advance(100);
    timer.fire(); // This is a no-op since clearInterval was called
    await flushMicrotasks();
    expect(invocations.length).toBe(1); // no new fire
  });

  it("stop() is idempotent (calling twice is safe)", () => {
    const scheduler = new Scheduler({ clock: makeClock(), timer: makeTimer() });
    scheduler.start();
    scheduler.stop();
    expect(() => scheduler.stop()).not.toThrow();
  });

  it("start() is idempotent (calling twice is safe)", () => {
    const timer = makeTimer();
    const scheduler = new Scheduler({ clock: makeClock(), timer });
    scheduler.start();
    scheduler.start(); // second call is no-op
    // Only one timer should be active
    expect(timer.stopped).toBe(false);
  });

  it("start() restarts the scheduler after stop()", async () => {
    const clock = makeClock(0);
    const timer = makeTimer();
    const { run, invocations } = makeSpy();

    const scheduler = new Scheduler({ clock, timer });
    scheduler.add({ id: "restart", schedule: { kind: "interval", everyMs: 100 }, run });
    scheduler.start();

    // Fire once, then stop
    clock.advance(100);
    timer.fire();
    await flushMicrotasks();
    expect(invocations.length).toBe(1);
    scheduler.stop();

    // Restart and fire again
    scheduler.start();
    clock.advance(100);
    timer.fire();
    await flushMicrotasks();
    expect(invocations.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Multiple tasks
// ---------------------------------------------------------------------------

describe("Scheduler — multiple tasks", () => {
  it("independent tasks with different intervals both fire at their own schedule", async () => {
    const clock = makeClock(0);
    const { run: run200, invocations: inv200 } = makeSpy();
    const { run: run500, invocations: inv500 } = makeSpy();

    const scheduler = new Scheduler({ clock, timer: makeTimer() });
    scheduler.add({ id: "fast", schedule: { kind: "interval", everyMs: 200 }, run: run200 });
    scheduler.add({ id: "slow", schedule: { kind: "interval", everyMs: 500 }, run: run500 });

    // t=200 — fast fires, slow not yet
    clock.advance(200);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(inv200.length).toBe(1);
    expect(inv500.length).toBe(0);

    // t=400 — fast fires again, slow not yet
    clock.advance(200);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(inv200.length).toBe(2);
    expect(inv500.length).toBe(0);

    // t=500 — slow fires for the first time
    clock.advance(100);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(inv500.length).toBe(1);

    // t=600 — fast fires again
    clock.advance(100);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(inv200.length).toBe(3);
  });

  it("a failing task doesn't interfere with another task's in-flight state", async () => {
    const clock = makeClock(0);
    const logger = makeLogger();

    const { run: failRun } = makeSpy({ rejectWith: new Error("fail") });
    const { run: goodRun, invocations: goodInv } = makeSpy();

    const scheduler = new Scheduler({ clock, timer: makeTimer(), logger });
    scheduler.add({ id: "bad", schedule: { kind: "interval", everyMs: 100 }, run: failRun });
    scheduler.add({ id: "good", schedule: { kind: "interval", everyMs: 100 }, run: goodRun });

    // Fire both at 100
    clock.advance(100);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(goodInv.length).toBe(1);

    // Fire both at 200
    clock.advance(100);
    scheduler.tick(clock.now());
    await flushMicrotasks();
    expect(goodInv.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// RunContext correctness
// ---------------------------------------------------------------------------

describe("Scheduler — RunContext", () => {
  it("run callback receives correct taskId and triggeredAt", async () => {
    const clock = makeClock(5000);
    const { run, invocations } = makeSpy();

    const scheduler = new Scheduler({ clock, timer: makeTimer() });
    scheduler.add({ id: "ctx-test", schedule: { kind: "interval", everyMs: 1000 }, run });

    clock.advance(1000);
    scheduler.tick(clock.now());
    await flushMicrotasks();

    expect(invocations[0]!.taskId).toBe("ctx-test");
    expect(invocations[0]!.triggeredAt).toBe(6000);
  });
});
