---
"@eidentic/server": minor
---

Add in-process `Scheduler` to `@eidentic/server` for background agent runs.

Registers tasks with an interval (`{ kind: "interval", everyMs }`) or cron expression (`{ kind: "cron", expression, tz? }`) and fires a `RunCallback` on each trigger. Uses `cron-parser` for next-run computation.

Key semantics:
- **Overlap skip**: if a task's previous invocation is still in-flight when the next tick fires, the tick is silently skipped (at-most-once-per-interval, not catch-up).
- **Error isolation**: each task's callback is wrapped in a detached promise chain; errors are caught and logged via the injected `LoggerPort` without affecting the scheduler or other tasks.
- **Injectable clock + timer**: `ClockPort` and `TimerPort` are dependency-injected seams for deterministic testing without real timers.
- **Lifecycle**: `start()` / `stop()` (both idempotent), `add(task)` / `remove(id)`.

This is an **in-process** scheduler only — state is memory-resident and not coordinated across instances. Durable/multi-instance scheduling (survive restart, leader election) is a planned follow-up.
