import type { StoredEvent } from "@eidentic/types";
import { isText } from "@eidentic/types";
import type { DatasetCase, EvalDataset } from "./dataset.js";
import type { DatasetExpectation } from "./scorer.js";

// ---------------------------------------------------------------------------
// PromoteTraceOptions
// ---------------------------------------------------------------------------

export interface PromoteTraceOptions {
  /**
   * Stable id for the produced case. When absent, defaults to
   * `promoted_<sourceRunId>` (or `promoted_unknown` when no sourceRunId).
   */
  id?: string;

  /**
   * The production run / session id this trace was captured from.
   * Stored in `meta.sourceRunId` so promoted cases are traceable back.
   */
  sourceRunId?: string;

  /**
   * ISO-8601 string or epoch ms for when this trace was captured.
   * Stored in `meta.promotedAt`. Callers may pass `new Date().toISOString()`.
   * When omitted the field is absent from meta (pure/deterministic output for tests).
   */
  promotedAt?: string | number;

  /**
   * Arbitrary caller-supplied tags stored verbatim in `meta.tags`.
   * Useful for filtering promoted cases by model version, environment, etc.
   */
  tags?: Record<string, string>;

  /**
   * When `true` (default), the observed assistant text from the trace is used
   * as the regression baseline in `groundTruth`. Set to `false` to leave
   * `groundTruth` as `null` so the caller can supply it manually.
   */
  useObservedAsBaseline?: boolean;

  /**
   * Explicit expectations to attach (e.g. learned from the production run).
   * Passed through to `DatasetCase.expected` unchanged.
   */
  expected?: DatasetExpectation;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract the leading user turn text (first user event). */
function inputFromEvents(events: StoredEvent[]): string {
  const u = events.find((e) => e.kind === "user");
  return u ? (typeof u.payload === "string" ? u.payload : String(u.payload)) : "";
}

/** Extract the final assistant text from the trace (last assistant event with text blocks). */
function observedOutputFromEvents(events: StoredEvent[]): string {
  // Walk in reverse — find the last assistant event that contains text blocks.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind !== "assistant") continue;
    const payload = e.payload as { content?: unknown[] };
    const content = Array.isArray(payload?.content) ? payload.content : [];
    // Use the isText type-guard from @eidentic/types (same as trajectory.ts does).
    const textParts = content.filter(isText as (b: unknown) => b is { type: "text"; text: string });
    if (textParts.length > 0) {
      return textParts.map((b) => b.text).join("");
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// promoteTraceToEvalCase
// ---------------------------------------------------------------------------

/**
 * Turn a captured production trace (array of `StoredEvent`) into an `EvalCase`
 * (`DatasetCase`) that the existing eval runner/scorer can execute.
 *
 * The user input is extracted from the first `user` event. The observed
 * assistant output becomes the regression baseline in `groundTruth` (a "golden"
 * case) when `useObservedAsBaseline` is true (the default). Set it to `false`
 * and fill `groundTruth` yourself when you want a labeled / human-verified case.
 *
 * Provenance is recorded on `DatasetCase.meta` (sourceRunId, promotedAt, tags).
 * The original events are kept in `capturedEvents` for replay/inspection.
 *
 * @throws {Error} When `events` is not a non-empty array (guard against calling
 *   with an empty or malformed trace — the caller has no useful case to create).
 */
export function promoteTraceToEvalCase(
  events: StoredEvent[],
  opts: PromoteTraceOptions = {},
): DatasetCase {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error(
      "promoteTraceToEvalCase: events must be a non-empty StoredEvent array — " +
        "received " +
        (Array.isArray(events) ? "empty array" : typeof events),
    );
  }

  const { id, sourceRunId, promotedAt, tags, useObservedAsBaseline = true, expected } = opts;

  const input = inputFromEvents(events);
  const observedOutput = useObservedAsBaseline ? observedOutputFromEvents(events) : null;

  // Build the provenance meta block — only include defined fields so the object
  // stays minimal and deterministic in tests that omit optional fields.
  const meta: Record<string, unknown> = {};
  if (sourceRunId !== undefined) meta["sourceRunId"] = sourceRunId;
  if (promotedAt !== undefined) meta["promotedAt"] = promotedAt;
  if (tags !== undefined) meta["tags"] = tags;

  const caseId = id ?? (sourceRunId ? `promoted_${sourceRunId}` : "promoted_unknown");

  return {
    id: caseId,
    input,
    groundTruth: observedOutput,
    ...(expected ? { expected } : {}),
    capturedEvents: events,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  };
}

// ---------------------------------------------------------------------------
// collectPromotedCases
// ---------------------------------------------------------------------------

/**
 * Assemble multiple promoted `DatasetCase` objects (from `promoteTraceToEvalCase`)
 * into an `EvalDataset` the existing `evaluate()` runner can execute directly.
 *
 * @param name   - Dataset name (used in JSONL header and reporting).
 * @param cases  - One or more promoted cases.
 */
export function collectPromotedCases(name: string, cases: DatasetCase[]): EvalDataset {
  return { name, cases };
}
