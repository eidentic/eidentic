"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { parseEidenticStream } from "./parser.js";
import type { TextMessage, ToolCall, ToolResult, ResultEvent, ParsedStreamState } from "./parser.js";
import type { StreamEvent } from "@eidentic/types";
import type { SuspendDecision } from "@eidentic/types";

export type StreamStatus = "idle" | "streaming" | "done" | "error" | "suspended";

/** Snapshot of suspension data when result.subtype === "suspended". */
export interface SuspensionState {
  callId: string;
  request: import("@eidentic/types").SuspendRequest;
}

export interface EidenticStreamState {
  messages: TextMessage[];
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  result: ResultEvent | null;
  status: StreamStatus;
  error: Error | null;
  /** Populated when status === "suspended". Contains callId and request for rendering an approval card. */
  suspension: SuspensionState | null;

  // --- Actions ---

  /**
   * Send a new user input.
   * @param input     The message text.
   * @param opts.body Extra fields merged into the POST body (custom per-message metadata).
   */
  send: (input: string, opts?: { body?: Record<string, unknown> }) => void;

  /** Abort an in-flight stream. */
  stop: () => void;

  /**
   * Resume after a suspension. POSTs to the resume endpoint with { sessionId, decision }.
   * Only valid when status === "suspended".
   *
   * @param decision  "approve" | "reject" | boolean | { approved, data? }.
   */
  resume: (decision: ResumeDecisionInput) => void;

  /**
   * Report that in-place regeneration is unsupported for append-only sessions.
   * No-op if no previous input or a stream is in flight. Start a new/forked
   * session explicitly instead of replaying a side-effecting turn.
   */
  regenerate: () => void;

  /**
   * Replace the accumulated messages array directly — use to seed, restore, or clear history.
   */
  setMessages: (msgs: TextMessage[]) => void;
}

/** Convenience inputs accepted by resume(); all are normalized to SuspendDecision on the wire. */
export type ResumeDecisionInput = SuspendDecision | "approve" | "reject" | boolean;

export interface RetryOnErrorOptions {
  /**
   * Number of retry attempts on network-level stream failures. POST replay can duplicate
   * server/tool side effects even when no response byte arrived; retries therefore remain
   * disabled unless `allowUnsafePostRetry` is also explicitly enabled.
   */
  attempts: number;
  /**
   * Base back-off in milliseconds between retries. Doubles each attempt.
   * Default: 500.
   */
  backoffMs?: number;
}

export interface EidenticStreamOptions {
  /** Pre-existing session ID. If omitted, one is generated lazily (SSR-safe: falls back to a timestamp-based id in environments without crypto.randomUUID). */
  sessionId?: string;
  /**
   * Legacy browser-supplied identity. Ignored unless allowUntrustedIdentityBody
   * is true. Prefer an Authorization header and server-side principal mapping.
   * @deprecated Browser request bodies are not a trusted identity source.
   */
  userId?: string;
  /**
   * Allow userId/orgId/apiKey fields in browser POST bodies.
   * @deprecated Identity must normally be derived by the server from auth.
   * @default false
   */
  allowUntrustedIdentityBody?: boolean;
  headers?: Record<string, string>;
  /**
   * Initial messages to pre-populate the conversation with.
   * Applied once on mount (before the first send). Subsequent calls have no effect unless
   * setMessages is used explicitly.
   */
  initialMessages?: TextMessage[];
  /**
   * Resume endpoint URL. If omitted, derived from the query endpoint by replacing "/query" with "/resume".
   * Example: "https://example.com/v1/agents/my-agent/resume"
   */
  resumeEndpoint?: string;
  /** Called with each ParsedStreamState update while streaming. */
  onUpdate?: (state: Omit<EidenticStreamState, "send" | "stop" | "resume" | "regenerate" | "setMessages">) => void;
  /** Called when the stream ends with a result event. */
  onResult?: (result: ResultEvent) => void;
  /** Called on error. */
  onError?: (err: Error) => void;
  /**
   * Raw-event escape hatch: called for EVERY StreamEvent emitted by the server.
   * Receives tool inputs, usage, cost, compaction, suspension, session.init — nothing hidden.
   */
  onEvent?: (ev: StreamEvent) => void;
  /**
   * Auto-retry transient network/stream failures before surfacing status "error".
   * Only retries fetch-level failures — NOT terminal result events (those are real agent outputs).
   */
  retryOnError?: RetryOnErrorOptions;
  /**
   * Permit retrying a query POST without server-backed atomic request idempotency.
   * @deprecated This can duplicate tool side effects. Leave false until your server implements
   * an atomic request idempotency key/claim contract.
   * @default false
   */
  allowUnsafePostRetry?: boolean;
}

