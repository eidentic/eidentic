import {
  addUsage,
  canonicalJson,
  decodeMultimodalInput,
  encodeMultimodalInput,
  extractTextFromBlocks,
  isText,
  isToolUse,
  scopeKey,
  type ContentBlock,
  type CostBreakdown,
  type CostPolicy,
  type CostThresholdInfo,
  type DurablePort,
  type GuardrailContext,
  type GuardrailPort,
  type LoggerPort,
  type MemoryBlock,
  type MemoryPort,
  type ModelMessage,
  type ModelPort,
  type ModelResponse,
  type PriceTable,
  type ResultDetails,
  type Scope,
  type StoredEvent,
  type StorePort,
  type StreamEvent,
  type TracerPort,
  type Usage,
} from "@eidentic/types";
import { NoopLogger, envLogger } from "./logger.js";
import { ToolRegistry, SuspendSignal, type ToolCall, type ToolResult } from "./tool.js";
import { Session } from "./session.js";
import { replayHash } from "./replay-hash.js";
import { sha256Hex } from "./sha256.js";
import type { TreeBudget } from "./agent.js";
import type { CompactionConfig } from "./compaction.js";
import { compactMessages, estimateTokens } from "./compaction.js";
import { loadedToolNames, lazyManifest } from "./discovery-tools.js";
import type { LazyToolConfig } from "./discovery-tools.js";

export interface RunTurnArgs {
  agentId: string;
  instructions: string;
  input: string;
  /** Optional untrusted user segment used for input guardrails instead of the full assembled prompt. */
  guardrailInput?: { text: string; channel?: string; metadata?: Record<string, unknown> };
  model: ModelPort;
  registry: ToolRegistry;
  session: Session;
  scope: Scope;
  store: StorePort;
  maxTurns: number;
  memory?: MemoryPort;
  /** Tier-1 skill catalog (name+description). When present, injected as a <skills> block. */
  skillCatalog?: { name: string; description: string }[];
  /** When present, the run is durable: checkpoints are written and dispatch idempotency is active. */
  durable?: DurablePort;
  // --- Plan 9b: cost governor + tracing ---
  /** Hard ceilings + soft cap (§11.2). `policy.maxTurns` overrides the legacy `maxTurns` arg. */
  policy?: CostPolicy;
  /** USD price table by model id; enables `usd` accounting + `maxCostUsd`/`softCostUsd`. */
  prices?: PriceTable;
  /** Model id used to look up `prices` and tag `gen_ai.request.model`. When set, all usd is attributed to it. */
  modelId?: string;
  /** Injectable monotonic clock for wall-clock enforcement (ms). Defaults to Date.now. */
  monotonicNow?: () => number;
  /** Soft-cap hook: called once when `policy.softCostUsd` is first crossed. Does not abort. */
  onCostThreshold?: (info: CostThresholdInfo) => void;
  /** OTel tracer (§11.1). When absent, no spans are emitted (zero overhead). Used in Task 3. */
  tracer?: TracerPort;
  /** Structured logger (namespaced). Defaults to NoopLogger when not provided. */
  logger?: LoggerPort;
  /** Shared whole-tree spend accumulator (§8.6). When present, the preflight weighs tree spend (foreground + children). */
  budget?: TreeBudget;
  // --- Plan 15: context-engine compaction (§4.4) ---
  /** When set, the loop estimates the window before each model call and compacts past `maxContextTokens`. */
  compaction?: CompactionConfig;
  /**
   * Fired BEFORE any compaction drops/condenses anything (§4.4 Claude-SDK pattern), so the caller
   * can archive the full transcript. Awaited. The persisted event log is never mutated regardless.
   */
  onPreCompact?: (info: { messages: ModelMessage[]; estTokens: number }) => void | Promise<void>;
  // --- Plan 19: lazy tool discovery (§5.4) ---
  /**
   * When present AND the effective toolset exceeds `threshold`, the per-turn `tools:` manifest is
   * pruned to the eager core ∪ tools the model has `load_tool`-ed (derived from the event log) ∪
   * the two discovery meta-tools. Absent → today's behavior (full `registry.schemas()` every turn).
   * Discovery is a context optimization only; dispatch always uses the full registry (invariant c).
   */
  lazyTools?: LazyToolConfig;
  // --- Plan 21: cooperative cancellation (§16.4) ---
  /**
   * AbortSignal for cooperative cancellation. When aborted, the loop checks at loop boundaries
   * (top of turn, after model call, after tool batch) and emits a terminal `result{subtype:"aborted"}`.
   * Also forwarded to the model request for mid-call provider abort (`abortSignal`).
   * Undefined → zero overhead; behavior byte-identical to the no-signal path.
   */
  signal?: AbortSignal;
  // --- Feature 1: model retry/backoff ---
  /**
   * Retry configuration for transient model failures (network errors, 429, 5xx).
   * When set, the `complete()` path retries up to `maxAttempts` times with `backoffMs` delay
   * between attempts. **Streaming is NOT retried** — once the first streaming call begins it
   * must succeed; only the non-streaming `complete()` path is retried. AbortError / a live
   * abort signal is NEVER retried and always propagates immediately.
   * Default: OFF (no retries).
   */
  modelRetry?: { maxAttempts: number; backoffMs?: number };
  // --- Feature 1: model fallback chain ---
  /**
   * Ordered list of fallback models tried when the primary model fails after exhausting
   * `modelRetry` (or immediately on any failure when no retry is configured). The first
   * fallback that succeeds wins; if all fallbacks also fail the last error is surfaced.
   *
   * **Streaming:** fallback is only attempted when the primary stream throws BEFORE any
   * delta has been yielded to the consumer. Once a delta is emitted the stream has started
   * and cannot be rewound — the run terminates with an error instead of falling back.
   *
   * **AbortError:** never triggers fallback. An abort propagates immediately regardless of
   * how many fallbacks remain.
   *
   * Default: none (no fallbacks).
   */
  modelFallback?: ModelPort[];
  // --- Feature 2: structured-output validation retry ---
  /**
   * When `outputSchema` is set and the model's final response fails schema validation, append
   * a corrective user message (containing the validation error) and re-call the model up to
   * `maxAttempts` additional times. On final failure the run terminates with `subtype:"error"`.
   *
   * `maxAttempts` is the number of RETRIES (i.e. additional calls AFTER the first attempt).
   * `maxAttempts: 0` → no retries; validation failure is terminal immediately (previous behavior).
   * `maxAttempts: 2` → up to 3 total model calls (1 initial + 2 retries).
   *
   * Default: ON with `maxAttempts: 2` — callers can set `maxAttempts: 0` to disable.
   */
  structuredOutputRetry?: { maxAttempts: number };
  // --- §19.4: instruction/prompt versioning ---
  /**
   * Opaque version tag for the agent's instructions. When set, included in the `session.init`
   * stream event payload. Absent → `session.init` is byte-identical to previous behavior.
   */
  instructionsVersion?: string;
  // --- UI affordance: static opening message ---
  /**
   * Static greeting from `AgentConfig.greeting`. When set, included in the `session.init`
   * stream event payload so front-ends can render it immediately without a round-trip.
   * Never sent to the model; never persisted. Absent → `session.init` is byte-identical.
   */
  greeting?: string;
  // --- D6: prompt caching ---
  /**
   * When `true`, the model call marks the stable system-prompt prefix as cacheable. Forwarded
   * to the `ModelRequest` as `cacheControl: true`. Absent or `false` → byte-identical requests.
   * See `AgentConfig.promptCache` for full documentation.
   */
  promptCache?: boolean;
  // --- Structured / schema-constrained output (D2) ---
  /**
   * When present, the run produces a schema-constrained final answer. `json` (a JSON Schema) is
   * forwarded to the model on every turn via `ModelRequest.outputSchema` so the provider constrains
   * the FINAL (tool-less) turn to it; `validate` runs against the SOURCE schema on the terminal
   * turn. On success the parsed object rides the terminal `result` event as `result.object`; on a
   * validation failure (or unparseable structured text) the run terminates with `subtype:"error"`.
   * Absent → byte-identical to the previous (text-only) behavior.
   */
  outputSchema?: StructuredOutputSpec;
  // --- D7: content guardrails ---
  /**
   * Input/output content guardrails. When present, `runTurn` checks the user input against
   * `checkInput` before the first model call, and checks the final assistant text against
   * `checkOutput` before returning it. Multiple guardrails run in order; first `block` wins.
   * Absent → no guardrail checks (zero overhead, behavior byte-identical to previous).
   */
  guardrails?: GuardrailPort[];
  // --- Fix 2: recall token cap ---
  /**
   * Maximum estimated tokens for the injected `<recall>` block. Snippets are included in the
   * order returned by `memory.retrieve()` (highest-ranked first) until the running token estimate
   * would exceed this limit. At least one snippet is always included (even if it alone exceeds
   * the cap). When absent, the default cap of 2000 tokens applies (≈ 8000 chars).
   *
   * NOTE: future — consider promoting to a named top-level option once usage patterns settle.
   */
  maxRecallTokens?: number;
  /**
   * Per-turn context injection hook. Called at the start of each model turn, awaited.
   * When it returns a non-empty string (or array of strings), the content is appended to the
   * model request as a `<system-reminder>` user-role message. These messages are ephemeral:
   * NOT persisted to the session event log, NOT replayed. Each turn gets a fresh call.
   * See `AgentConfig.onTurnStart` for full documentation.
   */
  onTurnStart?: (ctx: { sessionId: string; turn: number }) => string | string[] | void | Promise<string | string[] | void>;
}

