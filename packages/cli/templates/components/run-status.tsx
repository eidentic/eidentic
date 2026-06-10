// Copied by `eidentic add component` — yours to edit.
"use client";

import React from "react";
import { useAsyncRun, useRunStatus } from "@eidentic/react";
import type { AsyncRunStatus } from "@eidentic/react";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface RunStatusProps {
  /** Agent ID registered in the Eidentic server. */
  agentId: string;
  /**
   * Run ID to watch. When provided, the component polls that run's status.
   * Omit (or pass null) to render a start-button that fires a new run.
   */
  runId?: string | null;
  /**
   * Initial input for new runs. Only used when `runId` is not provided and the
   * start button is clicked. Required when using the start-button variant.
   */
  initialInput?: unknown;
  /** Base URL of the Eidentic server. Defaults to same-origin (""). */
  baseUrl?: string;
  /** Label for the start button. Defaults to "Start run". */
  startLabel?: string;
  /** Class name applied to the outermost container. */
  className?: string;
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

function Spinner() {
  return (
    <span
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-500"
      role="status"
      aria-label="Loading"
    />
  );
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<AsyncRunStatus, string> = {
  idle: "bg-zinc-100 text-zinc-500",
  running: "bg-indigo-50 text-indigo-600",
  completed: "bg-emerald-50 text-emerald-700",
  failed: "bg-red-50 text-red-700",
  aborted: "bg-amber-50 text-amber-700",
};

function StatusPill({ status }: { status: AsyncRunStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}
      aria-live="polite"
      aria-atomic="true"
    >
      {status === "running" && <Spinner />}
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Watcher variant (runId provided)
// ---------------------------------------------------------------------------

function RunWatcher({
  agentId,
  runId,
  baseUrl,
  className,
}: {
  agentId: string;
  runId: string;
  baseUrl: string;
  className: string;
}) {
  const { status, output, error, isPolling } = useRunStatus(agentId, runId, { baseUrl });

  const outputText =
    output != null
      ? typeof output === "string"
        ? output
        : JSON.stringify(output, null, 2)
      : null;

  return (
    <div
      className={`space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm ${className}`}
      role="region"
      aria-label="Run status"
    >
      {/* Header */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-zinc-700">Run</span>
        <code className="flex-1 truncate rounded bg-zinc-100 px-2 py-0.5 font-mono text-xs text-zinc-500">
          {runId}
        </code>
        <StatusPill status={status} />
      </div>

      {/* Polling indicator */}
      {isPolling && (
        <p className="text-xs text-zinc-400">Polling for updates…</p>
      )}

      {/* Output */}
      {outputText && (
        <div>
          <p className="mb-1 text-xs font-medium text-zinc-500">Output</p>
          <pre className="overflow-x-auto rounded-xl bg-zinc-50 p-3 text-xs text-zinc-700 whitespace-pre-wrap break-all">
            {outputText}
          </pre>
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Starter variant (no runId — shows a start button)
// ---------------------------------------------------------------------------

function RunStarter({
  agentId,
  baseUrl,
  initialInput,
  startLabel,
  className,
}: {
  agentId: string;
  baseUrl: string;
  initialInput: unknown;
  startLabel: string;
  className: string;
}) {
  const { start, runId, status, output, error, isPolling } = useAsyncRun(agentId, { baseUrl });

  async function handleStart() {
    try {
      await start(initialInput ?? "");
    } catch (e) {
      // error is surfaced via the hook state
      void e;
    }
  }

  const outputText =
    output != null
      ? typeof output === "string"
        ? output
        : JSON.stringify(output, null, 2)
      : null;

  const isRunning = status === "running";

  return (
    <div
      className={`space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm ${className}`}
      role="region"
      aria-label="Run status"
    >
      {/* Header */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-zinc-700">Agent run</span>
        {status !== "idle" && <StatusPill status={status} />}
        <button
          type="button"
          onClick={handleStart}
          disabled={isRunning}
          className="ml-auto rounded-xl bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-50"
          aria-label={startLabel}
        >
          {isRunning ? "Running…" : startLabel}
        </button>
      </div>

      {/* Run ID */}
      {runId && (
        <p className="font-mono text-xs text-zinc-400">
          run: <code>{runId}</code>
        </p>
      )}

      {/* Polling indicator */}
      {isPolling && (
        <p className="text-xs text-zinc-400">Polling for updates…</p>
      )}

      {/* Output */}
      {outputText && (
        <div>
          <p className="mb-1 text-xs font-medium text-zinc-500">Output</p>
          <pre className="overflow-x-auto rounded-xl bg-zinc-50 p-3 text-xs text-zinc-700 whitespace-pre-wrap break-all">
            {outputText}
          </pre>
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RunStatus — top-level component
// ---------------------------------------------------------------------------

/**
 * Displays the status of an async agent run, or a start button that fires one.
 *
 * Usage (watch an existing run):
 *   <RunStatus agentId="my-agent" runId={runId} baseUrl="http://localhost:3000" />
 *
 * Usage (start a new run):
 *   <RunStatus agentId="my-agent" initialInput="Summarise the logs" baseUrl="http://localhost:3000" />
 */
export function RunStatus({
  agentId,
  runId = null,
  initialInput,
  baseUrl = "",
  startLabel = "Start run",
  className = "",
}: RunStatusProps) {
  if (runId) {
    return (
      <RunWatcher
        agentId={agentId}
        runId={runId}
        baseUrl={baseUrl}
        className={className}
      />
    );
  }

  return (
    <RunStarter
      agentId={agentId}
      baseUrl={baseUrl}
      initialInput={initialInput}
      startLabel={startLabel}
      className={className}
    />
  );
}
