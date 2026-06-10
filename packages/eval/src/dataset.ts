import type { DatasetExpectation } from "./scorer.js";
import type { StoredEvent } from "@eidentic/types";

export interface DatasetCase {
  id: string;
  input: string;
  /** Human-supplied ground truth (string answer or structured) — NEVER agent-derived. */
  groundTruth: unknown;
  /** Expectations the deterministic scorers consult. */
  expected?: DatasetExpectation;
  /** Optional captured trajectory (from captureFailure / promoteTraceToEvalCase) for replay/inspection. */
  capturedEvents?: StoredEvent[];
  /**
   * Arbitrary provenance metadata (e.g. sourceRunId, promotedAt, tags set by
   * `promoteTraceToEvalCase`). Transparent to the runner/scorers — stored for
   * traceability and JSONL round-trip only.
   */
  meta?: Record<string, unknown>;
}
export interface EvalDataset {
  name: string;
  cases: DatasetCase[];
}

/** The minimal session shape captureFailure needs — satisfied by anything exposing the event log. */
export interface CapturedSession {
  sessionId: string;
  events: StoredEvent[];
  /** The case input (first user turn). When absent, derived from the events. */
  input?: string;
}

export interface CaptureFailureOptions {
  /**
   * REQUIRED human-supplied ground truth (string or structured). The agent NEVER writes its own
   * ground truth (the locked-in-bugs anti-pattern, §11.3). Mandatory by signature.
   */
  groundTruth: unknown;
  /** Optional stable id; defaults to `failure_<sessionId>`. */
  id?: string;
  /** Optional expectations to attach (e.g. expectedTools learned from the human). */
  expected?: DatasetExpectation;
}

/** First user event's payload as the case input. */
function inputFromEvents(events: StoredEvent[]): string {
  const u = events.find((e) => e.kind === "user");
  return u ? (typeof u.payload === "string" ? u.payload : String(u.payload)) : "";
}

/**
 * Turn a failed session into a regression `DatasetCase`. The captured trajectory is stored for
 * replay/inspection; the `groundTruth` comes ONLY from the human-supplied opts — never the agent.
 */
export function captureFailure(session: CapturedSession, opts: CaptureFailureOptions): DatasetCase {
  const input = session.input ?? inputFromEvents(session.events);
  return {
    id: opts.id ?? `failure_${session.sessionId}`,
    input,
    groundTruth: opts.groundTruth, // human-supplied; never derived from session content
    ...(opts.expected ? { expected: opts.expected } : {}),
    capturedEvents: session.events,
  };
}

/**
 * JSONL serialize: one DatasetCase per line. Std-lib only (JSON.stringify + "\n"); a dataset's
 * `name` is the first line as `{"#dataset": name}`. Shape is friendly to OTel/standard eval
 * datasets (flat per-case records); adapters for external eval platforms are explicitly out of scope.
 */
export function saveDatasetJsonl(dataset: EvalDataset): string {
  const header = JSON.stringify({ "#dataset": dataset.name });
  const lines = dataset.cases.map((c) => JSON.stringify(c));
  return [header, ...lines].join("\n") + "\n";
}

/** JSONL parse: inverse of saveDatasetJsonl. Blank lines ignored; missing header => name "dataset".
 * Throws a descriptive error (with 1-based line number) on malformed JSON rather than discarding
 * valid cases silently.
 */
export function loadDatasetJsonl(text: string): EvalDataset {
  const rawLines = text.split("\n");
  let name = "dataset";
  const cases: DatasetCase[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]!.trim();
    if (line.length === 0) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`loadDatasetJsonl: malformed JSON on line ${i + 1}: ${msg}`);
    }
    if (typeof obj["#dataset"] === "string") { name = obj["#dataset"]; continue; }
    cases.push(obj as unknown as DatasetCase);
  }
  return { name, cases };
}