/** Loop-level structured-output spec: the wire JSON Schema + authoritative source-schema validator. */
export interface StructuredOutputSpec {
  /** JSON Schema sent to the model over `ModelRequest.outputSchema` (a hint to the provider). */
  json: unknown;
  /** Authoritative validation of the model's final object against the source (e.g. Zod) schema. */
  validate: (value: unknown) => { ok: true; value: unknown } | { ok: false; error: string; issues?: string[] };
}

/**
 * Default cap for the recall block in estimated tokens (heuristic: chars / 4).
 * At 2000 tokens ≈ 8000 chars, a recall block of reasonable size fits comfortably without
 * crowding the context window. NOTE: future — expose via AgentConfig.maxRecallTokens if needed.
 */
const DEFAULT_MAX_RECALL_TOKENS = 2000;

// addUsage is imported from @eidentic/types (canonical shared implementation).

/**
 * Escape untrusted text for safe injection into XML regions.
 * Escapes `<` and `>` to prevent tag injection, and strips newlines + ASCII control chars
 * (U+0000–U+001F, U+007F) to prevent line-forging attacks inside `<recall>` entries where a
 * newline in `metadata.source` could inject a fake `- [source: …]` line.
 * Fix 3: the original helper only escaped angle brackets; this adds control-char stripping.
 */
function esc(s: string): string {
  // Strip ASCII control characters (including newlines, carriage returns, tabs, etc.)
  // then escape XML delimiters. Printable Unicode above U+007F is allowed.
  return s
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Heuristically classify an error as transient (safe to retry).
 * Transient: network errors, HTTP 429 Too Many Requests, HTTP 5xx server errors.
 * Non-transient: AbortError, 4xx client errors (except 429), or unknown errors.
 * AbortError is explicitly excluded and NEVER retried.
 */
function isTransientError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return false;
  const msg = err instanceof Error ? err.message : String(err);
  // HTTP status codes in the message (common provider SDKs include them).
  const statusMatch = /(?:status|http|response)[^\d]*(\d{3})/i.exec(msg) ?? /\b(\d{3})\b/.exec(msg);
  if (statusMatch) {
    const code = parseInt(statusMatch[1]!, 10);
    if (code === 429) return true;
    if (code >= 500 && code < 600) return true;
    if (code >= 400 && code < 500) return false; // 4xx (other than 429) are not retryable
  }
  // Network-level errors (ECONNRESET, ETIMEDOUT, ENOTFOUND, fetch failed, etc.)
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|network|fetch failed|timeout|socket hang up/i.test(msg)) return true;
  // Rate-limit / overloaded signals from provider messages
  if (/rate.?limit|too many requests|overloaded|service unavailable|bad gateway/i.test(msg)) return true;
  return false;
}

/** Sleep for `ms` milliseconds, but abort early when the signal fires. */
function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("AbortError", "AbortError")); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("AbortError", "AbortError")); }, { once: true });
  });
}

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

/**
 * Run a guardrail chain over `text`. Returns the (possibly-redacted) final text, or throws a
 * special sentinel if any guardrail blocks.
 *
 * Returns `{ text: finalText }` on allow/redact, or `{ blocked }` on first block.
 */
async function runGuardrails(
  guardrails: GuardrailPort[],
  text: string,
  check: "checkInput" | "checkOutput",
  ctx: GuardrailContext,
): Promise<
  | { text: string; blocked?: undefined }
  | { blocked: { reason: string; code?: string; severity?: "low" | "medium" | "high" }; text?: undefined }
> {
  let current = text;
  for (const g of guardrails) {
    const fn = g[check];
    if (!fn) continue;
    const result = await fn.call(g, current, ctx);
    if (result.action === "block") {
      return {
        blocked: {
          reason: result.reason,
          ...(result.code !== undefined ? { code: result.code } : {}),
          ...(result.severity !== undefined ? { severity: result.severity } : {}),
        },
      };
    }
    if (result.action === "redact") current = result.text;
    // action === "allow": pass through unchanged
  }
  return { text: current };
}

function applyGuardrailRedaction(input: string, checkedText: string, redactedText: string): string {
  if (checkedText === redactedText) return input;
  if (input === checkedText) return redactedText;

  const multimodal = decodeMultimodalInput(input);
  if (multimodal) {
    const extractedText = extractTextFromBlocks(multimodal);
    if (checkedText === extractedText) {
      return encodeMultimodalInput(replaceTextBlocks(multimodal, redactedText));
    }
    if (checkedText.length > 0 && extractedText.includes(checkedText)) {
      const sanitizedText = extractedText.split(checkedText).join(redactedText);
      return encodeMultimodalInput(replaceTextBlocks(multimodal, sanitizedText));
    }
    // A redaction that cannot be mapped back to the original envelope must fail closed:
    // retain non-text blocks, but discard all unchecked text rather than persisting it.
    return encodeMultimodalInput(replaceTextBlocks(multimodal, redactedText));
  }

  if (checkedText.length > 0 && input.includes(checkedText)) {
    return input.split(checkedText).join(redactedText);
  }
  // The caller supplied a separately assembled guardrail segment that cannot be located in
  // the prompt. Persisting the unchecked prompt would defeat the guardrail contract.
  return redactedText;
}

function replaceTextBlocks(content: ContentBlock[], text: string): ContentBlock[] {
  let replaced = false;
  return content.map((block) => {
    if (!isText(block)) return block;
    if (replaced) return { ...block, text: "" };
    replaced = true;
    return { ...block, text };
  });
}

/** USD for a usage at a model's price (per 1M tokens). Returns undefined when no price covers the model. */
function usdFor(usage: Usage, prices: PriceTable | undefined, modelId: string | undefined): number | undefined {
  if (!prices || !modelId) return undefined;
  const p = prices[modelId];
  if (!p) return undefined;
  const cachedToks = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const uncachedToks = usage.inputTokens - cachedToks;
  const cacheRate = p.cachedInputPerMTok ?? p.inputPerMTok;
  return (
    uncachedToks * p.inputPerMTok +
    cachedToks * cacheRate +
    usage.outputTokens * p.outputPerMTok
  ) / 1_000_000;
}

/** Build the CostBreakdown for the current accumulated foreground usage, folding in tree-child usage. */
function breakdownFor(
  usage: Usage,
  prices: PriceTable | undefined,
  modelId: string | undefined,
  budget?: TreeBudget,
): CostBreakdown {
  // Tree-aware USD: this run's foreground priced at its own model, PLUS children's already-priced usd.
  const ownUsd = usdFor(usage, prices, modelId);
  const childrenUsd = budget?.usd ?? 0;
  const usd = ownUsd !== undefined ? ownUsd + childrenUsd : (childrenUsd > 0 ? childrenUsd : undefined);
  return {
    foreground: usage,
    background: { ...ZERO_USAGE },
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    ...(budget && (budget.usage.inputTokens > 0 || budget.usage.outputTokens > 0)
      ? { children: { ...budget.usage } }
      : {}),
    ...(usd !== undefined ? { usd } : {}),
  };
}

/**
 * Build the typed `details` payload for a terminal `result` event.
 * Only subtypes with structured payloads are populated; others return an identity object.
 * All parameters are optional so callers only pass what they have available.
 */
function buildDetails(
  subtype: string,
  opts?: {
    usdSpent?: number;
    usdLimit?: number;
    tokensUsed?: number;
    tokenLimit?: number;
    elapsedMs?: number;
    limitMs?: number;
    turns?: number;
    turnLimit?: number;
    errorName?: string;
    errorKind?: "structured_output_parse" | "structured_output_validation";
    validationIssues?: string[];
    rawOutput?: string;
    guardrailReason?: string;
    guardrailCode?: string;
    guardrailSeverity?: "low" | "medium" | "high";
    callId?: string;
    toolName?: string;
  },
): ResultDetails | undefined {
  switch (subtype) {
    case "max_cost":
      if (opts?.usdSpent !== undefined && opts.usdLimit !== undefined) {
        return { subtype: "max_cost", usdSpent: opts.usdSpent, usdLimit: opts.usdLimit };
      }
      return undefined;
    case "max_tokens":
      if (opts?.tokensUsed !== undefined && opts.tokenLimit !== undefined) {
        return { subtype: "max_tokens", tokensUsed: opts.tokensUsed, tokenLimit: opts.tokenLimit };
      }
      return undefined;
    case "max_wall_clock":
      if (opts?.elapsedMs !== undefined && opts.limitMs !== undefined) {
        return { subtype: "max_wall_clock", elapsedMs: opts.elapsedMs, limitMs: opts.limitMs };
      }
      return undefined;
    case "max_turns":
      if (opts?.turns !== undefined && opts.turnLimit !== undefined) {
        return { subtype: "max_turns", turns: opts.turns, limit: opts.turnLimit };
      }
      return undefined;
    case "error":
      return {
        subtype: "error",
        ...(opts?.errorName !== undefined ? { errorName: opts.errorName } : {}),
        ...(opts?.errorKind !== undefined ? { errorKind: opts.errorKind } : {}),
        ...(opts?.validationIssues !== undefined ? { validationIssues: opts.validationIssues } : {}),
        ...(opts?.rawOutput !== undefined ? { rawOutput: opts.rawOutput } : {}),
      };
    case "suspended":
      return { subtype: "suspended", ...(opts?.callId !== undefined ? { callId: opts.callId } : {}), ...(opts?.toolName !== undefined ? { toolName: opts.toolName } : {}) };
    case "success":
      return { subtype: "success" };
    case "aborted":
      return { subtype: "aborted" };
    case "guardrail":
      return {
        subtype: "guardrail",
        ...(opts?.guardrailReason !== undefined ? { reason: opts.guardrailReason } : {}),
        ...(opts?.guardrailCode !== undefined ? { code: opts.guardrailCode } : {}),
        ...(opts?.guardrailSeverity !== undefined ? { severity: opts.guardrailSeverity } : {}),
      };
    default:
      return undefined;
  }
}

