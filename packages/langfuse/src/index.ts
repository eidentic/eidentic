// ---------------------------------------------------------------------------
// @eidentic/langfuse — Langfuse OTLP adapter
//
// Implements TracerPort so it can be passed directly to Agent({ tracer }).
// Spans are buffered in memory and sent to Langfuse's OTLP/HTTP endpoint
// (/api/public/otel/v1/traces) using Basic auth (publicKey:secretKey) and
// the standard OTLP JSON payload format — no external SDK dependency.
//
// Usage:
//   const tracer = langfuseTracer({ publicKey: "pk-lf-...", secretKey: "sk-lf-..." });
//   const agent = new Agent({ ..., tracer });
//   // spans auto-flush in batches; call tracer.shutdown() on process exit.
// ---------------------------------------------------------------------------

import type { Span, TracerPort } from "@eidentic/types";

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface LangfuseTracerOptions {
  /** Langfuse project public key (pk-lf-…). */
  publicKey: string;
  /** Langfuse project secret key (sk-lf-…). */
  secretKey: string;
  /**
   * Langfuse base URL (no trailing slash).
   * Defaults to https://cloud.langfuse.com (EU region).
   * Use https://us.cloud.langfuse.com for US, or your self-hosted URL.
   */
  baseUrl?: string;
  /**
   * Maximum number of spans to buffer before triggering an automatic flush.
   * Defaults to 20.
   */
  flushAt?: number;
  /**
   * Maximum milliseconds to wait before auto-flushing buffered spans.
   * Defaults to 5000.
   */
  flushInterval?: number;
  /**
   * Override the fetch implementation (useful in tests).
   * Defaults to globalThis.fetch.
   */
  fetchImpl?: typeof fetch;
  /**
   * **SECURITY NOTE — read before deploying to production.**
   *
   * By default (`undefined`) span `attributes` are forwarded verbatim to
   * Langfuse's OTLP endpoint.  Attributes often contain prompt text, tool
   * arguments, and other sensitive data.  If your Langfuse project is shared,
   * externally visible, or subject to data-minimisation requirements, you MUST
   * supply this callback to scrub or mask sensitive fields before they leave
   * the process.
   *
   * The callback receives the raw attribute array for each completed span and
   * must return the (possibly modified) array that will actually be sent.
   *
   * Example — drop all attributes whose key starts with "llm.prompt":
   * ```ts
   * redactAttributes: (attrs) =>
   *   attrs.filter(({ key }) => !key.startsWith("llm.prompt")),
   * ```
   *
   * @default undefined  — no redaction; all attributes are exported as-is.
   */
  redactAttributes?: (
    attrs: Array<{ key: string; value: string | number | boolean }>,
  ) => Array<{ key: string; value: string | number | boolean }>;
  /**
   * Called when a flush attempt fails (network error, HTTP error, etc.).
   *
   * Receives the error and the number of spans that were dropped as a result
   * of the failure.  Use this to surface dropped-span telemetry to your own
   * monitoring pipeline.
   *
   * @default undefined  — flush errors are silently swallowed.
   */
  onFlushError?: (err: unknown, droppedCount: number) => void;
  /**
   * Maximum number of spans to hold in the internal buffer before the
   * oldest spans are dropped (drop-oldest policy).
   *
   * This prevents unbounded memory growth when the OTLP endpoint is slow or
   * unreachable.  Dropped spans are counted in {@link LangfuseTracer.droppedSpans}.
   *
   * @default 10000
   */
  maxBufferSize?: number;
}

export interface LangfuseTracer extends TracerPort {
  /** Send all buffered spans immediately and resolve when the HTTP call completes. */
  flush(): Promise<void>;
  /** Flush and cancel the auto-flush timer. Call on process exit. */
  shutdown(): Promise<void>;
  /**
   * Running count of spans that were silently dropped due to flush errors or
   * buffer-cap overflow since the tracer was created.
   */
  readonly droppedSpans: number;
}

// ---------------------------------------------------------------------------
// Internal OTLP JSON types (subset of ExportTraceServiceRequest)
// These match the OTLP/HTTP JSON encoding spec; only what we need.
// ---------------------------------------------------------------------------

interface OtlpKeyValue {
  key: string;
  value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean };
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number; // SpanKind: 0=UNSPECIFIED, 1=INTERNAL, 2=SERVER, 3=CLIENT, 4=PRODUCER, 5=CONSUMER
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status: { code: number; message?: string }; // 0=UNSET, 1=OK, 2=ERROR
}

