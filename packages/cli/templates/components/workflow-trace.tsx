// Copied by `eidentic add component` — yours to edit.
"use client";

import React from "react";
import { useWorkflowRun } from "@eidentic/react";
import type { StepTrace } from "@eidentic/react";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface WorkflowTraceProps {
  /** Workflow run ID to display, or null to show empty state. */
  id: string | null;
  /** Base URL of the Eidentic server. Defaults to same-origin (""). */
  baseUrl?: string;
  /** Class name applied to the outermost container. */
  className?: string;
}

// ---------------------------------------------------------------------------
// Step row
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: "ok" | "error" }) {
  if (status === "ok") {
    return (
      <span
        className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200"
        aria-label="Step passed"
      >
        ok
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 ring-1 ring-inset ring-red-200"
      aria-label="Step errored"
    >
      error
    </span>
  );
}

function StepRow({ step }: { step: StepTrace }) {
  const indent = step.path.length;
  // Each level of nesting adds 16px of left padding.
  const paddingLeft = `${indent * 16 + 8}px`;

  const durationLabel =
    step.durationMs >= 1000
      ? `${(step.durationMs / 1000).toFixed(2)}s`
      : `${step.durationMs}ms`;

  return (
    <li
      className="border-b border-zinc-100 last:border-0"
      aria-label={`Step ${step.name}: ${step.status}`}
    >
      <div
        className="flex items-start gap-3 py-2 pr-4"
        style={{ paddingLeft }}
      >
        {/* Tree connector */}
        {indent > 0 && (
          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full border border-zinc-300" aria-hidden="true" />
        )}

        {/* Name */}
        <span className="flex-1 truncate font-mono text-sm text-zinc-700">
          {step.name}
        </span>

        {/* Duration */}
        <span className="shrink-0 text-xs text-zinc-400">{durationLabel}</span>

        {/* Badge */}
        <StatusBadge status={step.status} />
      </div>

      {/* Inline error */}
      {step.status === "error" && step.error && (
        <p
          className="px-3 pb-2 text-xs text-red-600"
          style={{ paddingLeft: `calc(${paddingLeft} + 20px)` }}
          role="alert"
        >
          {step.error}
        </p>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// WorkflowTrace
// ---------------------------------------------------------------------------

/**
 * Renders the step trace of a workflow run as an indented tree.
 *
 * Usage:
 *   <WorkflowTrace id={runId} baseUrl="http://localhost:3000" />
 */
export function WorkflowTrace({ id, baseUrl = "", className = "" }: WorkflowTraceProps) {
  const { run, trace, loading, error } = useWorkflowRun(id, { baseUrl });

  return (
    <div
      className={`rounded-2xl border border-zinc-200 bg-white shadow-sm ${className}`}
      role="region"
      aria-label="Workflow trace"
      aria-busy={loading}
    >
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-zinc-100 px-4 py-3">
        <span className="text-sm font-medium text-zinc-800">
          {run ? run.name : "Workflow trace"}
        </span>
        {run && (
          <StatusBadge status={run.status} />
        )}
        {loading && (
          <span className="ml-auto text-xs text-zinc-400" aria-live="polite">
            Loading…
          </span>
        )}
      </div>

      {/* Body */}
      <div className="p-2">
        {/* Error fetching */}
        {error && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            {error}
          </div>
        )}

        {/* Empty / no id */}
        {!id && !loading && !error && (
          <p className="py-6 text-center text-sm text-zinc-400">
            No workflow run selected.
          </p>
        )}

        {/* Loading placeholder */}
        {id && loading && trace.length === 0 && (
          <ul aria-label="Loading steps" className="space-y-1 px-2 py-2">
            {[1, 2, 3].map((n) => (
              <li key={n} className="flex items-center gap-3 rounded-lg bg-zinc-50 px-3 py-2">
                <span className="h-3 flex-1 animate-pulse rounded bg-zinc-200" />
                <span className="h-3 w-12 animate-pulse rounded bg-zinc-200" />
              </li>
            ))}
          </ul>
        )}

        {/* Step list */}
        {trace.length > 0 && (
          <ul aria-label="Workflow steps">
            {trace.map((step, i) => (
              <StepRow key={`${step.name}-${i}`} step={step} />
            ))}
          </ul>
        )}

        {/* Loaded but empty trace */}
        {id && !loading && !error && trace.length === 0 && run && (
          <p className="py-6 text-center text-sm text-zinc-400">No steps recorded.</p>
        )}
      </div>

      {/* Footer: total duration */}
      {run && (
        <div className="border-t border-zinc-100 px-4 py-2 text-xs text-zinc-400">
          {run.stepCount} step{run.stepCount !== 1 ? "s" : ""} &middot;{" "}
          {run.durationMs >= 1000
            ? `${(run.durationMs / 1000).toFixed(2)}s`
            : `${run.durationMs}ms`}{" "}
          total
        </div>
      )}
    </div>
  );
}
