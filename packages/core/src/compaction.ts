import { isToolUse, type ContentBlock, type ModelMessage } from "@eidentic/types";

/**
 * Configuration for progressive, token-budget-triggered compaction of the in-context message
 * window (§4.4, §4.7). All fields optional; conservative pre-rot defaults applied in
 * `compactMessages`. Compaction operates ONLY on the in-memory window the loop sends to the
 * model — never on the persisted event log (which stays the audit trail).
 */
export interface CompactionConfig {
  /** Pre-rot token budget; compaction runs when `estimateTokens` exceeds this. Default 100_000. */
  maxContextTokens?: number;
  /** Always keep the last N user/assistant/tool messages verbatim (never FIFO-dropped). Default 6. */
  keepRecentTurns?: number;
  /** Condense any single tool result whose serialized length exceeds this. Default 2_000. */
  toolResultMaxChars?: number;
}

const DEFAULT_MAX_CONTEXT_TOKENS = 100_000;
const DEFAULT_KEEP_RECENT_TURNS = 6;
const DEFAULT_TOOL_RESULT_MAX_CHARS = 2_000;

/** Stage labels surfaced in the `compaction` event / StreamEvent. */
export const STAGE_TOOL_RESULT_CONDENSE = "tool-result-condense";
export const STAGE_FIFO_TRUNCATE = "fifo-truncate";
export const STAGE_COALESCE = "coalesce";

/** Serialize one message's content to a flat string for length/heuristic estimation. */
function contentToString(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  let out = "";
  for (const b of content) {
    if (b.type === "text") out += b.text;
    else if (b.type === "thinking") out += b.text;
    else if (b.type === "tool_use") out += b.name + JSON.stringify(b.input);
  }
  return out;
}

/**
 * Fast, deterministic token heuristic (§4.8): ~4 chars/token over the serialized window
 * (system + every message's text/tool content + tool results). Cheap; refined in production by
 * the provider's reported usage, but this estimate is what the budget gate keys on.
 */
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += contentToString(m.content).length;
  return Math.ceil(chars / 4);
}

/** A `role:"tool"` message (content is the JSON-serialized tool output the loop persisted). */
function isToolMessage(m: ModelMessage): boolean {
  return m.role === "tool";
}

/** The single system-prefix message (never dropped / condensed). */
function isSystem(m: ModelMessage): boolean {
  return m.role === "system";
}

/** Heuristic base64/binary detection — such payloads are truncated, NEVER summarized (§4.4 anti-pattern). */
function looksBinary(s: string): boolean {
  // Long run of base64-ish chars with no whitespace, or a data: URI.
  // Also handle JSON-stringified strings (starts with '"data:...').
  const inner = s.startsWith('"') ? s.slice(1) : s;
  if (inner.startsWith("data:") && inner.includes(";base64,")) return true;
  const sample = s.length > 512 ? s.slice(0, 512) : s;
  return sample.length > 256 && /^[A-Za-z0-9+/=\r\n"]+$/.test(sample);
}

/**
 * Recover a stable pointer from a tool result so condensing stays reversible-in-spirit (§4.4):
 * prefer a parsed `id`/`url`/`path`/`handle` field; else the first line; else "".
 */
function extractPointer(serialized: string): string {
  try {
    const v = JSON.parse(serialized) as Record<string, unknown>;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const key of ["id", "url", "path", "handle", "uri", "ref"]) {
        const val = v[key];
        if (typeof val === "string" && val.length > 0) return `${key}=${val}`;
        if (typeof val === "number") return `${key}=${val}`;
      }
    }
  } catch {
    /* not JSON — fall through to first-line heuristic */
  }
  const firstLine = serialized.split("\n", 1)[0] ?? "";
  return firstLine.slice(0, 120);
}

/**
 * Does a tool message record a failure (§4.6)? Detection is content-based because the persisted
 * tool message carries no `isError` flag — the error is encoded in the serialized output:
 * a parsed `error`/`isError:true`/`ok:false` field, or a leading error token.
 */
function isFailureTool(m: ModelMessage): boolean {
  if (m.role !== "tool") return false;
  const s = typeof m.content === "string" ? m.content : contentToString(m.content);
  try {
    const v = JSON.parse(s) as Record<string, unknown>;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (v.isError === true) return true;
      if (v.ok === false) return true;
      if (typeof v.error === "string" && v.error.length > 0) return true;
    }
  } catch {
    /* fall through */
  }
  return /^\s*(error|exception|failed|traceback)\b/i.test(s);
}

