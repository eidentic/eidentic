# @eidentic/langfuse

Export Eidentic agent traces to [Langfuse](https://langfuse.com) with zero extra dependencies.

`langfuseTracer` implements Eidentic's `TracerPort` interface, so it can be passed directly to `new Agent({ tracer })`. Spans are buffered in memory and flushed to Langfuse's [OTLP/HTTP endpoint](https://langfuse.com/integrations/native/opentelemetry) (`/api/public/otel/v1/traces`) using Basic auth — the only runtime dependency is `fetch`.

## Installation

```bash
npm install @eidentic/langfuse
```

## Usage

```ts
import { Agent } from "@eidentic/core";
import { langfuseTracer } from "@eidentic/langfuse";
import { AIModel } from "@eidentic/model";
import { SqliteStore } from "@eidentic/sqlite";
import { openai } from "@ai-sdk/openai";

const model = new AIModel(openai("gpt-4o-mini"));
const store = new SqliteStore();

const tracer = langfuseTracer({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
  secretKey: process.env.LANGFUSE_SECRET_KEY!,
  // Optional — defaults to https://cloud.langfuse.com (EU)
  // baseUrl: "https://us.cloud.langfuse.com",
});

const agent = new Agent({
  id: "my-agent",
  model,
  store,
  tracer,
});

for await (const event of agent.query("Hello!", { sessionId: "s-1" })) {
  if (event.type === "result") console.log(event.usage);
}

// Flush remaining spans and cancel the auto-flush timer on process exit.
await tracer.shutdown();
```

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `publicKey` | `string` | required | Langfuse project public key (`pk-lf-…`) |
| `secretKey` | `string` | required | Langfuse project secret key (`sk-lf-…`) |
| `baseUrl` | `string` | `https://cloud.langfuse.com` | Langfuse base URL (no trailing slash). Use `https://us.cloud.langfuse.com` for the US region, or your self-hosted URL. |
| `flushAt` | `number` | `20` | Buffer size threshold that triggers an automatic flush. |
| `flushInterval` | `number` | `5000` | Max milliseconds between automatic flushes. |
| `fetchImpl` | `typeof fetch` | `globalThis.fetch` | Override the fetch implementation (useful in tests). |

## Spans emitted by Eidentic

The following span names are produced by `@eidentic/core` and will appear in Langfuse:

| Span name | Key attributes |
|---|---|
| `gen_ai.invoke_agent` | `gen_ai.agent.id`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cached_input_tokens`, `eidentic.cost_usd`, `eidentic.kv_cache_hit_rate` |
| `gen_ai.chat` | `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` |
| `gen_ai.execute_tool` | `gen_ai.tool.name` |
| `memory.ingest` | `eidentic.scope` |
| `memory.retrieve` | `eidentic.scope` |

All GenAI Semantic Convention attributes (`gen_ai.*`) are passed through unchanged, so Langfuse's model/token dashboards populate automatically.

## Transport

Spans are sent to `{baseUrl}/api/public/otel/v1/traces` as `POST` requests with:

- `Content-Type: application/json`
- `Authorization: Basic <base64(publicKey:secretKey)>`
- `x-langfuse-ingestion-version: 4`
- Body: standard [OTLP/HTTP JSON](https://opentelemetry.io/docs/specs/otlp/#otlphttp-request) (`ExportTraceServiceRequest`)

Network errors are silently dropped to avoid crashing the agent.