/**
 * Preflight: returns the abort `TerminationSubtype` if any hard ceiling is met/exceeded, else null.
 * Ordering mirrors §11.2: cost → tokens → wall-clock → iterations.
 */
function preflightAbort(
  policy: CostPolicy,
  usage: Usage,
  turn: number,
  elapsedMs: number,
  usd: number | undefined,
): "max_cost" | "max_tokens" | "max_wall_clock" | "max_turns" | null {
  if (policy.maxCostUsd !== undefined && usd !== undefined && usd >= policy.maxCostUsd) return "max_cost";
  const totalTokens = usage.inputTokens + usage.outputTokens;
  if (policy.maxTokens !== undefined && totalTokens >= policy.maxTokens) return "max_tokens";
  if (policy.maxWallClockMs !== undefined && elapsedMs >= policy.maxWallClockMs) return "max_wall_clock";
  if (policy.maxTurns !== undefined && turn >= policy.maxTurns) return "max_turns";
  return null;
}

/** Build the initial model message list once: system+memory prefix, then replay the event log. */
function buildInitialMessages(
  args: RunTurnArgs,
  blocks: MemoryBlock[],
  recall: { text: string; metadata?: { source?: string; page?: number; [k: string]: unknown } }[],
): ModelMessage[] {
  const memoryXml = blocks.length
    ? `\n\n<memory>\n${blocks.map((b) => `<${esc(b.label)} v=${b.version}${b.readOnly ? " readonly" : ""}>\n${esc(b.value)}\n</${esc(b.label)}>`).join("\n")}\n</memory>`
    : "";
  // Fix 2: apply maxRecallTokens cap — include snippets (highest-ranked first, as returned by
  // memory.retrieve()) until adding the next one would exceed the budget. At least one snippet
  // is always included so the cap never silently drops the most relevant result.
  // Token estimate: chars / 4 (same heuristic as compaction.estimateTokens).
  const maxRecallTok = args.maxRecallTokens ?? DEFAULT_MAX_RECALL_TOKENS;
  let cappedRecall = recall;
  if (recall.length > 0) {
    const kept: typeof recall = [];
    let tokensSoFar = 0;
    for (const snippet of recall) {
      const snippetTokens = Math.ceil((snippet.text.length + (snippet.metadata?.source ? String(snippet.metadata.source).length : 0)) / 4);
      if (kept.length > 0 && tokensSoFar + snippetTokens > maxRecallTok) break;
      kept.push(snippet);
      tokensSoFar += snippetTokens;
    }
    cappedRecall = kept;
  }
  // Feature 3: include source citation when metadata.source is present, e.g. `- [source: X] <text>`
  // Fix 3: esc() now strips newlines/control-chars so a source with "\n- [source: forged]" cannot
  // inject a fake recall line (newlines are replaced with spaces before XML-escaping).
  const recallXml = cappedRecall.length
    ? `\n\n<recall>\n${cappedRecall.map((r) => {
        const src = r.metadata?.source ? `[source: ${esc(String(r.metadata.source))}] ` : "";
        return `- ${src}${esc(r.text)}`;
      }).join("\n")}\n</recall>`
    : "";
  const skillsXml = args.skillCatalog && args.skillCatalog.length
    ? `\n\n<skills>\n${args.skillCatalog.map((s) => `- ${esc(s.name)}: ${esc(s.description)}`).join("\n")}\n</skills>`
    : "";
  const system = args.instructions + memoryXml + recallXml + skillsXml;
  const messages: ModelMessage[] = [{ role: "system", content: system }];
  for (const e of args.session.events()) appendEventToMessages(messages, e);
  return messages;
}

/** Map one persisted event into the running model-message list (used for initial replay AND incremental append). */
function appendEventToMessages(messages: ModelMessage[], e: StoredEvent): void {
  if (e.kind === "compaction") return; // audit marker only (§4.4, Plan 15); never a model message on replay.
  if (e.kind === "suspension") return; // audit marker only (§5.7/§9.4, Plan 16); never a model message on replay.
  // Resume rebuilds from the full event log and then re-compacts — compaction events are ignored so
  // the window is faithfully reconstructed from the real user/assistant/tool_result events first.
  if (e.kind === "user") messages.push({ role: "user", content: String(e.payload) });
  else if (e.kind === "assistant") {
    // Shape guard: payload must be an object with a `content` array.
    const p = e.payload;
    if (
      typeof p !== "object" || p === null ||
      !Array.isArray((p as Record<string, unknown>).content)
    ) {
      throw new Error(
        `appendEventToMessages: corrupt "assistant" event (id=${e.id}): ` +
        `payload.content must be an array, got ${JSON.stringify(p)}`,
      );
    }
    messages.push({ role: "assistant", content: (p as { content: ContentBlock[] }).content });
  } else if (e.kind === "tool_result") {
    // Shape guard: payload must have callId (string), toolName (string), output (any).
    const p = e.payload;
    if (
      typeof p !== "object" || p === null ||
      typeof (p as Record<string, unknown>).callId !== "string" ||
      typeof (p as Record<string, unknown>).toolName !== "string" ||
      !("output" in (p as Record<string, unknown>))
    ) {
      throw new Error(
        `appendEventToMessages: corrupt "tool_result" event (id=${e.id}): ` +
        `payload must have {callId: string, toolName: string, output: any}, got ${JSON.stringify(p)}`,
      );
    }
    const tp = p as { callId: string; toolName: string; output: unknown };
    messages.push({ role: "tool", callId: tp.callId, toolName: tp.toolName, content: JSON.stringify(tp.output) });
  }
  // tool_call / checkpoint kinds are not produced by the loop today; ignored on replay.
}

/** Attempt a session.append; on failure, yield a terminal error event and return `null`. */
async function* safeAppend(
  session: Session,
  kind: Parameters<Session["append"]>[0],
  payload: unknown,
  meta: Parameters<Session["append"]>[2],
  usage: Usage,
  turn: number,
): AsyncGenerator<StreamEvent, StoredEvent | null> {
  try {
    return await session.append(kind, payload, meta);
  } catch (err) {
    yield {
      type: "result", subtype: "error",
      output: err instanceof Error ? err.message : String(err),
      usage, numTurns: turn, sessionId: session.id,
      cost: { foreground: usage, background: { inputTokens: 0, outputTokens: 0 }, cachedInputTokens: 0 },
    };
    return null;
  }
}

/**
 * Write a checkpoint marker using the supplied pre-computed rolling hash.
 * No-op when durable is not configured (fast path).
 */
async function writeCheckpointWith(args: RunTurnArgs, hash: string): Promise<void> {
  if (!args.durable) return;
  await args.durable.writeCheckpoint(args.session.id, args.session.seq, hash);
}

/**
 * Emit a terminal `result{subtype:"aborted"}` event and, if durable, write a checkpoint (§16.4).
 * Mirrors the preflightAbort terminal path in runLoop. Call this at every abort boundary.
 */
async function* emitAborted(
  args: RunTurnArgs,
  usage: Usage,
  turn: number,
  rollingHash: string,
  endRoot: (u: Usage, status?: "ok" | "error", message?: string) => void,
): AsyncGenerator<StreamEvent, void> {
  if (args.durable) {
    await writeCheckpointWith(args, rollingHash);
  }
  yield {
    type: "result",
    subtype: "aborted",
    usage,
    numTurns: turn,
    sessionId: args.session.id,
    cost: breakdownFor(usage, args.prices, args.modelId, args.budget),
    details: buildDetails("aborted"),
  };
  endRoot(usage, "error", "aborted");
}

/**
 * Incrementally update the rolling hash by chaining one new event's canonical projection
 * ({kind, payload}) onto the previous hash. O(1) per event vs. O(n) for hashing the full log.
 * @param prev - current rolling hash hex string (empty string for the initial state)
 * @param event - the newly appended event
 *
 * Exported for testing: Fix 6 tests verify that delta-seeded hash == full-rehash.
 */
export async function chainHash(prev: string, event: StoredEvent): Promise<string> {
  // Chain: sha256(prev_hex + canonical_json({kind, payload}))
  // The canonical JSON matches replayHash's projection so the two are comparable per-event.
  const projection = canonicalJson({ kind: event.kind, payload: event.payload });
  return sha256Hex(prev + projection);
}

/** Total token + usd spend of the tree: this run's foreground plus the accumulated child budget. */
function treeSpend(
  usage: Usage,
  prices: PriceTable | undefined,
  modelId: string | undefined,
  budget: TreeBudget | undefined,
): { usage: Usage; usd: number | undefined } {
  const childUsage = budget?.usage ?? ZERO_USAGE;
  const combined: Usage = {
    inputTokens: usage.inputTokens + childUsage.inputTokens,
    outputTokens: usage.outputTokens + childUsage.outputTokens,
  };
  const ownUsd = usdFor(usage, prices, modelId);
  const childUsd = budget?.usd ?? 0;
  const usd = ownUsd !== undefined ? ownUsd + childUsd : (childUsd > 0 ? childUsd : undefined);
  return { usage: combined, usd };
}

/**
 * The shared model→tool loop. Drives model calls, persists assistant + tool_result events,
 * checkpoints after each model call and each tool batch (when durable), and terminates on
 * a tool-less assistant turn or max_turns. Used by both runTurn and resumeTurn.
 *
 * `startRollingHash` seeds the incremental checkpoint hash (Fix 3: O(1) per checkpoint).
 * Pass the hash of already-persisted events on resume; pass "" for a fresh run.
 *
 * `pendingCalls` — when non-empty, these tool calls are dispatched FIRST (before the initial
 * model call) using the existing dispatch path. Used by resumeTurn to re-dispatch persisted
 * pending tool calls that were interrupted mid-batch (callId-stable, no model re-emit).
 */