/**
 * Derive the resume URL from the query endpoint.
 * Replaces a trailing "/query" segment with "/resume".
 * If the endpoint does not end with "/query", appends "/resume" at the end
 * (as a safe fallback — callers should pass resumeEndpoint explicitly if the
 * server layout differs).
 */
function deriveResumeEndpoint(queryEndpoint: string): string {
  if (queryEndpoint.endsWith("/query")) {
    return queryEndpoint.slice(0, -"/query".length) + "/resume";
  }
  return queryEndpoint + "/resume";
}

/**
 * Generate a session ID in a way that is safe for SSR (no hydration mismatch) and
 * works in environments that may lack `crypto.randomUUID`.
 */
function generateSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Wait for `ms` milliseconds, but bail immediately if the signal is aborted.
 */
async function waitMs(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const tid = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(tid); resolve(); }, { once: true });
  });
}

function normalizeResumeDecision(decision: ResumeDecisionInput): SuspendDecision {
  if (typeof decision === "boolean") return { approved: decision };
  if (decision === "approve") return { approved: true };
  if (decision === "reject") return { approved: false };
  if (
    decision !== null &&
    typeof decision === "object" &&
    typeof decision.approved === "boolean"
  ) {
    return decision;
  }
  throw new TypeError("resume decision must be 'approve', 'reject', a boolean, or { approved: boolean, data? }");
}

class PartialStreamError extends Error {
  readonly retryable = false;

