import { isText, isToolUse, type ContentBlock, type StoredEvent, type Usage } from "@eidentic/types";

/** A model call (one assistant turn): its text plus the usage the loop recorded on the event. */
export interface ModelCallStep {
  kind: "modelCall";
  text: string;
  usage?: Usage;
}

/** A tool invocation, taken from a `tool_use` block in an assistant event. */
export interface ToolCallStep {
  kind: "toolCall";
  callId: string;
  name: string;
  input: unknown;
}

/** A tool result, taken from a `tool_result` event. `isError` is derived structurally. */
export interface ToolResultStep {
  kind: "toolResult";
  callId: string;
  name: string;
  output: unknown;
  isError: boolean;
}

export type TrajectoryStep = ModelCallStep | ToolCallStep | ToolResultStep;

/** The normalized, ordered trace a scorer consumes. `input` is the leading user text (if any). */
export interface Trajectory {
  input: string;
  steps: TrajectoryStep[];
}

/** Convenience: just the tool-call steps, in order. */
export const toolCallsOf = (t: Trajectory): ToolCallStep[] =>
  t.steps.filter((s): s is ToolCallStep => s.kind === "toolCall");

/** Convenience: the names of the tool calls, in order. */
export const toolNamesOf = (t: Trajectory): string[] => toolCallsOf(t).map((s) => s.name);

/** The registry's error shape is `{ error: <string> }`; detect it structurally for `isError`. */
function outputIsError(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    "error" in (output as Record<string, unknown>)
  );
}

/**
 * Normalize the REAL session event log (§9.1) into a stable `Trajectory`.
 * - `user`        → the leading `input` string (first user event wins).
 * - `assistant`   → `payload.content` (ContentBlock[]): text blocks → a `modelCall` step;
 *                   each `tool_use` block → a `toolCall` step (callId/name/input).
 * - `tool_result` → `payload {callId, toolName, output}` → a `toolResult` step.
 * - everything else (compaction/suspension/checkpoint/tool_call) → ignored.
 * Pure: no clock, no randomness — same events in => same trajectory out.
 */
export function trajectoryFromEvents(events: StoredEvent[]): Trajectory {
  let input = "";
  const steps: TrajectoryStep[] = [];
  for (const e of events) {
    if (e.kind === "user") {
      if (input === "") input = typeof e.payload === "string" ? e.payload : String(e.payload);
    } else if (e.kind === "assistant") {
      const content = (e.payload as { content: ContentBlock[] }).content ?? [];
      const text = content.filter(isText).map((b) => b.text).join("");
      steps.push({ kind: "modelCall", text, ...(e.meta?.usage ? { usage: e.meta.usage as Usage } : {}) });
      for (const b of content.filter(isToolUse)) {
        steps.push({ kind: "toolCall", callId: b.callId, name: b.name, input: b.input });
      }
    } else if (e.kind === "tool_result") {
      const p = e.payload as { callId: string; toolName: string; output: unknown };
      steps.push({
        kind: "toolResult",
        callId: p.callId,
        name: p.toolName,
        output: p.output,
        isError: outputIsError(p.output),
      });
    }
    // compaction | suspension | checkpoint | tool_call => ignored (audit/reserved).
  }
  return { input, steps };
}