async function* runLoop(
  args: RunTurnArgs,
  messages: ModelMessage[],
  startUsage: Usage,
  startTurn: number,
  startRollingHash = "",
  pendingCalls: ToolCall[] = [],
): AsyncGenerator<StreamEvent, void> {
  // Plan 19 (§5.4): full permission-filtered catalog (stable for the run); lazy mode prunes it per turn.
  const fullSchemas = args.registry.schemas();
  const lazy = args.lazyTools;
  // Lazy activates only when the toolset actually exceeds the threshold (invariant a: small ⇒ unchanged).
  const lazyActive = lazy !== undefined && fullSchemas.length > lazy.threshold;

  // Fix 1: maintain an incremental loaded-set instead of re-scanning the full event log each turn.
  // Seed from the current event log once (initial replay / resume). Subsequent load_tool results
  // are applied incrementally via `applyLoadToolResult()` in the tool-result processing loop below.
  // This turns an O(n²) scan (called every turn) into a one-time O(n) seed + O(1) per turn.
  // Behavior is identical to loadedToolNames(session.events(), eager) at every turn boundary —
  // the set always reflects exactly the load_tool results seen so far.
  const incrementalLoaded: Set<string> = lazyActive
    ? loadedToolNames(args.session.events(), lazy!.eager)
    : new Set();

  /** Apply a just-processed tool_result event to the incremental loaded-set if it was a load_tool. */
  const applyLoadToolResult = (r: ToolResult): void => {
    if (!lazyActive) return;
    if (r.toolName !== "load_tool") return;
    const out = r.output as { ok?: boolean; loaded?: unknown };
    if (out?.ok === true && Array.isArray(out.loaded)) {
      for (const n of out.loaded) if (typeof n === "string") incrementalLoaded.add(n);
    }
  };

  const buildManifest = (): import("@eidentic/types").ToolSchema[] => {
    if (!lazyActive) return fullSchemas; // byte-identical: same reference (invariant a)
    // Fix 1: use the incrementally-maintained set (O(1)) instead of loadedToolNames(events(), …) (O(n)).
    return lazyManifest(fullSchemas, { active: true, eager: lazy!.eager, loaded: incrementalLoaded });
  };

  // Default to envLogger so warn/error always surface even when called without a logger.
  const logger = args.logger ?? envLogger();

  let usage = startUsage;
  let turn = startTurn;

  // Unify the legacy `maxTurns` arg under the policy: policy.maxTurns wins; else legacy; else 16.
  const policy: CostPolicy = { ...args.policy };
  if (policy.maxTurns === undefined) policy.maxTurns = args.maxTurns ?? 16;
  const monotonicNow = args.monotonicNow ?? Date.now;
  const startMs = monotonicNow();
  let softFired = false;

  // Warn once if a USD ceiling is set but prices+modelId are not configured (ceiling will never fire).
  if ((policy.maxCostUsd !== undefined || policy.softCostUsd !== undefined) && (!args.prices || !args.modelId)) {
    logger.log("warn", "eidentic:cost", "policy.maxCostUsd/softCostUsd is set but no prices+modelId configured — USD cost ceilings will not be enforced");
  }

  // --- OTel root span (§11.1): open once for the whole run; closed at every terminal exit ---
  const tracer = args.tracer;
  const rootSpan = tracer?.startSpan("gen_ai.invoke_agent", {
    "gen_ai.agent.id": args.agentId,
    "eidentic.scope": scopeKey(args.scope),
  });

  /** Close the root span with final accumulated usage + optional cost. */
  const endRoot = (final: Usage, status: "ok" | "error" = "ok", message?: string): void => {
    if (!rootSpan) return;
    rootSpan.setAttribute("gen_ai.usage.input_tokens", final.inputTokens);
    rootSpan.setAttribute("gen_ai.usage.output_tokens", final.outputTokens);
    const cached = final.cachedInputTokens ?? 0;
    if (cached > 0) rootSpan.setAttribute("gen_ai.usage.cached_input_tokens", cached);
    const hitRate = final.inputTokens > 0 ? cached / final.inputTokens : 0;
    rootSpan.setAttribute("eidentic.kv_cache_hit_rate", hitRate);
    const usd = usdFor(final, args.prices, args.modelId);
    if (usd !== undefined) rootSpan.setAttribute("eidentic.cost_usd", usd);
    rootSpan.setStatus(status, message);
    rootSpan.end();
  };

  // Rolling hash for incremental O(1) checkpoints (Fix 3).
  // Seeds from the already-persisted events on resume; "" on a fresh run.
  let rollingHash = startRollingHash;

  // --- Pending-calls re-dispatch (resume fix): if pendingCalls is non-empty, dispatch them
  // directly using the same path as the normal loop (idempotency ledger, permission gate,
  // ctx.suspend, append tool_result events, checkpoints, SuspendSignal handling).
  // This runs BEFORE the first model call so the provider never sees a dangling tool_use.
  // The callIds/names/inputs are taken directly from the persisted assistant event, so
  // idempotency keys and suspend decisions (keyed by (sessionId, callId)) hit correctly.
  if (pendingCalls.length > 0) {
    let pendingResults: ToolResult[];
    try {
      pendingResults = await args.registry.dispatch(pendingCalls);
    } catch (e) {
      if (e instanceof SuspendSignal) {
        // The tool is still pending a decision — re-suspend cleanly without a new suspension event.
        // (The original suspension event is already in the log; we just need to yield the terminal.)
        const pendingSuspToolName = pendingCalls.find((c) => c.callId === e.callId)?.name;
        yield {
          type: "result",
          subtype: "suspended",
          request: e.request,
          callId: e.callId,
          usage,
          numTurns: turn,
          sessionId: args.session.id,
          cost: breakdownFor(usage, args.prices, args.modelId, args.budget),
          details: buildDetails("suspended", { callId: e.callId, toolName: pendingSuspToolName }),
        };
        endRoot(usage);
        return;
      }
      throw e;
    }
    for (const r of pendingResults) {
      const toolSpan = args.tracer?.startSpan("gen_ai.execute_tool", { "gen_ai.tool.name": r.toolName });
      toolSpan?.setStatus(r.isError ? "error" : "ok");
      toolSpan?.end();

      let toolEvent: StoredEvent | null = null;
      {
        const gen = safeAppend(args.session, "tool_result", { callId: r.callId, toolName: r.toolName, output: r.output }, undefined, usage, turn);
        let step = await gen.next();
        while (!step.done) { yield step.value as StreamEvent; step = await gen.next(); }
        toolEvent = step.value as StoredEvent | null;
      }
      if (toolEvent === null) {
        rootSpan?.setStatus("error", "append failed");
        rootSpan?.end();
        return;
      }
      appendEventToMessages(messages, toolEvent);
      rollingHash = await chainHash(rollingHash, toolEvent);
      // Fix 1: update incremental loaded-set for load_tool results (O(1) per call vs O(n) rescan).
      applyLoadToolResult(r);
      yield { type: "tool.result", callId: r.callId, toolName: r.toolName, output: r.output, isError: r.isError };
    }
    await writeCheckpointWith(args, rollingHash); // checkpoint after the re-dispatched tool batch
  }

  // Feature 2: structured-output validation retry budget. Tracks how many corrective re-calls
  // remain when the model's final answer fails schema validation. Initialized once before the
  // loop; decremented each time a corrective retry is attempted.
  // Default: ON with maxAttempts=2 (i.e. 2 retries beyond the first call). Setting maxAttempts=0
  // disables retries entirely (validation failure is immediately terminal — previous behavior).
  const soMaxRetries = args.structuredOutputRetry !== undefined
    ? args.structuredOutputRetry.maxAttempts
    : 2; // default ON
  let soRetriesLeft = soMaxRetries;

  while (true) {
    // --- §16.4 abort boundary: top of turn, BEFORE compaction + model call ---
    if (args.signal?.aborted) {
      logger.log("debug", "eidentic:loop", "abort signal received at turn start", { turn });
      yield* emitAborted(args, usage, turn, rollingHash, endRoot);
      return;
    }

    // --- Plan 15: pre-model-call compaction (§4.4) — runs before cost preflight + model call ---
    // No-compaction-config path is byte-for-byte unchanged: no estimate, no compaction, no events.
    if (args.compaction) {
      const estTokens = estimateTokens(messages);
      const maxContextTokens = args.compaction.maxContextTokens ?? 100_000;
      if (estTokens > maxContextTokens) {
        // Fire the archive hook FIRST so the caller can capture the full transcript before any drop.
        await args.onPreCompact?.({ messages, estTokens });
        const { messages: next, compacted, before, after, stages } = compactMessages(messages, args.compaction);
        if (compacted) {
          // Replace the in-memory window in place (runLoop holds `messages` by reference).
          // §4.3: this invalidates KV-cache from this point — accepted and rare (gated by budget).
          messages.length = 0;
          messages.push(...next);
          // Audit: append a `compaction` marker to the session log. The log itself is NOT mutated;
          // this is an additive marker so resume rebuilds from the full log then re-compacts.
          {
            const gen = safeAppend(args.session, "compaction", { before, after, stages }, undefined, usage, turn);
            let step = await gen.next();
            while (!step.done) { yield step.value as StreamEvent; step = await gen.next(); }
            const ev = step.value as StoredEvent | null;
            if (ev === null) {
              rootSpan?.setStatus("error", "append failed");
              rootSpan?.end();
              return;
            }
            rollingHash = await chainHash(rollingHash, ev);
          }
          yield { type: "compaction", before, after, stages, sessionId: args.session.id };
        }
      }
    }

    // --- onTurnStart: per-turn ephemeral context injection ---
    // Called before each model call. Returned string(s) are appended as a <system-reminder> user
    // message for THIS turn only. NOT persisted to the event log; NOT replayed on resume. Each
    // turn gets a fresh call. A throwing hook is swallowed (logged + continue).
    // The injected message is removed from the window immediately after the model call (below)
    // so it does not appear in subsequent turns or in the persisted event log.
    let turnStartInjected = false;
    if (args.onTurnStart) {
      try {
        const injected = await args.onTurnStart({ sessionId: args.session.id, turn });
        if (injected !== undefined && injected !== null) {
          const parts = Array.isArray(injected) ? injected : [injected];
          const joined = parts.filter((p) => typeof p === "string" && p.length > 0).join("\n");
          if (joined.length > 0) {
            messages.push({ role: "user", content: `<system-reminder>\n${joined}\n</system-reminder>` });
            turnStartInjected = true;
          }
        }
      } catch (err) {
        logger.log("warn", "eidentic:loop", `onTurnStart hook threw (swallowed): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // --- Cost governor preflight (§11.2 + §8.6 tree budget): enforce BEFORE the next model call ---
    const tree = treeSpend(usage, args.prices, args.modelId, args.budget);
    const abort = preflightAbort(policy, tree.usage, turn, monotonicNow() - startMs, tree.usd);
    if (abort) {
      logger.log("debug", "eidentic:cost", "preflight abort", { subtype: abort, turn, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
      const elapsedMs = monotonicNow() - startMs;
      yield {
        type: "result",
        subtype: abort,
        usage,
        numTurns: turn,
        sessionId: args.session.id,
        cost: breakdownFor(usage, args.prices, args.modelId, args.budget),
        details: buildDetails(abort, {
          usdSpent: tree.usd,
          usdLimit: policy.maxCostUsd,
          tokensUsed: tree.usage.inputTokens + tree.usage.outputTokens,
          tokenLimit: policy.maxTokens,
          elapsedMs,
          limitMs: policy.maxWallClockMs,
          turns: turn,
          turnLimit: policy.maxTurns,
        }),
      };
      endRoot(usage, "error", abort);
      return;
    }

    // Soft cap (§11.2): fire onCostThreshold once when softCostUsd is first crossed. Does NOT abort.
    if (!softFired && policy.softCostUsd !== undefined && tree.usd !== undefined && tree.usd >= policy.softCostUsd) {
      softFired = true;
      args.onCostThreshold?.({ usd: tree.usd, cost: breakdownFor(usage, args.prices, args.modelId, args.budget), numTurns: turn });
    }

    // --- OTel chat span: one per model call (§11.1) ---
    const chatSpan = tracer?.startSpan("gen_ai.chat", args.modelId ? { "gen_ai.request.model": args.modelId } : {});

    const toolSchemas = buildManifest(); // Plan 19: recomputed each turn from the event log (invariant b)

    if (logger.enabled?.("debug", "eidentic:loop") ?? false) {
      logger.log("debug", "eidentic:loop", "model call", { turn: turn + 1, messageCount: messages.length, toolCount: toolSchemas.length });
    }

    // Structured output (D2): forward the JSON Schema on every turn so the provider constrains the
    // FINAL (tool-less) turn. Intermediate tool-calling turns ignore it (no structured object set).
    const outputSchemaArg = args.outputSchema ? { outputSchema: args.outputSchema.json } : {};
    // D6: prompt-cache hint forwarded to the model adapter on every turn.
    const cacheControlArg = args.promptCache ? { cacheControl: true as const } : {};

    // Feature 1 (fallback chain): build the ordered list of models to try.
    // Primary is always first; fallbacks follow in config order.
    const fallbacks = args.modelFallback ?? [];
    const modelsToTry: ModelPort[] = [args.model, ...fallbacks];

    let response: ModelResponse;
    let modelError: unknown;
    let resolved = false;

    // Streaming path uses a separate generator so we can track whether any delta
    // was emitted BEFORE a failure. Once a delta is yielded to the consumer, we
    // cannot fall back (the stream has started — rewinding is impossible).
    let deltaEmittedBeforeError = false;

    for (let mi = 0; mi < modelsToTry.length; mi++) {
      const candidate = modelsToTry[mi]!;
      const isFallback = mi > 0;

      if (candidate.stream) {
        // Streaming path: fallback is ONLY allowed when no delta has been emitted yet.
        // After the first delta, the consumer has already received data — no fallback.
        let localDeltaEmitted = false;
        let localFinal: ModelResponse | undefined;
        let streamError: unknown = undefined;

        try {
          for await (const part of candidate.stream({ messages, tools: toolSchemas, ...outputSchemaArg, ...cacheControlArg, ...(args.signal ? { signal: args.signal } : {}) })) {
            // §16.4: break delta iteration when aborted.
            if (args.signal?.aborted) break;
            if (part.type === "delta") {
              localDeltaEmitted = true;
              yield { type: "stream.delta", delta: part.delta };
            } else if (localFinal === undefined) {
              localFinal = part.response;
            }
          }
        } catch (err) {
          streamError = err;
        }

        // Abort: propagate immediately — never fall back.
        if (args.signal?.aborted) {
          yield* emitAborted(args, usage, turn, rollingHash, endRoot);
          chatSpan?.setStatus("ok");
          chatSpan?.end();
          return;
        }

        if (streamError !== null && streamError !== undefined) {
          // AbortError: propagate immediately.
          if (streamError instanceof Error && streamError.name === "AbortError") {
            yield* emitAborted(args, usage, turn, rollingHash, endRoot);
            chatSpan?.setStatus("ok");
            chatSpan?.end();
            return;
          }
          if (localDeltaEmitted) {
            // Delta was emitted — stream started, cannot fall back. Terminate with error.
            deltaEmittedBeforeError = true;
            modelError = streamError;
            break; // stop trying fallbacks
          }
          // No delta emitted yet — safe to try next fallback.
          if (isFallback) {
            logger.log("debug", "eidentic:loop", "fallback model stream failed — trying next", { fallbackIndex: mi, err: String(streamError) });
          }
          modelError = streamError;
          continue; // try next fallback
        }

        if (!localFinal) {
          // Stream ended without a final response and without an error/abort.
          const noFinalErr = new Error("model stream ended without a final response");
          if (localDeltaEmitted) {
            // Cannot fall back — stream already started.
            deltaEmittedBeforeError = true;
            modelError = noFinalErr;
            break;
          }
          modelError = noFinalErr;
          continue;
        }

        // Success: stream completed with a final response.
        response = localFinal;
        resolved = true;
        break;
      } else {
        // Non-streaming path: eligible for retry on transient failures (Feature 1).
        const retry = args.modelRetry;
        // Fix 4: clamp maxAttempts to at least 1 so maxAttempts:0 never falls through to an
        // unguarded model.complete() call below the loop. The intent is "retry disabled" (one
        // attempt), not "skip the guarded path". Math.max(1, ...) preserves that contract.
        const maxAttempts = retry ? Math.max(1, retry.maxAttempts) : 1;
        const backoffMs = retry?.backoffMs ?? 0;
        const req = { messages, tools: toolSchemas, ...outputSchemaArg, ...cacheControlArg, ...(args.signal ? { signal: args.signal } : {}) };
        let candidateError: unknown;
        let candidateResolved = false;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          // AbortError: never retry — propagate immediately.
          if (args.signal?.aborted) {
            yield* emitAborted(args, usage, turn, rollingHash, endRoot);
            chatSpan?.setStatus("ok");
            chatSpan?.end();
            return;
          }
          if (attempt > 0 && backoffMs > 0) {
            try { await sleepWithSignal(backoffMs, args.signal); }
            catch {
              yield* emitAborted(args, usage, turn, rollingHash, endRoot);
              chatSpan?.setStatus("ok");
              chatSpan?.end();
              return;
            }
          }
          try {
            response = await candidate.complete(req);
            candidateResolved = true;
            break;
          } catch (err) {
            // AbortError is never transient: propagate immediately.
            if (args.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
              yield* emitAborted(args, usage, turn, rollingHash, endRoot);
              chatSpan?.setStatus("ok");
              chatSpan?.end();
              return;
            }
            candidateError = err;
            const isLast = attempt === maxAttempts - 1;
            if (!isTransientError(err) || isLast) break; // stop retrying this candidate
            logger.log("debug", "eidentic:loop", "transient model error — retrying", { attempt: attempt + 1, maxAttempts, err: String(err) });
          }
        }
        if (candidateResolved) {
          resolved = true;
          modelError = undefined;
          break;
        }
        // This candidate exhausted — record error and try next.
        modelError = candidateError;
        if (isFallback) {
          logger.log("debug", "eidentic:loop", "fallback model failed — trying next", { fallbackIndex: mi, err: String(candidateError) });
        }
      }
    }

    if (!resolved!) {
      // All models (primary + fallbacks) failed. Emit terminal error.
      const rawErr = modelError instanceof Error ? modelError.message : String(modelError ?? "unknown model error");
      const truncatedErr = rawErr.length > 500 ? rawErr.slice(0, 500) + "…(truncated)" : rawErr;
      chatSpan?.setStatus("error", truncatedErr);
      chatSpan?.end();
      yield {
        type: "result", subtype: "error",
        output: truncatedErr,
        usage, numTurns: turn, sessionId: args.session.id,
        cost: breakdownFor(usage, args.prices, args.modelId, args.budget),
        details: buildDetails("error", { errorName: modelError instanceof Error ? modelError.name : undefined }),
      };
      endRoot(usage, "error", modelError instanceof Error ? modelError.name : "model error");
      return;
    }
    // Suppress TS "used before assigned" — resolved === true guarantees response was assigned.
    response = response!;

    // Remove the ephemeral onTurnStart injection from the window immediately after the model call.
    // It was pushed as the last message before the call; pop it now so subsequent turns and the
    // persistent event log never see it.
    if (turnStartInjected) {
      messages.pop();
      turnStartInjected = false;
    }

    turn++;
    usage = addUsage(usage, response.usage);

    const hasToolUses = response.content.filter(isToolUse).length > 0;
    if (logger.enabled?.("debug", "eidentic:loop") ?? false) {
      logger.log("debug", "eidentic:loop", "model result", {
        turn,
        subtype: hasToolUses ? "tool_use" : "text",
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      });
    }

    // Record per-call usage on the chat span and close it.
    chatSpan?.setAttribute("gen_ai.usage.input_tokens", response.usage.inputTokens);
    chatSpan?.setAttribute("gen_ai.usage.output_tokens", response.usage.outputTokens);
    chatSpan?.setStatus("ok");
    chatSpan?.end();

    // --- §16.4 abort boundary: after model call + usage accounting ---
    if (args.signal?.aborted) {
      yield* emitAborted(args, usage, turn, rollingHash, endRoot);
      return;
    }

    const toolUses = response.content.filter(isToolUse);
    let assistantContent = response.content;
    let terminalText: string | undefined;
    if (toolUses.length === 0) {
      let text = response.content.filter(isText).map((b) => b.text).join("");
      if (args.guardrails && args.guardrails.length > 0) {
        const guardrailCtx: GuardrailContext = { agentId: args.agentId, sessionId: args.session.id, source: "output" };
        const gr = await runGuardrails(args.guardrails, text, "checkOutput", guardrailCtx);
        if (gr.blocked !== undefined) {
          logger.log("debug", "eidentic:loop", "output blocked by guardrail", { reason: gr.blocked.reason, code: gr.blocked.code, numTurns: turn });
          yield {
            type: "result",
            subtype: "guardrail",
            output: `Output blocked by guardrail: ${gr.blocked.reason}`,
            usage,
            numTurns: turn,
            sessionId: args.session.id,
            cost: breakdownFor(usage, args.prices, args.modelId, args.budget),
            details: buildDetails("guardrail", {
              guardrailReason: gr.blocked.reason,
              guardrailCode: gr.blocked.code,
              guardrailSeverity: gr.blocked.severity,
            }),
          };
          endRoot(usage, "error", "guardrail");
          return;
        }
        text = gr.text;
        assistantContent = replaceTextBlocks(response.content, text);
      }
      terminalText = text;
    }

    let assistantEvent: StoredEvent | null = null;
    {
      const gen = safeAppend(args.session, "assistant", { content: assistantContent }, { usage: response.usage }, usage, turn);
      let step = await gen.next();
      while (!step.done) { yield step.value as StreamEvent; step = await gen.next(); }
      assistantEvent = step.value as StoredEvent | null;
    }
    if (assistantEvent === null) {
      rootSpan?.setStatus("error", "append failed");
      rootSpan?.end();
      return;
    }

    appendEventToMessages(messages, assistantEvent);
    // Feature 2: include per-turn usage so consumers can track spend incrementally.
    yield { type: "assistant", content: assistantContent, usage: response.usage };
    rollingHash = await chainHash(rollingHash, assistantEvent);
    await writeCheckpointWith(args, rollingHash); // checkpoint after the model call (§9.2 component 1)

    // Post-call ceiling check: abort immediately if the model's response pushed us past a limit.
    // B4 (durable consistency): this check runs AFTER the assistant event is persisted and
    // checkpointed, so a durable resume correctly sees the event and does not re-issue the call.
    // This catches the case where the terminal response (no tool uses) itself exceeds a ceiling.
    {
      const postTree = treeSpend(usage, args.prices, args.modelId, args.budget);
      const postElapsedMs = monotonicNow() - startMs;
      const postAbort = preflightAbort(policy, postTree.usage, turn, postElapsedMs, postTree.usd);
      if (postAbort) {
        logger.log("debug", "eidentic:cost", "post-call abort (event already persisted)", { subtype: postAbort, turn });
        yield {
          type: "result",
          subtype: postAbort,
          usage,
          numTurns: turn,
          sessionId: args.session.id,
          cost: breakdownFor(usage, args.prices, args.modelId, args.budget),
          details: buildDetails(postAbort, {
            usdSpent: postTree.usd,
            usdLimit: policy.maxCostUsd,
            tokensUsed: postTree.usage.inputTokens + postTree.usage.outputTokens,
            tokenLimit: policy.maxTokens,
            elapsedMs: postElapsedMs,
            limitMs: policy.maxWallClockMs,
            turns: turn,
            turnLimit: policy.maxTurns,
          }),
        };
        endRoot(usage, "error", postAbort);
        return;
      }
      // Soft cap (post-call): fire if not yet fired and threshold newly crossed.
      if (!softFired && policy.softCostUsd !== undefined && postTree.usd !== undefined && postTree.usd >= policy.softCostUsd) {
        softFired = true;
        args.onCostThreshold?.({ usd: postTree.usd, cost: breakdownFor(usage, args.prices, args.modelId, args.budget), numTurns: turn });
      }
    }

    if (args.memory) {
      const assistantText = assistantContent.filter(isText).map((b) => b.text).join("");
      if (assistantText) {
        // --- OTel memory.ingest span for assistant text (§11.1) ---
        const ingestSpan = tracer?.startSpan("memory.ingest", { "eidentic.scope": scopeKey(args.scope) });
        await args.memory.ingest([{ id: assistantEvent.id, scope: args.scope, text: assistantText }]);
        ingestSpan?.setStatus("ok");
        ingestSpan?.end();
      }
    }

    if (toolUses.length === 0) {
      const text = terminalText ?? assistantContent.filter(isText).map((b) => b.text).join("");

      // Structured output (D2): the terminal turn must satisfy the requested schema. The candidate
      // object comes from the model port (`response.object`) when available, else we parse the final
      // text as JSON (the port emitted the structured answer there). Validation is authoritative.
      if (args.outputSchema) {
        let candidate: unknown = response.object;
        let parseError = false;
        if (candidate === undefined) {
          try {
            candidate = JSON.parse(text);
          } catch {
            parseError = true;
          }
        }
        if (parseError) {
          // JSON parse failure: not retryable in a useful way (the model isn't even producing JSON).
          // Decrement retries and either retry with a corrective message or emit final error.
          if (soRetriesLeft > 0) {
            soRetriesLeft--;
            const corrective = `Your previous answer was not valid JSON. The schema requires a JSON object. Please respond with ONLY valid JSON that matches the required schema. Your invalid answer was: ${text.slice(0, 200)}`;
            logger.log("debug", "eidentic:loop", "structured output not parseable — retrying", { soRetriesLeft, numTurns: turn });
            // Persist the corrective message as a user event so durable resume can reconstruct
            // the full context window from the event log (M1 fix).
            let correctiveEvent: StoredEvent | null = null;
            {
              const gen = safeAppend(args.session, "user", corrective, undefined, usage, turn);
              let step = await gen.next();
              while (!step.done) { yield step.value as StreamEvent; step = await gen.next(); }
              correctiveEvent = step.value as StoredEvent | null;
            }
            if (correctiveEvent === null) return;
            appendEventToMessages(messages, correctiveEvent);
            rollingHash = await chainHash(rollingHash, correctiveEvent);
            continue; // re-enter the while loop to call the model again
          }
          logger.log("debug", "eidentic:loop", "structured output not parseable", { numTurns: turn });
          yield {
            type: "result", subtype: "error",
            output: `structured output requested but the model's final answer is not valid JSON: ${text.slice(0, 200)}`,
            usage, numTurns: turn, sessionId: args.session.id,
            cost: breakdownFor(usage, args.prices, args.modelId, args.budget),
            details: buildDetails("error", {
              errorName: "SyntaxError",
              errorKind: "structured_output_parse",
              rawOutput: text,
            }),
          };
          endRoot(usage, "error", "structured output parse error");
          return;
        }
        const validated = args.outputSchema.validate(candidate);
        if (!validated.ok) {
          // Feature 2: if retries remain, append a corrective message and continue the loop.
          if (soRetriesLeft > 0) {
            soRetriesLeft--;
            const corrective = `Your previous answer failed schema validation. Validation error: ${validated.error}. Please respond with ONLY valid JSON that satisfies the required schema.`;
            logger.log("debug", "eidentic:loop", "structured output failed validation — retrying", { soRetriesLeft, numTurns: turn });
            // Persist the corrective message as a user event so durable resume can reconstruct
            // the full context window from the event log (M1 fix).
            let correctiveEvent: StoredEvent | null = null;
            {
              const gen = safeAppend(args.session, "user", corrective, undefined, usage, turn);
              let step = await gen.next();
              while (!step.done) { yield step.value as StreamEvent; step = await gen.next(); }
              correctiveEvent = step.value as StoredEvent | null;
            }
            if (correctiveEvent === null) return;
            appendEventToMessages(messages, correctiveEvent);
            rollingHash = await chainHash(rollingHash, correctiveEvent);
            continue; // re-enter the while loop to call the model again
          }
          logger.log("debug", "eidentic:loop", "structured output failed schema validation", { numTurns: turn });
          yield {
            type: "result", subtype: "error",
            output: `structured output failed schema validation: ${validated.error}`,
            usage, numTurns: turn, sessionId: args.session.id,
            cost: breakdownFor(usage, args.prices, args.modelId, args.budget),
            details: buildDetails("error", {
              errorName: "ValidationError",
              errorKind: "structured_output_validation",
              validationIssues: validated.issues,
              rawOutput: text,
            }),
          };
          endRoot(usage, "error", "structured output validation error");
          return;
        }
        logger.log("debug", "eidentic:loop", "run complete", { subtype: "success", numTurns: turn, structured: true });
        yield {
          type: "result", subtype: "success", output: text, object: validated.value,
          usage, numTurns: turn, sessionId: args.session.id,
          cost: breakdownFor(usage, args.prices, args.modelId, args.budget),
          details: buildDetails("success"),
        };
        endRoot(usage);
        return;
      }

      logger.log("debug", "eidentic:loop", "run complete", { subtype: "success", numTurns: turn });
      yield {
        type: "result", subtype: "success", output: text,
        usage, numTurns: turn, sessionId: args.session.id,
        cost: breakdownFor(usage, args.prices, args.modelId, args.budget),
        details: buildDetails("success"),
      };
      endRoot(usage);
      return;
    }

    const calls: ToolCall[] = toolUses.map((b) => ({ callId: b.callId, name: b.name, input: b.input }));
    let results: ToolResult[];
    try {
      results = await args.registry.dispatch(calls);
    } catch (e) {
      if (e instanceof SuspendSignal) {
        // §5.7/§9.4: a tool suspended for human input. Append an audit `suspension` marker (folded into
        // the rolling hash), yield a TERMINAL `suspended` result, and RETURN — zero compute while waiting.
        let suspEvent: StoredEvent | null = null;
        {
          const gen = safeAppend(args.session, "suspension", { callId: e.callId, request: e.request }, undefined, usage, turn);
          let step = await gen.next();
          while (!step.done) { yield step.value as StreamEvent; step = await gen.next(); }
          suspEvent = step.value as StoredEvent | null;
        }
        if (suspEvent === null) {
          rootSpan?.setStatus("error", "append failed");
          rootSpan?.end();
          return;
        }
        rollingHash = await chainHash(rollingHash, suspEvent);
        await writeCheckpointWith(args, rollingHash); // the pending approval IS a checkpoint (§9.4)
        const suspToolName = calls.find((c) => c.callId === e.callId)?.name;
        yield {
          type: "result",
          subtype: "suspended",
          request: e.request,
          callId: e.callId,
          usage,
          numTurns: turn,
          sessionId: args.session.id,
          cost: breakdownFor(usage, args.prices, args.modelId, args.budget),
          details: buildDetails("suspended", { callId: e.callId, toolName: suspToolName }),
        };
        endRoot(usage);
        return;
      }
      throw e; // any other throw is a real error — not swallowed here.
    }
    for (const r of results) {
      // --- OTel tool span: point-in-time marker after dispatch (§11.1) ---
      // Spans are emitted after batch dispatch completes; name + isError status satisfies §11.1.
      const toolSpan = tracer?.startSpan("gen_ai.execute_tool", { "gen_ai.tool.name": r.toolName });
      toolSpan?.setStatus(r.isError ? "error" : "ok");
      toolSpan?.end();

      let toolEvent: StoredEvent | null = null;
      {
        const gen = safeAppend(args.session, "tool_result", { callId: r.callId, toolName: r.toolName, output: r.output }, undefined, usage, turn);
        let step = await gen.next();
        while (!step.done) { yield step.value as StreamEvent; step = await gen.next(); }
        toolEvent = step.value as StoredEvent | null;
      }
      if (toolEvent === null) {
        rootSpan?.setStatus("error", "append failed");
        rootSpan?.end();
        return;
      }
      appendEventToMessages(messages, toolEvent);
      rollingHash = await chainHash(rollingHash, toolEvent);
      // Fix 1: update incremental loaded-set for load_tool results (O(1) per call vs O(n) rescan).
      applyLoadToolResult(r);
      yield { type: "tool.result", callId: r.callId, toolName: r.toolName, output: r.output, isError: r.isError };
    }
    await writeCheckpointWith(args, rollingHash); // checkpoint after the tool batch (§9.2 component 1)

    // --- §16.4 abort boundary: after tool batch ---
    if (args.signal?.aborted) {
      yield* emitAborted(args, usage, turn, rollingHash, endRoot);
      return;
    }
  }
}

