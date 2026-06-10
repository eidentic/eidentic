"use client";

import { useState, useRef, useCallback, useEffect } from "react";

// --- Shared types ---

export type AsyncRunStatus = "idle" | "running" | "completed" | "failed" | "aborted";

export interface AsyncRunStatusResponse<TOutput = unknown> {
  runId: string;
  sessionId: string;
  status: "running" | "completed" | "failed" | "aborted";
  output?: TOutput;
  error?: string;
  settledAt?: string;
}

export interface AsyncRunOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Polling interval in milliseconds. Default: 1500. */
  pollIntervalMs?: number;
  /**
   * Optional timeout in milliseconds for the entire run (from the POST through polling).
   * When a run stays non-terminal longer than this, polling stops and the hook transitions
   * to status "failed" with an error of "Run timed out". Default: no limit.
   */
  maxPollMs?: number;
}

// Terminal statuses — polling stops when one of these is reached.
const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "aborted"]);

// ---------------------------------------------------------------------------
// Internal polling core — shared between useAsyncRun and useRunStatus.
// ---------------------------------------------------------------------------

/** Start polling a run's status until terminal or the signal is aborted. */
async function pollRunStatus(
  agentId: string,
  runId: string,
  baseUrl: string,
  headers: Record<string, string>,
  pollIntervalMs: number,
  signal: AbortSignal,
  onUpdate: (r: AsyncRunStatusResponse) => void,
): Promise<void> {
  const url = `${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/status`;

  while (!signal.aborted) {
    let response: AsyncRunStatusResponse;
    try {
      const res = await fetch(url, { headers: { ...headers }, signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      response = (await res.json()) as AsyncRunStatusResponse;
    } catch (e: unknown) {
      // AbortError means unmount / new-run cleanup — exit silently.
      if ((e as { name?: string })?.name === "AbortError") return;
      throw e;
    }

    onUpdate(response);

    if (TERMINAL.has(response.status)) return;

    // Wait pollIntervalMs, but bail early if aborted.
    await new Promise<void>((resolve) => {
      const tid = setTimeout(resolve, pollIntervalMs);
      signal.addEventListener("abort", () => {
        clearTimeout(tid);
        resolve();
      }, { once: true });
    });
  }
}

// ---------------------------------------------------------------------------
// useAsyncRun
// ---------------------------------------------------------------------------

export interface UseAsyncRunReturn<TOutput = unknown> {
  /** Start a new run. Returns a promise resolving to `{ runId }`. */
  start(input: unknown, opts?: { sessionId?: string }): Promise<{ runId: string }>;
  /** The current run ID, or null if no run has started. */
  runId: string | null;
  /** Current status. "idle" before any run; "running" while polling. */
  status: AsyncRunStatus;
  /** Typed output from a completed run. */
  output: TOutput | null;
  /** Error message from a failed run. */
  error: string | null;
  /** True while actively polling. */
  isPolling: boolean;
}

/**
 * Hook for fire-and-poll async agent runs.
 *
 * @param agentId      The agent ID registered in the Eidentic server.
 * @param opts         Optional configuration (baseUrl, headers, pollIntervalMs, maxPollMs).
 */
export function useAsyncRun<TOutput = unknown>(
  agentId: string,
  opts: AsyncRunOptions = {},
): UseAsyncRunReturn<TOutput> {
  const { baseUrl = "", headers = {}, pollIntervalMs = 1500, maxPollMs } = opts;

  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<AsyncRunStatus>("idle");
  const [output, setOutput] = useState<TOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);

  // Keep opts in a ref to avoid stale closures in the async loop.
  const optsRef = useRef({ baseUrl, headers, pollIntervalMs, maxPollMs });
  optsRef.current = { baseUrl, headers, pollIntervalMs, maxPollMs };

  // AbortController for the current run (covers both the POST and polling).
  const pollAbortRef = useRef<AbortController | null>(null);

  // Cleanup on unmount — aborts both the initial POST and any in-flight poll.
  useEffect(() => {
    return () => {
      pollAbortRef.current?.abort();
    };
  }, []);

  const start = useCallback(
    async (input: unknown, startOpts?: { sessionId?: string }): Promise<{ runId: string }> => {
      // Cancel any in-flight request from a previous run.
      pollAbortRef.current?.abort();

      const { baseUrl: bUrl, headers: hdrs, pollIntervalMs: pInterval, maxPollMs: maxMs } = optsRef.current;
      const createUrl = `${bUrl}/v1/agents/${encodeURIComponent(agentId)}/runs`;

      // Reset state.
      setStatus("running");
      setOutput(null);
      setError(null);
      setIsPolling(false);

      // Single AbortController shared by the initial POST and subsequent polling.
      const ctrl = new AbortController();
      pollAbortRef.current = ctrl;

      // POST to create the run — shares the same abort signal so unmount aborts it too.
      const body: Record<string, unknown> = { input };
      if (startOpts?.sessionId) body.sessionId = startOpts.sessionId;

      const createRes = await fetch(createUrl, {
        method: "POST",
        headers: { "content-type": "application/json", ...hdrs },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!createRes.ok) throw new Error(`HTTP ${createRes.status}`);

      const created = (await createRes.json()) as { runId: string; sessionId: string; status: string; output?: TOutput };
      const newRunId = created.runId;
      setRunId(newRunId);

      // Optionally abort after maxPollMs.
      let maxPollTid: ReturnType<typeof setTimeout> | undefined;
      if (maxMs !== undefined && maxMs > 0) {
        maxPollTid = setTimeout(() => {
          ctrl.abort();
        }, maxMs);
      }

      setIsPolling(true);

      // Track whether we reached a terminal status naturally (vs. being aborted mid-poll).
      let reachedTerminal = false;

      pollRunStatus(
        agentId,
        newRunId,
        bUrl,
        hdrs,
        pInterval,
        ctrl.signal,
        (r) => {
          setStatus(r.status as AsyncRunStatus);
          if (r.output !== undefined) setOutput(r.output as TOutput);
          if (r.error !== undefined) setError(r.error ?? null);
          if (TERMINAL.has(r.status)) {
            reachedTerminal = true;
            clearTimeout(maxPollTid);
            setIsPolling(false);
            pollAbortRef.current = null;
          }
        },
      ).then(() => {
        // pollRunStatus resolves (not rejects) on AbortError — check if we were aborted
        // without having reached a terminal status, which indicates a maxPollMs timeout
        // or an unmount cleanup.
        clearTimeout(maxPollTid);
        if (!reachedTerminal && ctrl.signal.aborted) {
          if (maxMs !== undefined) {
            // maxPollMs was configured — this is a timeout.
            setError("Run timed out");
            setStatus("failed");
          }
          setIsPolling(false);
        }
      }).catch((e: unknown) => {
        clearTimeout(maxPollTid);
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setStatus("failed");
        setIsPolling(false);
      });

      return { runId: newRunId };
    },
    [agentId],
  );

  return { start, runId, status, output, error, isPolling };
}

// ---------------------------------------------------------------------------
// useRunStatus
// ---------------------------------------------------------------------------

export interface UseRunStatusReturn<TOutput = unknown> {
  status: AsyncRunStatus;
  output: TOutput | null;
  error: string | null;
  isPolling: boolean;
}

/**
 * Hook for polling an existing run's status until terminal.
 *
 * @param agentId   The agent ID.
 * @param runId     The run ID to poll, or null to do nothing.
 * @param opts      Optional configuration (baseUrl, headers, pollIntervalMs).
 */
export function useRunStatus<TOutput = unknown>(
  agentId: string,
  runId: string | null,
  opts: AsyncRunOptions = {},
): UseRunStatusReturn<TOutput> {
  const { baseUrl = "", headers = {}, pollIntervalMs = 1500 } = opts;

  const [status, setStatus] = useState<AsyncRunStatus>("idle");
  const [output, setOutput] = useState<TOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);

  const optsRef = useRef({ baseUrl, headers, pollIntervalMs });
  optsRef.current = { baseUrl, headers, pollIntervalMs };

  const pollAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!runId) {
      setStatus("idle");
      setIsPolling(false);
      return;
    }

    // Cancel any previous poll.
    pollAbortRef.current?.abort();

    const { baseUrl: bUrl, headers: hdrs, pollIntervalMs: pInterval } = optsRef.current;
    const ctrl = new AbortController();
    pollAbortRef.current = ctrl;

    setStatus("running");
    setIsPolling(true);
    setOutput(null);
    setError(null);

    pollRunStatus(
      agentId,
      runId,
      bUrl,
      hdrs,
      pInterval,
      ctrl.signal,
      (r) => {
        setStatus(r.status as AsyncRunStatus);
        if (r.output !== undefined) setOutput(r.output as TOutput);
        if (r.error !== undefined) setError(r.error ?? null);
        if (TERMINAL.has(r.status)) {
          setIsPolling(false);
          pollAbortRef.current = null;
        }
      },
    ).catch((e: unknown) => {
      if ((e as { name?: string })?.name === "AbortError") return;
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setStatus("failed");
      setIsPolling(false);
    });

    return () => {
      ctrl.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, runId]);

  return { status, output, error, isPolling };
}
