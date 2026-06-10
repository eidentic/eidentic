---
"@eidentic/types": minor
"@eidentic/core": minor
---

Add the **Cost Governor** (§11.2) and **OpenTelemetry tracing** (§11.1).

The cost governor enforces hard ceilings — `maxTokens`, `maxCostUsd`, `maxWallClockMs`, `maxTurns` — *before each model call*, in the critical path, outside agent code. Crossing a ceiling aborts the run with a matching termination subtype (`max_tokens` / `max_cost` / `max_wall_clock` / `max_turns`). A `softCostUsd` cap fires a one-shot `onCostThreshold` hook without aborting. Every terminal `result` event now carries a transparent `CostBreakdown` (`foreground` / `background` / `cachedInputTokens` / `usd`). Configure via `new Agent({ policy, prices, modelId, onCostThreshold })`.

OpenTelemetry GenAI semantic-convention spans are emitted for every loop stage via a swappable `TracerPort` (`gen_ai.invoke_agent`, `gen_ai.chat`, `gen_ai.execute_tool`, plus Eidentic `memory.retrieve` / `memory.ingest`), with attributes including `gen_ai.agent.id`, `gen_ai.request.model`, `gen_ai.usage.*`, `eidentic.scope`, and `eidentic.cost_usd`. A zero-config `InMemoryTracer` ships in `@eidentic/types/testing`; point `tracer` at an OTLP adapter in production. With no `policy`/`tracer`, the loop is unchanged.

Deferred to later plans: model routing/cascade and `prepareStep` per-step model choice, progress-gated retries, a real `@opentelemetry/*` OTLP exporter package, whole-agent-tree budget aggregation, and the eval harness (§11.3).
