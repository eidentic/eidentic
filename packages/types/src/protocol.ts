import type { CostBreakdown } from "./observability.js";

// --- Human-in-the-loop suspension types (§5.7 / §9.4) ---

/** What a suspending tool presents to the human (the approval request). `present` is opaque UI/context payload. */
export interface SuspendRequest {
  reason: string;
  present?: unknown;
}

/** The human's recorded answer, injected back into the tool on resume. `data` is opaque caller payload. */
export interface SuspendDecision {
  approved: boolean;
  data?: unknown;
}

// --- Image input (vision / multimodal) ---
/**
 * Image data for multimodal (vision) input.
 *
 * Supply exactly one of `data` or `url`:
 * - `data` — base64-encoded bytes or a data-URL (`data:<mediaType>;base64,<bytes>`).
 * - `url`  — a publicly accessible URL pointing to the image.
 *
 * `mediaType` is optional; when present it is forwarded to the model provider
 * (e.g. `"image/jpeg"`, `"image/png"`).
 */
export type ImageInput =
  | { data: string; url?: never; mediaType?: string }
  | { url: string; data?: never; mediaType?: string };

// --- Content blocks (what a model turn is made of) ---
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; callId: string; name: string; input: unknown }
  | { type: "thinking"; text: string }
  /**
   * Image content block (vision / multimodal INPUT only). Used to pass images to models
   * that support vision. Output stays text + tool_use; this variant is only valid in
   * user messages. Mapped to an AI SDK `ImagePart` when building the model request.
   */
  | { type: "image"; image: ImageInput };

export const textBlock = (text: string): ContentBlock => ({ type: "text", text });
export const toolUseBlock = (callId: string, name: string, input: unknown): ContentBlock => ({
  type: "tool_use",
  callId,
  name,
  input,
});
/** Construct an image content block for multimodal (vision) input. */
export const imageBlock = (image: ImageInput): ContentBlock => ({ type: "image", image });
export const isToolUse = (b: ContentBlock): b is Extract<ContentBlock, { type: "tool_use" }> =>
  b.type === "tool_use";
export const isText = (b: ContentBlock): b is Extract<ContentBlock, { type: "text" }> =>
  b.type === "text";
/** Type guard: true when the block is an image (vision) input block. */
export const isImage = (b: ContentBlock): b is Extract<ContentBlock, { type: "image" }> =>
  b.type === "image";

// --- Multimodal input encoding (used by Agent + mapMessages) ---
/**
 * Sentinel prefix that marks a user-event payload as a JSON-encoded ContentBlock[].
 * The non-printable null bytes guarantee no ordinary text message can start with this prefix,
 * so detection is unambiguous and collision-free.
 * @internal
 */
export const MULTIMODAL_INPUT_PREFIX = "\x00eidentic-mm\x00";

/**
 * Encode a ContentBlock[] as a sentinel-prefixed JSON string for storage in the event log.
 * The agent uses this when `query()` receives an input containing image blocks — the event
 * log stores user payloads as strings, so we serialize and prefix the blocks to preserve
 * the image data across session replay.
 * @internal
 */
export const encodeMultimodalInput = (blocks: ContentBlock[]): string =>
  MULTIMODAL_INPUT_PREFIX + JSON.stringify(blocks);

/**
 * Decode a multimodal-encoded user-event string back to ContentBlock[].
 * Returns `null` when the string is not a multimodal-encoded input (i.e. plain text).
 * @internal
 */
export const decodeMultimodalInput = (s: string): ContentBlock[] | null => {
  if (!s.startsWith(MULTIMODAL_INPUT_PREFIX)) return null;
  try {
    return JSON.parse(s.slice(MULTIMODAL_INPUT_PREFIX.length)) as ContentBlock[];
  } catch {
    return null;
  }
};

/**
 * Extract the plain-text content from a ContentBlock[] for use in guardrails, memory
 * retrieval, and other text-based operations. Image blocks are ignored.
 * @internal
 */
export const extractTextFromBlocks = (blocks: ContentBlock[]): string =>
  blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join(" ");

// --- Usage / termination ---
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported KV-cache read tokens (§11.1). 0 when the model does not report it. */
  cachedInputTokens?: number;
}

/**
 * Fold two Usage objects together. Handles the optional `cachedInputTokens` field:
 * when either operand has it the result includes the sum; when neither has it the
 * field is omitted so zero-valued sentinel entries are not introduced.
 */
export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.cachedInputTokens !== undefined || b.cachedInputTokens !== undefined
      ? { cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0) }
      : {}),
  };
}

export interface StreamDelta {
  text: string;
}

export type TerminationSubtype =
  | "success"
  | "max_turns"
  | "max_tokens"
  | "max_cost"
  | "max_wall_clock"
  | "aborted"
  | "suspended"
  | "guardrail"
  | "error";

/**
 * Typed discriminated-union payload for terminal `result` events.
 * Keyed by `subtype`; absent subtypes carry no structured detail.
 *
 * The `details` field is OPTIONAL and ADDITIVE — all existing fields on the `result`
 * event (`output`, `cost`, `usage`, etc.) are unchanged. Back-compat: consumers that
 * do not read `details` are unaffected.
 */