interface OtlpExportRequest {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: Array<{
      scope: { name: string; version: string };
      spans: OtlpSpan[];
    }>;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a random hex string of `bytes` bytes. */
function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  // Works in Node 18+ and all modern browsers.
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(arr);
  } else {
    // Fallback for very old environments (shouldn't happen in practice).
    for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Convert nanosecond bigint to string (OTLP JSON uses string for uint64). */
function nanosToString(ns: bigint): string {
  return ns.toString();
}

/** hrtime equivalent as nanoseconds bigint, works in Node and browsers. */
function nowNanos(): bigint {
  // performance.now() gives sub-ms precision; multiply by 1e6 for nanos.
  return BigInt(Math.floor(globalThis.performance.now() * 1_000_000)) +
    BigInt(Date.now() - Math.floor(globalThis.performance.now())) * 1_000_000n;
}

function toOtlpKeyValue(key: string, value: string | number | boolean): OtlpKeyValue {
  if (typeof value === "string") {
    return { key, value: { stringValue: value } };
  }
  if (typeof value === "boolean") {
    return { key, value: { boolValue: value } };
  }
  // number — use intValue for integers, doubleValue for floats
  if (Number.isInteger(value)) {
    return { key, value: { intValue: value.toString() } };
  }
  return { key, value: { doubleValue: value } };
}

// ---------------------------------------------------------------------------
// SpanImpl — collected data for a single span
// ---------------------------------------------------------------------------

interface CompletedSpan {
  traceId: string;
  spanId: string;
  name: string;
  startNanos: bigint;
  endNanos: bigint;
  attributes: Array<{ key: string; value: string | number | boolean }>;
  statusCode: number; // 0=UNSET, 1=OK, 2=ERROR
  statusMessage?: string;
}

class SpanImpl implements Span {
  readonly traceId: string;
  readonly spanId: string;
  private readonly _name: string;
  private readonly _startNanos: bigint;
  private _endNanos: bigint = 0n;
  private readonly _attrs: Array<{ key: string; value: string | number | boolean }> = [];
  private _statusCode = 0; // UNSET
  private _statusMessage?: string;
  private _ended = false;

  constructor(
    name: string,
    traceId: string,
    attributes: Record<string, string | number | boolean> | undefined,
    private readonly _onEnd: (span: CompletedSpan) => void,
  ) {
    this._name = name;
    this.traceId = traceId;
    this.spanId = randomHex(8);
    this._startNanos = nowNanos();

    if (attributes) {
      for (const [k, v] of Object.entries(attributes)) {
        this._attrs.push({ key: k, value: v });
      }
    }
  }

  setAttribute(key: string, value: string | number | boolean): void {
    if (this._ended) return;
    this._attrs.push({ key, value });
  }

  setStatus(status: "ok" | "error", message?: string): void {
    if (this._ended) return;
    this._statusCode = status === "ok" ? 1 : 2;
    this._statusMessage = message;
  }

  end(): void {
    if (this._ended) return;
    this._ended = true;
    this._endNanos = nowNanos();
    this._onEnd({
      traceId: this.traceId,
      spanId: this.spanId,
      name: this._name,
      startNanos: this._startNanos,
      endNanos: this._endNanos,
      attributes: [...this._attrs],
      statusCode: this._statusCode,
      statusMessage: this._statusMessage,
    });
  }
}

// ---------------------------------------------------------------------------
// LangfuseTracerImpl
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://cloud.langfuse.com";
const DEFAULT_FLUSH_AT = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_BUFFER_SIZE = 10_000;
const SCOPE_NAME = "@eidentic/langfuse";
const SCOPE_VERSION = "0.0.0";

class LangfuseTracerImpl implements LangfuseTracer {
  private readonly _endpoint: string;
  private readonly _authHeader: string;
  private readonly _flushAt: number;
  private readonly _maxBufferSize: number;
  private readonly _fetchImpl: typeof fetch;
  private readonly _redactAttributes?: LangfuseTracerOptions["redactAttributes"];
  private readonly _onFlushError?: LangfuseTracerOptions["onFlushError"];
  private readonly _buffer: CompletedSpan[] = [];
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _flushing: Promise<void> | null = null;
  private _shutdown = false;
  private _droppedSpans = 0;

  get droppedSpans(): number {
    return this._droppedSpans;
  }

  constructor(opts: LangfuseTracerOptions) {
    const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this._endpoint = `${base}/api/public/otel/v1/traces`;
    this._flushAt = opts.flushAt ?? DEFAULT_FLUSH_AT;
    this._maxBufferSize = opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    this._fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this._redactAttributes = opts.redactAttributes;
    this._onFlushError = opts.onFlushError;

    // Basic auth: base64(publicKey:secretKey)
    const creds = `${opts.publicKey}:${opts.secretKey}`;
    const encoded =
      typeof globalThis.btoa === "function"
        ? globalThis.btoa(creds)
        : Buffer.from(creds).toString("base64");
    this._authHeader = `Basic ${encoded}`;

    const intervalMs = opts.flushInterval ?? DEFAULT_FLUSH_INTERVAL_MS;
    this._timer = setInterval(() => {
      if (this._buffer.length > 0) void this.flush();
    }, intervalMs);
    // Don't keep the process alive just for this timer.
    if (typeof this._timer === "object" && this._timer !== null && "unref" in this._timer) {
      (this._timer as NodeJS.Timeout).unref();
    }
  }

  // ---- TracerPort -----------------------------------------------------------

  startSpan(name: string, attributes?: Record<string, string | number | boolean>): Span {
    // Each top-level call generates a fresh traceId so every Eidentic span
    // becomes its own Langfuse trace. Langfuse groups child spans by traceId,
    // but Eidentic's TracerPort doesn't expose a parent-span context, so we
    // keep spans independent. This is the cleanest mapping given the interface.
    const traceId = randomHex(16);
    return new SpanImpl(name, traceId, attributes, (completed) => {
      if (this._shutdown) return;
      // Enforce buffer cap: drop the oldest span when the buffer is full.
      if (this._buffer.length >= this._maxBufferSize) {
        this._buffer.shift();
        this._droppedSpans++;
      }
      this._buffer.push(completed);
      if (this._buffer.length >= this._flushAt) {
        void this.flush();
      }
    });
  }

  // ---- flush / shutdown -----------------------------------------------------

  flush(): Promise<void> {
    // Serialize concurrent flush calls.
    this._flushing = (this._flushing ?? Promise.resolve()).then(() =>
      this._doFlush(),
    );
    return this._flushing;
  }

  async shutdown(): Promise<void> {
    this._shutdown = true;
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    await this.flush();
  }

  // ---- private --------------------------------------------------------------

  private async _doFlush(): Promise<void> {
    if (this._buffer.length === 0) return;

    const batch = this._buffer.splice(0);

    // Apply attribute redaction if a redactor was provided.
    const redactedBatch = this._redactAttributes
      ? batch.map((s) => ({ ...s, attributes: this._redactAttributes!(s.attributes) }))
      : batch;

    const body = this._buildOtlpPayload(redactedBatch);

    try {
      await this._fetchImpl(this._endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this._authHeader,
          "x-langfuse-ingestion-version": "4",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Count dropped spans and notify the caller if a handler was provided.
      this._droppedSpans += batch.length;
      if (this._onFlushError) {
        try {
          this._onFlushError(err, batch.length);
        } catch {
          // Never let the error handler throw.
        }
      }
    }
  }

  private _buildOtlpPayload(spans: CompletedSpan[]): OtlpExportRequest {
    const otlpSpans: OtlpSpan[] = spans.map((s) => ({
      traceId: s.traceId,
      spanId: s.spanId,
      name: s.name,
      kind: 1, // INTERNAL
      startTimeUnixNano: nanosToString(s.startNanos),
      endTimeUnixNano: nanosToString(s.endNanos),
      attributes: s.attributes.map(({ key, value }) => toOtlpKeyValue(key, value)),
      status: s.statusCode === 0
        ? { code: 0 }
        : { code: s.statusCode, ...(s.statusMessage ? { message: s.statusMessage } : {}) },
    }));

    return {
      resourceSpans: [
        {
          resource: {
            attributes: [toOtlpKeyValue("service.name", "eidentic-agent")],
          },
          scopeSpans: [
            {
              scope: { name: SCOPE_NAME, version: SCOPE_VERSION },
              spans: otlpSpans,
            },
          ],
        },
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Langfuse tracer that implements Eidentic's `TracerPort`.
 *
 * Spans emitted by the Eidentic loop are buffered in memory and sent to
 * Langfuse's OTLP/HTTP endpoint in batches. The adapter uses `fetch` only —
 * no extra SDK dependency.
 *
 * @example
 * ```ts
 * import { Agent } from "@eidentic/core";
 * import { langfuseTracer } from "@eidentic/langfuse";
 *
 * const tracer = langfuseTracer({
 *   publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
 *   secretKey: process.env.LANGFUSE_SECRET_KEY!,
 * });
 *
 * const agent = new Agent({
 *   id: "my-agent",
 *   model,
 *   store,
 *   tracer,
 * });
 *
 * // On process exit:
 * await tracer.shutdown();
 * ```
 */
export function langfuseTracer(opts: LangfuseTracerOptions): LangfuseTracer {
  return new LangfuseTracerImpl(opts);
}