/** Condense one oversized tool-result string: keep a head/tail slice + pointer + a condensed marker. */
function condenseToolContent(serialized: string, maxChars: number): string {
  const pointer = extractPointer(serialized);
  const prefix = pointer ? `[${pointer}] ` : "";
  if (looksBinary(serialized)) {
    // §4.4 anti-pattern: never feed binary/base64 to a summarizer — truncate with a note.
    return `${prefix}…[binary/base64 omitted: ${serialized.length} chars]…`;
  }
  const headLen = Math.floor(maxChars * 0.6);
  const tailLen = Math.floor(maxChars * 0.2);
  const head = serialized.slice(0, headLen);
  const tail = serialized.slice(serialized.length - tailLen);
  const dropped = serialized.length - head.length - tail.length;
  return `${prefix}${head}…[condensed ${dropped} chars]…${tail}`;
}

/** Token estimate of `messages[from..end]` — used by Stage 3 to know when enough has been dropped. */
function tailTokens(messages: ModelMessage[], from: number): number {
  let chars = 0;
  for (let i = from; i < messages.length; i++) chars += contentToString(messages[i]!.content).length;
  return Math.ceil(chars / 4);
}

/**
 * Build a bidirectional pairing map between assistant tool_use messages and their matching
 * role:"tool" result messages. Returns:
 * - `callIdToAsstIdx`: callId → index of the assistant message that issued the tool_use
 * - `callIdToToolIdx`: callId → index of the role:"tool" message that carries the result
 *
 * An assistant message may contain multiple tool_use blocks (parallel dispatch); all share the
 * same assistant-message index. A role:"tool" message carries exactly one callId.
 */
function buildPairingMap(messages: ModelMessage[]): {
  callIdToAsstIdx: Map<string, number>;
  callIdToToolIdx: Map<string, number>;
} {
  const callIdToAsstIdx = new Map<string, number>();
  const callIdToToolIdx = new Map<string, number>();

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const block of m.content) {
        if (isToolUse(block)) {
          callIdToAsstIdx.set(block.callId, i);
        }
      }
    } else if (m.role === "tool" && m.callId) {
      callIdToToolIdx.set(m.callId, i);
    }
  }

  return { callIdToAsstIdx, callIdToToolIdx };
}

/**
 * PURE, deterministic compaction of the in-context message window (§4.4 stages 1/3/4). Does NOT
 * mutate its input. Applies cheapest stages first, stopping once under `maxContextTokens`.
 * Stage 2 (offload) and Stage 5 (episodic extraction) are DEFERRED to later plans.
 *
 * Invariants:
 * - The system prefix is never dropped or condensed.
 * - Failure evidence (§4.6) is never FIFO-dropped; Stage 1 keeps the FACT of a failure.
 * - The last `keepRecentTurns` messages are kept verbatim by Stage 3.
 * - A tool_use assistant turn and its matching role:"tool" result are an atomic unit: kept
 *   together or dropped together. A protected result pins its whole pair.
 */