export type ResultDetails =
  | { subtype: "max_cost"; usdSpent: number; usdLimit: number }
  | { subtype: "max_tokens"; tokensUsed: number; tokenLimit: number }
  | { subtype: "max_wall_clock"; elapsedMs: number; limitMs: number }
  | { subtype: "max_turns"; turns: number; limit: number }
  | {
      subtype: "error";
      errorName?: string;
      errorKind?: "structured_output_parse" | "structured_output_validation";
      validationIssues?: string[];
      rawOutput?: string;
    }
  | { subtype: "suspended"; callId?: string; toolName?: string }
  | { subtype: "success" }
  | { subtype: "aborted" }
  | { subtype: "guardrail"; reason?: string; code?: string; severity?: "low" | "medium" | "high" };

// --- Stored events (the append-only log) ---
/**
 * Append-only event kinds written to the store.
 * `"compaction"` is PRODUCED by the loop (Plan 15, §4.4): an audit marker recording an
 * in-context-window compaction (payload `{ before, after, stages }`). It does NOT add a model
 * message on replay — `appendEventToMessages` ignores it; the window is rebuilt from the real
 * events then re-compacted.
 * `"suspension"` is PRODUCED by the loop (Plan 16, §5.7/§9.4): an audit marker recording a
 * human-in-the-loop suspension (payload `{ callId, request }`). Like `"compaction"`, it adds NO
 * model message on replay — `appendEventToMessages` ignores it; the suspended assistant tool_use
 * is re-dispatched and the decision is injected via `ctx.suspend`.
 * `"tool_call"` and `"checkpoint"` are RESERVED-for-future use (§9.7 fork/time-travel explicit
 * tool_call events; explicit checkpoint events). The loop does not produce them today:
 * - Durable checkpoints are written to a separate checkpoint table, not the event log.
 * - Tool calls are embedded in the assistant event's content, not logged as separate events.
 * Keep them in the union — removing them would be a breaking change.
 */
export type EventKind = "user" | "assistant" | "tool_call" | "tool_result" | "checkpoint" | "compaction" | "suspension";

export interface StoredEvent {
  id: string;
  sessionId: string;
  seq: number;
  kind: EventKind;
  schemaVersion: number;
  payload: unknown;
  meta?: { usage?: Usage; [k: string]: unknown };
  createdAt: string;
}

export const EVENT_SCHEMA_VERSION = 1;

// --- Stream events (what Agent.query yields) ---
export type StreamEvent =
  | {
      type: "session.init";
      sessionId: string;
      agentId: string;
      tools: string[];
      model: string;
      instructionsVersion?: string;
      /**
       * Static opening message from `AgentConfig.greeting`. Present only when `greeting` was
       * configured on the agent. UIs should render this as an initial assistant bubble before
       * the first user turn. Never sent to the model; never persisted as an event.
       */
      greeting?: string;
    }
  | { type: "stream.delta"; delta: StreamDelta }
  | {
      type: "assistant";
      content: ContentBlock[];
      /**
       * Per-turn token usage for this model response. Present on every assistant event so
       * consumers can track spend incrementally (Feature 2 — per-turn cost visibility).
       */
      usage: Usage;
    }
  | { type: "tool.result"; callId: string; toolName: string; output: unknown; isError: boolean }
  | {
      type: "result";
      subtype: TerminationSubtype;
      output?: unknown;
      usage: Usage;
      numTurns: number;
      sessionId: string;
      /** Transparent cost accounting (§11.2). Present on terminal events emitted by the loop. */
      cost?: CostBreakdown;
      /** Present ONLY on `subtype: "suspended"` (§5.7): the pending approval request and the suspended tool's callId. */
      request?: SuspendRequest;
      callId?: string;
      /**
       * Structured/schema-constrained final answer. Present ONLY on `subtype: "success"` when the
       * query was issued with an `outputSchema`: the model's final object, parsed AND validated
       * against the schema. When the model's structured output fails validation the run terminates
       * with `subtype: "error"` instead, and this field is absent.
       */
      object?: unknown;
      /**
       * Optional typed detail payload, discriminated by `subtype`. Carries structured numbers for
       * resource-limit subtypes (e.g. `{ usdSpent, usdLimit }` for `max_cost`) and minimal metadata
       * for the others. ADDITIVE and OPTIONAL — the existing `output`/`cost`/`usage` fields are
       * unchanged. Consumers that do not read `details` compile without any changes.
       */
      details?: ResultDetails;
    }
  | {
      /**
       * Emitted (Plan 15, §4.4) when the in-context message window was compacted before a model
       * call. `before`/`after` are `estimateTokens` heuristic counts; `stages` lists the applied
       * compaction stages (e.g. `["tool-result-condense","fifo-truncate","coalesce"]`). The
       * persisted event log is NOT mutated — this is an audit signal only (§4.3 cache invalidation
       * from this point is accepted and rare).
       */
      type: "compaction";
      sessionId: string;
      before: number;
      after: number;
      stages: string[];
    };
