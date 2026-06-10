---
"@eidentic/types": minor
"@eidentic/core": minor
---

Add pluggable `LoggerPort` with silent-default `envLogger` gated by `DEBUG=eidentic:*` and secret redaction.

**`@eidentic/types`** — new `logging.ts` exports `LogLevel`, `LogFields`, `LoggerPort`.

**`@eidentic/core`** — new `logger.ts` exports:
- `NoopLogger` — all-no-op, `enabled()` always false. Silent default when `DEBUG` is unset and no logger injected.
- `envLogger()` — reads `process.env.DEBUG` once at construction; debug/info emitted only for matching namespace globs (e.g. `eidentic:*`, `eidentic:loop,eidentic:tool`); warn/error always print to stderr regardless. Safe for edge runtimes (guards `typeof process`).
- `redactFields(fields)` — masks field values whose key matches `/key|token|secret|password|authorization|bearer|api[_-]?key|credential/i`, or whose string value starts with `sk-` or `Bearer `.
- `AgentConfig.logger?: LoggerPort` — when unset, defaults to `envLogger()` (silent unless `DEBUG` is set).
- Debug logs emitted at: `eidentic:loop` (model call, result subtype+usage, abort), `eidentic:tool` (dispatch, result ok/error, durable-skip), `eidentic:permission` (allow/deny + reason), `eidentic:cost` (preflight abort, USD-ceiling misconfiguration warn), `eidentic:memory` (retrieve hits count).
- Two existing `console.warn` calls (keyless destructive tool under durable in `tool.ts`, maxCostUsd without prices in `loop.ts`) are now routed through the injected logger — warn still prints to stderr by default, preserving existing behavior.

Prod usage: inject pino/datadog at `info+`; OTel still covers tracing.
