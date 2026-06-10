---
title: Observability
description: Langfuse OTLP exporter options and MCP governance — tracing agent runs, redacting attributes, and auditing tool calls.
---

Eidentic instruments the agent loop via a `TracerPort` interface. Wire in any OTLP-compatible backend without changing your agent code.

## Langfuse exporter

`@eidentic/langfuse` implements `TracerPort` and ships spans to Langfuse's OTLP/HTTP endpoint using standard Basic auth — no extra SDK required.

```bash
npm install @eidentic/langfuse
```

```ts
import { Agent } from "@eidentic/core";
import { langfuseTracer } from "@eidentic/langfuse";

const tracer = langfuseTracer({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
  secretKey: process.env.LANGFUSE_SECRET_KEY!,
  // baseUrl defaults to https://cloud.langfuse.com (EU)
  // US: "https://us.cloud.langfuse.com"
  // self-hosted: your Langfuse URL
});

const agent = new Agent({
  id: "assistant",
  model,
  store,
  tracer,
});

// On process exit — flush buffered spans and stop the timer
process.on("SIGTERM", async () => {
  await tracer.shutdown();
  process.exit(0);
});
```

### Options (`LangfuseTracerOptions`)

| Option | Type | Default | Description |
|---|---|---|---|
| `publicKey` | `string` | required | Langfuse project public key (`pk-lf-…`) |
| `secretKey` | `string` | required | Langfuse project secret key (`sk-lf-…`) |
| `baseUrl` | `string` | `https://cloud.langfuse.com` | Self-hosted or regional endpoint (no trailing slash) |
| `flushAt` | `number` | `20` | Spans to buffer before auto-flushing |
| `flushInterval` | `number` | `5000` | Max ms between auto-flushes |
| `maxBufferSize` | `number` | `10000` | Max spans in memory; oldest are dropped when exceeded |
| `redactAttributes` | `(attrs) => attrs` | `undefined` | Callback to scrub/mask span attributes before export |
| `onFlushError` | `(err, count) => void` | `undefined` | Called when a flush fails; `count` = dropped spans |

### Security: `redactAttributes`

**This option is important for production deployments.** Span attributes contain prompt text, tool arguments, and model outputs. If your Langfuse project is shared or subject to data-minimisation requirements, supply a redactor:

```ts
const tracer = langfuseTracer({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
  secretKey: process.env.LANGFUSE_SECRET_KEY!,
  redactAttributes: (attrs) =>
    attrs
      .filter(({ key }) => !key.startsWith("llm.prompt"))
      .map(({ key, value }) =>
        key === "llm.user.id"
          ? { key, value: "[redacted]" }
          : { key, value }
      ),
  onFlushError: (err, count) => {
    metrics.increment("langfuse.dropped_spans", count);
    logger.error("Langfuse flush failed", err);
  },
});
```

### `tracer.droppedSpans`

```ts
// Check how many spans have been silently dropped (buffer overflow or flush errors)
console.log("Dropped spans:", tracer.droppedSpans);
```

---

## MCP governance

`@eidentic/mcp` supports per-call tracing and server-side audit events for full end-to-end observability of every MCP tool call.

### Host-side tracing (`mcpTools` tracer)

Pass `tracer` to `mcpTools` to emit a `mcp.call_tool` span for every remote tool invocation:

```ts
import { mcpTools } from "@eidentic/mcp";

const tools = mcpTools(mcpClient, {
  prefix: "github",
  tracer: myOtelTracer, // any TracerPort
});
```

Each span carries:
- `mcp.tool.name` — remote tool name (without prefix)
- `mcp.server.id` — value of `opts.prefix` when set
- `mcp.duration_ms` — round-trip wall-clock time (ms)
- `error: true` — when the response has `isError: true` or the call throws

### Server-side audit (`onAudit`)

When serving your own MCP server with `createMcpServer`, supply `onAudit` to receive a `McpAuditEvent` for every tool call:

```ts
import { createMcpServer } from "@eidentic/mcp";

const server = createMcpServer({
  tools: myTools,
  onAudit: (event: McpAuditEvent) => {
    auditLog.write({
      tool: event.toolName,
      input: event.input,
      output: event.output,
      durationMs: event.durationMs,
      isError: event.isError,
    });
  },
  tracer: myOtelTracer, // spans on the server side too
});
```

`McpAuditEvent` fields:
| Field | Type | Description |
|---|---|---|
| `toolName` | `string` | Invoked tool name |
| `input` | `unknown` | Raw input arguments |
| `output` | `unknown` | Return value or error object |
| `isError` | `boolean` | `true` when the tool threw |
| `durationMs` | `number` | Execution time |

Combining host-side `tracer` with server-side `onAudit` + `tracer` gives a complete audit trail — every call tracked end-to-end including denials and parse failures.

---

## Self-hosted observability

To keep all telemetry within your own infrastructure, self-host Langfuse and point the exporter at your instance:

```ts
const tracer = langfuseTracer({
  publicKey: "pk-lf-...",
  secretKey: "sk-lf-...",
  baseUrl: "https://langfuse.internal.example.com",
});
```

For fully air-gapped environments see the [Data Residency guide](/guides/data-residency) for local model + store options.

---

## Gotchas

- `tracer.flush()` and `tracer.shutdown()` serialize concurrent calls through a promise chain — safe to call from multiple places.
- The Langfuse adapter does NOT keep the Node.js process alive — the flush timer is `unref()`'d.
- `onFlushError` is never allowed to throw — wrap your error handler in a try/catch if it calls external services.