export async function* runTurn(args: RunTurnArgs): AsyncIterable<StreamEvent> {
  const toolSchemas = args.registry.schemas();
  yield {
    type: "session.init",
    sessionId: args.session.id,
    agentId: args.agentId,
    tools: toolSchemas.map((s) => s.name),
    model: args.modelId ?? "",
    ...(args.instructionsVersion !== undefined ? { instructionsVersion: args.instructionsVersion } : {}),
    ...(args.greeting !== undefined ? { greeting: args.greeting } : {}),
  };

  // --- D7: input guardrails — enforce before crossing any persistence boundary. ---
  // Blocked input is never stored. Redacted input is stored only in its sanitized form, which
  // also prevents later turns and resume/replay paths from reconstructing the original secret.
  let effectiveInput = args.input;
  if (args.guardrails && args.guardrails.length > 0) {
    const checkedText = args.guardrailInput?.text ?? args.input;
    const guardrailCtx: GuardrailContext = {
      agentId: args.agentId,
      sessionId: args.session.id,
      source: "input",
      ...(args.guardrailInput?.channel !== undefined ? { channel: args.guardrailInput.channel } : {}),
      ...(args.guardrailInput?.metadata !== undefined ? { metadata: args.guardrailInput.metadata } : {}),
    };
    const gr = await runGuardrails(args.guardrails, checkedText, "checkInput", guardrailCtx);
    if (gr.blocked !== undefined) {
      yield {
        type: "result",
        subtype: "guardrail",
        output: `Input blocked by guardrail: ${gr.blocked.reason}`,
        usage: ZERO_USAGE,
        numTurns: 0,
        sessionId: args.session.id,
        cost: breakdownFor(ZERO_USAGE, args.prices, args.modelId, args.budget),
        details: buildDetails("guardrail", {
          guardrailReason: gr.blocked.reason,
          guardrailCode: gr.blocked.code,
          guardrailSeverity: gr.blocked.severity,
        }),
      };
      return;
    }
    effectiveInput = applyGuardrailRedaction(args.input, checkedText, gr.text);
  }

  let userEvent: StoredEvent | null = null;
  {
    const gen = safeAppend(args.session, "user", effectiveInput, undefined, { inputTokens: 0, outputTokens: 0 }, 0);
    let step = await gen.next();
    while (!step.done) {
      yield step.value as StreamEvent;
      step = await gen.next();
    }
    userEvent = step.value as StoredEvent | null;
  }
  if (userEvent === null) return;

  // Images remain in the event log/model envelope, but memory is text-only. This avoids
  // duplicating base64 payloads or remote image URLs into vector stores and recall indexes.
  const multimodalInput = decodeMultimodalInput(effectiveInput);
  const memoryInput = multimodalInput ? extractTextFromBlocks(multimodalInput) : effectiveInput;

  const blocks = args.memory ? await args.memory.getAlwaysInContext(args.scope) : await args.store.getBlocks(args.scope);
  let recall: { text: string; metadata?: { source?: string; page?: number; [k: string]: unknown } }[] = [];
  if (args.memory) {
    // --- OTel memory.retrieve span (§11.1) ---
    const retrieveSpan = args.tracer?.startSpan("memory.retrieve", { "eidentic.scope": scopeKey(args.scope) });
    recall = (await args.memory.retrieve({ text: memoryInput, scope: args.scope })).snippets;
    retrieveSpan?.setStatus("ok");
    retrieveSpan?.end();
    (args.logger ?? NoopLogger).log("debug", "eidentic:memory", "retrieve", { hits: recall.length });
  }
  // Build initial messages from the event log.
  const messages = buildInitialMessages(args, blocks, recall);
  if (args.memory) {
    // --- OTel memory.ingest span for user input (§11.1) ---
    const ingestSpan = args.tracer?.startSpan("memory.ingest", { "eidentic.scope": scopeKey(args.scope) });
    await args.memory.ingest([{ id: userEvent.id, scope: args.scope, text: memoryInput }]);
    ingestSpan?.setStatus("ok");
    ingestSpan?.end();
  }
  // Seed the rolling hash with the user event then checkpoint it (§9.2).
  const userRollingHash = await chainHash("", userEvent);
  await writeCheckpointWith(args, userRollingHash); // checkpoint the user event (§9.2)

  yield* runLoop(args, messages, { inputTokens: 0, outputTokens: 0 }, 0, userRollingHash);
}