export function compactMessages(
  messages: ModelMessage[],
  config: CompactionConfig,
): { messages: ModelMessage[]; compacted: boolean; before: number; after: number; stages: string[] } {
  const maxContextTokens = config.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const keepRecentTurns = config.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS;
  const toolResultMaxChars = config.toolResultMaxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS;

  const before = estimateTokens(messages);
  let work = messages.slice(); // shallow copy; never mutate the input array
  const stages: string[] = [];

  // --- Stage 1: tool-result condensing (cheapest) ---
  let stage1Applied = false;
  work = work.map((m) => {
    if (!isToolMessage(m)) return m;
    const s = typeof m.content === "string" ? m.content : contentToString(m.content);
    if (s.length <= toolResultMaxChars) return m;
    stage1Applied = true;
    return { ...m, content: condenseToolContent(s, toolResultMaxChars) };
  });
  if (stage1Applied) stages.push(STAGE_TOOL_RESULT_CONDENSE);

  // --- Stage 3: old-observation truncation (FIFO) — only if still over budget ---
  if (estimateTokens(work) > maxContextTokens) {
    const n = work.length;

    // Build pairing map BEFORE computing protected sets, so we can enforce the atomic-unit rule.
    const { callIdToAsstIdx, callIdToToolIdx } = buildPairingMap(work);

    // Indices in the "recent window" (last keepRecentTurns NON-system messages) are protected.
    const recentProtected = new Set<number>();
    let kept = 0;
    for (let i = n - 1; i >= 0 && kept < keepRecentTurns; i--) {
      if (isSystem(work[i]!)) continue;
      recentProtected.add(i);
      kept++;
    }

    // Compute per-message "directly protected" status (before pair promotion).
    // A message is directly protected if:
    //   - it is the system prefix
    //   - it is in the recent window
    //   - it is a failure tool result (§4.6)
    //   - it is a user turn (user turns are signal, not low-signal chatter)
    const directlyProtected = new Set<number>();
    for (let i = 0; i < n; i++) {
      const m = work[i]!;
      if (
        isSystem(m) ||
        recentProtected.has(i) ||
        isFailureTool(m) ||
        m.role === "user"
      ) {
        directlyProtected.add(i);
      }
    }

    // Promote protection across pairs: if a role:"tool" result is directly protected, its paired
    // assistant message (which issued the tool_use) must also be kept, and vice-versa. We also
    // promote in the other direction: if an assistant tool_use message is directly protected,
    // all its result messages are also kept. Iterate to fixpoint (typically 1-2 passes).
    const protected_ = new Set<number>(directlyProtected);
    let changed = true;
    while (changed) {
      changed = false;
      // Role:"tool" protected → protect its paired assistant turn.
      for (let i = 0; i < n; i++) {
        const m = work[i]!;
        if (m.role === "tool" && m.callId && protected_.has(i)) {
          const asstIdx = callIdToAsstIdx.get(m.callId);
          if (asstIdx !== undefined && !protected_.has(asstIdx)) {
            protected_.add(asstIdx);
            changed = true;
          }
        }
      }
      // Assistant with tool_use protected → protect all its result messages.
      for (let i = 0; i < n; i++) {
        const m = work[i]!;
        if (m.role === "assistant" && protected_.has(i) && Array.isArray(m.content)) {
          for (const block of m.content) {
            if (isToolUse(block)) {
              const toolIdx = callIdToToolIdx.get(block.callId);
              if (toolIdx !== undefined && !protected_.has(toolIdx)) {
                protected_.add(toolIdx);
                changed = true;
              }
            }
          }
        }
      }
    }

    let stage3Applied = false;
    const survivors: ModelMessage[] = [];
    for (let i = 0; i < n; i++) {
      const m = work[i]!;
      if (estimateTokens(survivors) + tailTokens(work, i) <= maxContextTokens) {
        // Enough already dropped; keep the rest verbatim.
        survivors.push(m);
        continue;
      }
      // Low-signal = old tool_result or old assistant chatter outside the protections above.
      const lowSignal = m.role === "tool" || m.role === "assistant";
      if (!protected_.has(i) && lowSignal) {
        stage3Applied = true;
        continue; // drop
      }
      survivors.push(m);
    }
    work = survivors;
    if (stage3Applied) stages.push(STAGE_FIFO_TRUNCATE);
  }

  // --- Stage 4: message coalescing — merge consecutive same-role plain messages ---
  // IMPORTANT: do NOT coalesce role:"tool" messages that carry distinct callIds — each must stay
  // paired with its tool_use in the assistant turn. Only coalesce role:"tool" messages that have
  // no callId (degenerate/legacy messages). Consecutive user or text-only assistant messages
  // without tool_use blocks may be coalesced safely.
  {
    const coalesced: ModelMessage[] = [];
    let stage4Applied = false;
    for (const m of work) {
      const prev = coalesced[coalesced.length - 1];
      if (
        prev &&
        prev.role === "tool" &&
        m.role === "tool" &&
        typeof prev.content === "string" &&
        typeof m.content === "string" &&
        // Only merge if NEITHER carries a callId (no pairing relationship to preserve).
        !prev.callId &&
        !m.callId
      ) {
        stage4Applied = true;
        coalesced[coalesced.length - 1] = {
          ...prev,
          content: prev.content + "\n" + m.content,
        };
        continue;
      }
      coalesced.push(m);
    }
    if (stage4Applied) {
      work = coalesced;
      stages.push(STAGE_COALESCE);
    }
  }

  const after = estimateTokens(work);
  return { messages: work, compacted: stages.length > 0, before, after, stages };
}
