---
"@eidentic/langfuse": minor
---

Add `@eidentic/langfuse` — Langfuse OTLP adapter for Eidentic agent traces.

`langfuseTracer({ publicKey, secretKey })` returns a `TracerPort` that can be passed directly to `new Agent({ tracer })`. Completed spans are buffered in memory and flushed to Langfuse's OTLP/HTTP endpoint (`/api/public/otel/v1/traces`) using Basic auth — the only runtime dependency is `fetch`.

All GenAI Semantic Convention attributes set by the Eidentic loop (`gen_ai.usage.*`, `gen_ai.request.model`, `gen_ai.tool.name`, `eidentic.cost_usd`, etc.) are forwarded as-is so Langfuse's model/token dashboards populate automatically. Spans are batched (configurable `flushAt`/`flushInterval`), and network errors are silently dropped to avoid crashing the agent. Call `tracer.shutdown()` on process exit to flush remaining spans.