  constructor(cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Stream failed after receiving data; request was not retried: ${message}`);
    this.name = "PartialStreamError";
  }
}

/**
 * React hook for consuming a Eidentic agent stream.
 *
 * @param endpoint  Full URL of the query endpoint, e.g. "https://example.com/v1/agents/my-agent/query"
 * @param opts      Optional configuration (sessionId, userId, headers, callbacks, initialMessages)
 */
export function useEidenticStream(
  endpoint: string,
  opts: EidenticStreamOptions = {},
): EidenticStreamState {
  const [messages, setMessages] = useState<TextMessage[]>(() => opts.initialMessages ?? []);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [toolResults, setToolResults] = useState<ToolResult[]>([]);
  const [result, setResult] = useState<ResultEvent | null>(null);
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [suspension, setSuspension] = useState<SuspensionState | null>(null);

  // Generate session ID lazily so it is available synchronously on the first render.
  // This avoids the empty-string race where a synchronous send() before the effect flushed
  // would post an empty sessionId. The lazy initializer is safe for SSR because the server
  // generates its own value and the client will match it on hydration as long as the
  // caller passes sessionId explicitly when SSR consistency is required.
  const [sessionId] = useState<string>(() => opts.sessionId ?? generateSessionId());

  const effectiveSessionId = opts.sessionId ?? sessionId;

  const abortRef = useRef<AbortController | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // ---------------------------------------------------------------------------
  // Refs for latest state — used by resume() to capture accumulated history.
  // Declared before the callbacks that close over them.
  // ---------------------------------------------------------------------------
  const messagesRef = useRef<TextMessage[]>(messages);
  messagesRef.current = messages;
  const toolCallsRef = useRef<ToolCall[]>(toolCalls);
  toolCallsRef.current = toolCalls;
  const toolResultsRef = useRef<ToolResult[]>(toolResults);
  toolResultsRef.current = toolResults;

  /** Last user input — for regenerate(). */
  const lastInputRef = useRef<string | null>(null);

  /** Current status kept in a ref so callbacks don't close over stale value. */
  const statusRef = useRef<StreamStatus>("idle");
  statusRef.current = status;

  /**
   * Tracks whether the component is still mounted.
   * Guards all setState calls inside async IIFE bodies so we never update
   * state on an unmounted component (avoids React warnings and memory leaks).
   */
  const mountedRef = useRef(true);

  // ---------------------------------------------------------------------------
  // Unmount cleanup — abort any in-flight stream.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // ---------------------------------------------------------------------------
  // send()
  // ---------------------------------------------------------------------------
  const send = useCallback(
    (input: string, sendOpts?: { body?: Record<string, unknown> }) => {
      if (statusRef.current === "streaming") return;
      statusRef.current = "streaming";

      lastInputRef.current = input;

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      setStatus("streaming");
      setError(null);
      setSuspension(null);

      (async () => {
        const retryOpts = optsRef.current.retryOnError;
        const maxRetries = retryOpts && optsRef.current.allowUnsafePostRetry === true
          ? retryOpts.attempts
          : 0;
        const baseBackoff = retryOpts?.backoffMs ?? 500;
        let attempt = 0;

        // attemptSend executes a single fetch+stream attempt.
        // Returns true when a terminal result was received (don't retry).
        // Throws for network-level failures (may retry).
        const attemptSend = async (): Promise<boolean> => {
          const body: Record<string, unknown> = {
            input,
            ...sendOpts?.body,
          };
          if (optsRef.current.allowUntrustedIdentityBody !== true) {
            delete body["userId"];
            delete body["orgId"];
            delete body["apiKey"];
          }
          if (effectiveSessionId) body.sessionId = effectiveSessionId;
          if (optsRef.current.allowUntrustedIdentityBody === true && optsRef.current.userId) {
            body.userId = optsRef.current.userId;
          }

          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...optsRef.current.headers,
            },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          });

          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }

          const reader = res.body?.getReader();
          if (!reader) {
            throw new Error("No response body");
          }

          let lastResult: ResultEvent | null = null;
          let sawEvent = false;
          let sawResponseBytes = false;
          const trackingReader = {
            async read() {
              const value = await reader.read();
              if (value.value && value.value.byteLength > 0) sawResponseBytes = true;
              return value;
            },
          } as ReadableStreamDefaultReader<Uint8Array>;

          try {
            for await (const state of parseEidenticStream(trackingReader)) {
              if (!mountedRef.current) break;
              sawEvent = true;

              // Fire raw-event callback.
              if (state.lastEvent) {
                optsRef.current.onEvent?.(state.lastEvent);
              }

              setMessages(state.messages);
              setToolCalls(state.toolCalls);
              setToolResults(state.toolResults);

              if (state.result) {
                lastResult = state.result;
                setResult(state.result);
                optsRef.current.onResult?.(state.result);

                // Handle suspension.
                if (state.result.subtype === "suspended" && state.result.callId) {
                  setSuspension({
                    callId: state.result.callId,
                    request: state.result.request ?? { reason: "Approval required" },
                  });
                }
              }
              if (state.error) {
                throw state.error;
              }

              const snapStatus: StreamStatus =
                state.result?.subtype === "suspended" ? "suspended" : "streaming";
              optsRef.current.onUpdate?.({
                messages: state.messages,
                toolCalls: state.toolCalls,
                toolResults: state.toolResults,
                result: state.result,
                status: snapStatus,
                error: null,
                suspension: state.result?.subtype === "suspended" && state.result.callId
                  ? { callId: state.result.callId, request: state.result.request ?? { reason: "Approval required" } }
                  : null,
              });
            }
          } catch (streamError) {
            // A terminal result is authoritative even if the connection tears down
            // immediately afterwards. Otherwise a partial response is unsafe to replay.
            if (lastResult === null && (sawEvent || sawResponseBytes)) throw new PartialStreamError(streamError);
            if (lastResult === null) throw streamError;
          }

          if (!mountedRef.current) return true;

          if (lastResult === null) {
            const incomplete = new Error("Stream ended before a terminal result event");
            if (sawEvent || sawResponseBytes) throw new PartialStreamError(incomplete);
            throw incomplete;
          }

          // Set final status based on terminal result.
          if (lastResult?.subtype === "suspended") {
            statusRef.current = "suspended";
            setStatus("suspended");
          } else {
            statusRef.current = "done";
            setStatus("done");
          }
          // A terminal result was received — do not retry.
          return true;
        };

        try {
          // Retry loop: attempt the send up to (1 + maxRetries) times on network failures.
          // If a terminal result was seen, returns immediately without retrying.
          while (true) {
            try {
              const done = await attemptSend();
              if (done) break;
            } catch (e: unknown) {
              // Always re-throw AbortError — it means intentional stop/unmount.
              if ((e as { name?: string })?.name === "AbortError") throw e;

              // Replaying after any stream event could duplicate agent/tool side
              // effects, so partial streams are never retried automatically.
              if (e instanceof PartialStreamError || attempt >= maxRetries) throw e;

              attempt++;
              const backoff = baseBackoff * Math.pow(2, attempt - 1);
              await waitMs(backoff, ctrl.signal);
              if (!mountedRef.current) return;
              // Continue to next attempt.
            }
          }
        } catch (e: unknown) {
          if (!mountedRef.current) return;
          if ((e as { name?: string })?.name === "AbortError") {
            statusRef.current = "idle";
            setStatus("idle");
            return;
          }
          const err = e instanceof Error ? e : new Error(String(e));
          setError(err);
          statusRef.current = "error";
          setStatus("error");
          optsRef.current.onError?.(err);
        } finally {
          if (mountedRef.current) {
            abortRef.current = null;
          }
        }
      })();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [endpoint, effectiveSessionId],
  );

  // ---------------------------------------------------------------------------
  // resume()
  // ---------------------------------------------------------------------------
  const resume = useCallback(
    (decision: ResumeDecisionInput) => {
      if (statusRef.current === "streaming") return;
      if (statusRef.current !== "suspended") return;
      statusRef.current = "streaming";

      const resumeUrl =
        optsRef.current.resumeEndpoint ?? deriveResumeEndpoint(endpoint);

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      setStatus("streaming");
      setError(null);

      (async () => {
        try {
          const body: Record<string, unknown> = { decision: normalizeResumeDecision(decision) };
          if (effectiveSessionId) body.sessionId = effectiveSessionId;
          if (optsRef.current.allowUntrustedIdentityBody === true && optsRef.current.userId) {
            body.userId = optsRef.current.userId;
          }

          const res = await fetch(resumeUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...optsRef.current.headers,
            },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          });

          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }

          const reader = res.body?.getReader();
          if (!reader) {
            throw new Error("No response body");
          }

          // Capture current state so we can prepend it in the resume stream.
          // We use refs to read latest values without closure issues.
          const priorMessages = messagesRef.current;
          const priorToolCalls = toolCallsRef.current;
          const priorToolResults = toolResultsRef.current;

          let lastResult: ResultEvent | null = null;
          let sawEvent = false;
          let sawResponseBytes = false;
          const trackingReader = {
            async read() {
              const value = await reader.read();
              if (value.value && value.value.byteLength > 0) sawResponseBytes = true;
              return value;
            },
          } as ReadableStreamDefaultReader<Uint8Array>;

          for await (const state of parseEidenticStream(trackingReader)) {
            if (!mountedRef.current) break;
            sawEvent = true;

            // Fire raw-event callback.
            if (state.lastEvent) {
              optsRef.current.onEvent?.(state.lastEvent);
            }

            // Merge new stream output with prior accumulated state.
            const mergedMessages = [
              ...priorMessages.filter(m => !m.streaming),
              ...state.messages,
            ];
            const mergedToolCalls = [...priorToolCalls, ...state.toolCalls];
            const mergedToolResults = [...priorToolResults, ...state.toolResults];

            setMessages(mergedMessages);
            setToolCalls(mergedToolCalls);
            setToolResults(mergedToolResults);

            if (state.result) {
              lastResult = state.result;
              setResult(state.result);
              optsRef.current.onResult?.(state.result);

              if (state.result.subtype === "suspended" && state.result.callId) {
                setSuspension({
                  callId: state.result.callId,
                  request: state.result.request ?? { reason: "Approval required" },
                });
              } else {
                setSuspension(null);
              }
            }
            if (state.error) {
              throw state.error;
            }

            const snapStatus: StreamStatus =
              state.result?.subtype === "suspended" ? "suspended" : "streaming";
            optsRef.current.onUpdate?.({
              messages: mergedMessages,
              toolCalls: mergedToolCalls,
              toolResults: mergedToolResults,
              result: state.result,
              status: snapStatus,
              error: null,
              suspension: state.result?.subtype === "suspended" && state.result.callId
                ? { callId: state.result.callId, request: state.result.request ?? { reason: "Approval required" } }
                : null,
            });
          }

          if (!mountedRef.current) return;

          if (lastResult === null) {
            const incomplete = new Error("Resume stream ended before a terminal result event");
            if (sawEvent || sawResponseBytes) throw new PartialStreamError(incomplete);
            throw incomplete;
          }

          if (lastResult?.subtype === "suspended") {
            statusRef.current = "suspended";
            setStatus("suspended");
          } else {
            statusRef.current = "done";
            setStatus("done");
          }
        } catch (e: unknown) {
          if (!mountedRef.current) return;
          if ((e as { name?: string })?.name === "AbortError") {
            statusRef.current = "idle";
            setStatus("idle");
            return;
          }
          const err = e instanceof Error ? e : new Error(String(e));
          setError(err);
          statusRef.current = "error";
          setStatus("error");
          optsRef.current.onError?.(err);
        } finally {
          if (mountedRef.current) {
            abortRef.current = null;
          }
        }
      })();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [endpoint, effectiveSessionId],
  );

  // ---------------------------------------------------------------------------
  // regenerate()
  // ---------------------------------------------------------------------------
  const regenerate = useCallback(() => {
    const lastInput = lastInputRef.current;
    if (!lastInput) return;
    if (statusRef.current === "streaming") return;

    const err = new Error(
      "Regeneration cannot replay a turn in an append-only session; start a new or forked session",
    );
    setError(err);
    statusRef.current = "error";
    setStatus("error");
    optsRef.current.onError?.(err);
  }, []);

  return {
    messages,
    toolCalls,
    toolResults,
    result,
    status,
    error,
    suspension,
    send,
    stop,
    resume,
    regenerate,
    setMessages,
  };
}
