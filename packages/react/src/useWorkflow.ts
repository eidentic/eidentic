"use client";

import { useState, useEffect, useCallback, useRef } from "react";

// ---------------------------------------------------------------------------
// Workflow types — mirrored locally so @eidentic/react stays dependency-light.
// ---------------------------------------------------------------------------

export interface StepTrace {
  name: string;
  path: string[];
  startedAt: number;
  durationMs: number;
  status: "ok" | "error";
  error?: string;
}

export interface WorkflowRunSummary {
  id: string;
  name: string;
  status: "ok" | "error";
  startedAt: number;
  durationMs: number;
  stepCount: number;
}

export interface WorkflowRunDetail extends WorkflowRunSummary {
  trace: StepTrace[];
  output?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Shared options
// ---------------------------------------------------------------------------

export interface WorkflowOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Optional polling interval in ms. When set, the hook refetches at this interval. */
  pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// useWorkflowList
// ---------------------------------------------------------------------------

export interface UseWorkflowListReturn {
  runs: WorkflowRunSummary[];
  loading: boolean;
  error: string | null;
  refresh(): void;
}

/**
 * Fetch the list of recent workflow runs.
 *
 * @param opts  Optional configuration (baseUrl, headers, pollIntervalMs).
 */
export function useWorkflowList(opts: WorkflowOptions = {}): UseWorkflowListReturn {
  const { baseUrl = "", headers = {}, pollIntervalMs } = opts;

  const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const optsRef = useRef({ baseUrl, headers, pollIntervalMs });
  optsRef.current = { baseUrl, headers, pollIntervalMs };

  const abortRef = useRef<AbortController | null>(null);

  const fetchList = useCallback(async (signal: AbortSignal) => {
    const { baseUrl: bUrl, headers: hdrs } = optsRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${bUrl}/v1/workflows`, {
        headers: { ...hdrs },
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as WorkflowRunSummary[];
      setRuns(data);
    } catch (e: unknown) {
      if ((e as { name?: string })?.name === "AbortError") return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    void fetchList(ctrl.signal);
  }, [fetchList]);

  useEffect(() => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    void fetchList(ctrl.signal);

    let tid: ReturnType<typeof setInterval> | undefined;
    if (pollIntervalMs && pollIntervalMs > 0) {
      tid = setInterval(() => {
        // Abort the previous in-flight request before starting a new tick's fetch.
        // Without this, a slow first tick and fast second tick can resolve in
        // arbitrary order (last-writer-wins state corruption).
        abortRef.current?.abort();
        const c = new AbortController();
        abortRef.current = c;
        void fetchList(c.signal);
      }, pollIntervalMs);
    }

    return () => {
      ctrl.abort();
      if (tid !== undefined) clearInterval(tid);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchList, pollIntervalMs]);

  return { runs, loading, error, refresh };
}

// ---------------------------------------------------------------------------
// useWorkflowRun
// ---------------------------------------------------------------------------

export interface UseWorkflowRunReturn {
  run: WorkflowRunDetail | null;
  trace: StepTrace[];
  loading: boolean;
  error: string | null;
  refresh(): void;
}

/**
 * Fetch the detail of a single workflow run.
 *
 * @param id    The workflow run ID, or null to do nothing.
 * @param opts  Optional configuration (baseUrl, headers, pollIntervalMs).
 */
export function useWorkflowRun(id: string | null, opts: WorkflowOptions = {}): UseWorkflowRunReturn {
  const { baseUrl = "", headers = {}, pollIntervalMs } = opts;

  const [run, setRun] = useState<WorkflowRunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const optsRef = useRef({ baseUrl, headers, pollIntervalMs });
  optsRef.current = { baseUrl, headers, pollIntervalMs };

  const abortRef = useRef<AbortController | null>(null);

  const fetchDetail = useCallback(
    async (runId: string, signal: AbortSignal) => {
      const { baseUrl: bUrl, headers: hdrs } = optsRef.current;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `${bUrl}/v1/workflows/${encodeURIComponent(runId)}`,
          { headers: { ...hdrs }, signal },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as WorkflowRunDetail;
        setRun(data);
      } catch (e: unknown) {
        if ((e as { name?: string })?.name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [],
  );

  const refresh = useCallback(() => {
    if (!id) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    void fetchDetail(id, ctrl.signal);
  }, [id, fetchDetail]);

  useEffect(() => {
    if (!id) {
      setRun(null);
      setLoading(false);
      setError(null);
      return;
    }

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    void fetchDetail(id, ctrl.signal);

    let tid: ReturnType<typeof setInterval> | undefined;
    if (pollIntervalMs && pollIntervalMs > 0) {
      tid = setInterval(() => {
        // Abort the previous in-flight request before starting a new tick's fetch.
        // Without this, a slow first tick and fast second tick can resolve in
        // arbitrary order (last-writer-wins state corruption).
        abortRef.current?.abort();
        const c = new AbortController();
        abortRef.current = c;
        void fetchDetail(id, c.signal);
      }, pollIntervalMs);
    }

    return () => {
      ctrl.abort();
      if (tid !== undefined) clearInterval(tid);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, fetchDetail, pollIntervalMs]);

  return {
    run,
    trace: run?.trace ?? [],
    loading,
    error,
    refresh,
  };
}