/**
 * Continue an interrupted/suspended run from the persisted event log (§9.7), with no new user
 * input. Reuses buildInitialMessages + runLoop. If the run already terminated (last event is an
 * assistant turn with no tool_use), yields its terminal success result instead of calling the model.
 */
export async function* resumeTurn(args: RunTurnArgs): AsyncIterable<StreamEvent> {
  const toolSchemas = args.registry.schemas();
  yield {
    type: "session.init",
    sessionId: args.session.id,
    agentId: args.agentId,
    tools: toolSchemas.map((s) => s.name),
    model: args.modelId ?? "",
    ...(args.instructionsVersion !== undefined ? { instructionsVersion: args.instructionsVersion } : {}),
    ...(args.greeting !== undefined ? { greeting: args.greeting } : {}),
  };

  const events = args.session.events();
  if (events.length === 0) {
    // Fix 5: pass args.budget so child USD is included even on this early error path.
    yield { type: "result", subtype: "error", output: "resume: session has no events", usage: { inputTokens: 0, outputTokens: 0 }, numTurns: 0, sessionId: args.session.id, cost: breakdownFor({ inputTokens: 0, outputTokens: 0 }, args.prices, args.modelId, args.budget) };
    return;
  }

  // Reconstruct prior spend from persisted assistant events (used by both the early-exit and the resumed run).
  const priorUsage = events.reduce<Usage>((acc, e) => {
    if (e.kind === "assistant" && e.meta?.usage) {
      return addUsage(acc, e.meta.usage as Usage);
    }
    return acc;
  }, ZERO_USAGE);

  // Terminal-completion fast-path: if the last real event is a tool-less assistant turn,
  // the run already finished — replay its result without calling the model.
  const last = events[events.length - 1]!;
  if (last.kind === "assistant") {
    const lastPayload = last.payload;
    if (
      typeof lastPayload !== "object" || lastPayload === null ||
      !Array.isArray((lastPayload as Record<string, unknown>).content)
    ) {
      yield { type: "result", subtype: "error", output: `appendEventToMessages: corrupt "assistant" event (id=${last.id}): payload.content must be an array, got ${JSON.stringify(lastPayload)}`, usage: priorUsage, numTurns: 0, sessionId: args.session.id, cost: breakdownFor(priorUsage, args.prices, args.modelId, args.budget) };
      return;
    }
    const content = (lastPayload as { content: ContentBlock[] }).content;
    if (content.filter(isToolUse).length === 0) {
      const text = content.filter(isText).map((b) => b.text).join("");
      const numTurns = events.filter(e => e.kind === "assistant").length;
      // Fix 5: pass args.budget so child USD is included (was missing, causing under-reported cost on resume).
      const cost = breakdownFor(priorUsage, args.prices, args.modelId, args.budget);
      // D2: when resuming an already-terminated session WITH an outputSchema, validate the
      // stored final text against the schema and attach the parsed object — same semantics as
      // the live terminal turn. A mismatch / unparseable text terminates with subtype:"error".
      if (args.outputSchema) {
        let candidate: unknown;
        try {
          candidate = JSON.parse(text);
        } catch {
          yield {
            type: "result",
            subtype: "error",
            output: `structured output requested but the resumed final answer is not valid JSON: ${text.slice(0, 200)}`,
            usage: priorUsage,
            numTurns,
            sessionId: args.session.id,
            cost,
            details: buildDetails("error", { errorName: "SyntaxError", errorKind: "structured_output_parse", rawOutput: text }),
          };
          return;
        }
        const validated = args.outputSchema.validate(candidate);
        if (!validated.ok) {
          yield {
            type: "result",
            subtype: "error",
            output: `structured output failed schema validation: ${validated.error}`,
            usage: priorUsage,
            numTurns,
            sessionId: args.session.id,
            cost,
            details: buildDetails("error", {
              errorName: "ValidationError",
              errorKind: "structured_output_validation",
              validationIssues: validated.issues,
              rawOutput: text,
            }),
          };
          return;
        }
        yield { type: "result", subtype: "success", output: text, object: validated.value, usage: priorUsage, numTurns, sessionId: args.session.id, cost };
        return;
      }
      yield { type: "result", subtype: "success", output: text, usage: priorUsage, numTurns, sessionId: args.session.id, cost };
      return;
    }
  }

  // Compute pending tool calls: look at the LAST assistant event in the log (regardless of whether
  // subsequent audit-only events like `suspension` or `compaction` follow it). If that assistant
  // event has tool_use blocks with no matching tool_result in the log, those calls were interrupted
  // mid-batch (crash or suspension) and must be re-dispatched directly — NOT via a model re-call.
  // This preserves the original callId/name/input so idempotency keys and suspend decisions hit correctly.
  const lastAssistantEvent = [...events].reverse().find((e) => e.kind === "assistant");
  let pendingCalls: ToolCall[] = [];
  if (lastAssistantEvent) {
    const content = (lastAssistantEvent.payload as { content: ContentBlock[] }).content;
    const toolUseBlocks = content.filter(isToolUse);
    if (toolUseBlocks.length > 0) {
      const answeredCallIds = new Set(
        events
          .filter((e) => e.kind === "tool_result")
          .map((e) => (e.payload as { callId: string }).callId),
      );
      pendingCalls = toolUseBlocks
        .filter((b) => !answeredCallIds.has(b.callId))
        .map((b) => ({ callId: b.callId, name: b.name, input: b.input }));
    }
  }

  // Otherwise: rebuild messages from the log and continue. Recall uses the latest user text if any.
  const blocks = args.memory ? await args.memory.getAlwaysInContext(args.scope) : await args.store.getBlocks(args.scope);
  const lastUser = [...events].reverse().find((e) => e.kind === "user");

  // --- Finding #3: re-run input guardrails on resume ---
  // The event log stores the ORIGINAL user text (for audit). On the first turn, runTurn redacted
  // it before handing it to the model. On resume, buildInitialMessages replays the raw event log
  // text unchanged, so without this step the original (un-redacted) PII/secret/off-topic text
  // would reach the model — defeating the guardrail on the durable/HITL path.
  //
  // Fix: extract the last user message text, re-run checkInput, and either:
  //   - block  → terminate with subtype:"guardrail" (no model call).
  //   - redact → patch the last user message in the rebuilt window before passing to runLoop.
  //   - allow  → no-op (effective text matches what's already in the window).
  let effectiveLastUserText: string | undefined = lastUser ? String(lastUser.payload) : undefined;
  if (args.guardrails && args.guardrails.length > 0 && effectiveLastUserText !== undefined) {
    const guardrailCtx: GuardrailContext = { agentId: args.agentId, sessionId: args.session.id, source: "input" };
    const gr = await runGuardrails(args.guardrails, effectiveLastUserText, "checkInput", guardrailCtx);
    if (gr.blocked !== undefined) {
      yield {
        type: "result",
        subtype: "guardrail",
        output: `Input blocked by guardrail on resume: ${gr.blocked.reason}`,
        usage: priorUsage,
        numTurns: 0,
        sessionId: args.session.id,
        cost: breakdownFor(priorUsage, args.prices, args.modelId, args.budget),
        details: buildDetails("guardrail", {
          guardrailReason: gr.blocked.reason,
          guardrailCode: gr.blocked.code,
          guardrailSeverity: gr.blocked.severity,
        }),
      };
      return;
    }
    effectiveLastUserText = gr.text; // may be redacted
  }

  let recall: { text: string; metadata?: { source?: string; page?: number; [k: string]: unknown } }[] = [];
  if (args.memory && lastUser) {
    // --- OTel memory.retrieve span for resumed run (§11.1) ---
    const retrieveSpan = args.tracer?.startSpan("memory.retrieve", { "eidentic.scope": scopeKey(args.scope) });
    // Use the guardrail-effective text for retrieval (same as runTurn does on the first turn).
    recall = (await args.memory.retrieve({ text: effectiveLastUserText ?? String(lastUser.payload), scope: args.scope })).snippets;
    retrieveSpan?.setStatus("ok");
    retrieveSpan?.end();
  }
  let messages: ModelMessage[];
  try {
    messages = buildInitialMessages(args, blocks, recall);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    yield { type: "result", subtype: "error", output: errMsg, usage: priorUsage, numTurns: 0, sessionId: args.session.id, cost: breakdownFor(priorUsage, args.prices, args.modelId, args.budget) };
    return;
  }

  // If the guardrail redacted the last user text, patch the last user message in the built window
  // so the model sees the redacted text. The event log retains the original for audit.
  if (effectiveLastUserText !== undefined && lastUser && effectiveLastUserText !== String(lastUser.payload)) {
    const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
    if (lastUserIdx !== -1) {
      messages[lastUserIdx] = { role: "user", content: effectiveLastUserText };
    }
  }

  // Fix 6: seed the rolling hash from the last durable checkpoint when available, then only
  // chain-hash the delta events (those with seq >= checkpoint.seq). This is O(delta) instead
  // of O(n) sequential SHA-256 before any model work.
  //
  // INTEGRITY GUARANTEE: the resulting hash MUST equal the full-rehash. The invariant holds
  // because chainHash is a left-fold: hash(events[0..n]) = chainHash(hash(events[0..k-1]), events[k..n]).
  // The checkpoint stores exactly hash(events[0..k-1]) (written incrementally as each event arrived),
  // so starting from checkpoint.hash and applying events[k..] produces the same final hash.
  //
  // Fallback: when durable is absent, or lastCheckpoint returns null, we fall back to hashing
  // the full event log — identical behavior to before the fix.
  let resumeRollingHash = "";
  {
    let checkpointHash = "";
    let deltaStartSeq = 0; // events with seq >= deltaStartSeq are chained onto checkpointHash
    if (args.durable) {
      const cp = await args.durable.lastCheckpoint(args.session.id);
      if (cp) {
        checkpointHash = cp.hash;
        deltaStartSeq = cp.seq; // checkpoint.seq = nextSeq at checkpoint time; events[seq >= cp.seq] are the delta
      }
    }
    // Chain delta events (or all events if no checkpoint). Either way, result is identical to the full rehash.
    resumeRollingHash = checkpointHash;
    for (const e of events) {
      if (e.seq >= deltaStartSeq) resumeRollingHash = await chainHash(resumeRollingHash, e);
    }
  }

  // numTurns restarts at 0 for the resumed segment (max_turns guards the resumed run, not the original).
  // pendingCalls (if any) are dispatched first inside runLoop before the initial model call.
  yield* runLoop(args, messages, priorUsage, 0, resumeRollingHash, pendingCalls);
}
