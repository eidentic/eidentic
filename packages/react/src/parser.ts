// Pure, DOM-free NDJSON stream parser for Eidentic SSE streams.
// Can be imported and tested without a browser or React.

import type { StreamEvent, ContentBlock, Usage, SuspendRequest, CostBreakdown } from "@eidentic/types";

// --- Public state types ---

export interface TextMessage {
  role: "assistant";
  content: string;
  /** True while the message is still receiving stream.delta tokens. */
  streaming: boolean;
}

export interface ToolCall {
  callId: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  callId: string;
  toolName: string;
  output: unknown;
  isError: boolean;
}

export interface ResultEvent {
  subtype: string;
  usage: Usage;
  numTurns: number;
  sessionId: string;
  /** Present when subtype === "suspended" */
  request?: SuspendRequest;
  callId?: string;
  /** Transparent cost accounting. Present on terminal events when the server has a PriceTable configured. */
  cost?: CostBreakdown;
}

/** A single per-turn usage snapshot, captured from assistant events during streaming. */
export interface TurnUsage {
  /** The 0-based turn index (increments each time an assistant event is received). */
  turn: number;
  usage: Usage;
}

/** Normalized state produced by the parser for each event processed. */
export interface ParsedStreamState {
  messages: TextMessage[];
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  result: ResultEvent | null;
  error: Error | null;
  /** Every raw StreamEvent received so far — the escape hatch for advanced consumers. */
  events: StreamEvent[];
  /** The last StreamEvent that caused this state update. */
  lastEvent: StreamEvent | null;
  /**
   * Cumulative token usage across all assistant turns so far.
   * Updated incrementally as each assistant event arrives.
   * On stream completion, matches result.usage (the server's authoritative total).
   */
  usage: Usage;
  /**
   * Per-turn usage snapshots — one entry per assistant event received.
   * Allows consumers to track per-turn cost incrementally during streaming.
   */
  turnUsages: TurnUsage[];
  /**
   * Cost breakdown from the terminal result event.
   * Populated only after the stream ends with a result that carries cost.
   */
  cost: CostBreakdown | null;
}

// Internal mutable accumulator — the parser mutates a clone each step.
interface Accumulator {
  messages: TextMessage[];
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  result: ResultEvent | null;
  error: Error | null;
  /** Index in messages[] of the currently-streaming assistant entry. -1 = none. */
  streamIdx: number;
  /** All raw events received so far. */
  events: StreamEvent[];
  /** The last event processed. */
  lastEvent: StreamEvent | null;
  /** Cumulative usage accumulated across all assistant turns. */
  usage: Usage;
  /** Per-turn usage snapshots. */
  turnUsages: TurnUsage[];
  /** Cost from the terminal result event. */
  cost: CostBreakdown | null;
}

function emptyAccumulator(): Accumulator {
  return {
    messages: [],
    toolCalls: [],
    toolResults: [],
    result: null,
    error: null,
    streamIdx: -1,
    events: [],
    lastEvent: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    turnUsages: [],
    cost: null,
  };
}

function toState(acc: Accumulator): ParsedStreamState {
  return {
    messages: acc.messages,
    toolCalls: acc.toolCalls,
    toolResults: acc.toolResults,
    result: acc.result,
    error: acc.error,
    events: acc.events,
    lastEvent: acc.lastEvent,
    usage: acc.usage,
    turnUsages: acc.turnUsages,
    cost: acc.cost,
  };
}

/** Apply a single StreamEvent to the accumulator. Returns a new accumulator (immutable update). */
export function applyEvent(acc: Accumulator, event: StreamEvent): Accumulator {
  // Clone top-level to ensure React state equality checks work.
  const next: Accumulator = {
    ...acc,
    messages: [...acc.messages],
    events: [...acc.events, event],
    lastEvent: event,
  };

  switch (event.type) {
    case "stream.delta": {
      const delta = event.delta.text;
      if (!delta) return acc;
      if (next.streamIdx !== -1 && next.streamIdx < next.messages.length) {
        const m = next.messages[next.streamIdx]!;
        next.messages[next.streamIdx] = { ...m, content: m.content + delta };
      } else {
        next.messages.push({ role: "assistant", content: delta, streaming: true });
        next.streamIdx = next.messages.length - 1;
      }
      break;
    }

    case "assistant": {
      const blocks: ContentBlock[] = event.content;
      // Accumulate text blocks; if a streaming entry exists, finalize it.
      let textFinalized = false;
      const toolCallsThisTurn: ToolCall[] = [];
      for (const block of blocks) {
        if (block.type === "text") {
          const finalText = block.text;
          if (!textFinalized && next.streamIdx !== -1 && next.streamIdx < next.messages.length) {
            // Finalize the streaming entry with the authoritative text.
            next.messages[next.streamIdx] = { role: "assistant", content: finalText, streaming: false };
            textFinalized = true;
          } else if (!textFinalized) {
            // No streaming entry present — emit the text directly.
            next.messages.push({ role: "assistant", content: finalText, streaming: false });
            textFinalized = true;
          }
        } else if (block.type === "tool_use") {
          toolCallsThisTurn.push({ callId: block.callId, name: block.name, input: block.input });
        }
      }
      // Turn boundary: reset the streaming slot.
      next.streamIdx = -1;
      if (toolCallsThisTurn.length > 0) {
        next.toolCalls = [...acc.toolCalls, ...toolCallsThisTurn];
      }
      // Capture per-turn usage if the assistant event carries it.
      if (event.usage) {
        const turn = acc.turnUsages.length;
        const turnEntry: TurnUsage = { turn, usage: event.usage };
        next.turnUsages = [...acc.turnUsages, turnEntry];
        // Accumulate into cumulative usage.
        next.usage = {
          inputTokens: acc.usage.inputTokens + event.usage.inputTokens,
          outputTokens: acc.usage.outputTokens + event.usage.outputTokens,
          ...(event.usage.cachedInputTokens !== undefined
            ? { cachedInputTokens: (acc.usage.cachedInputTokens ?? 0) + event.usage.cachedInputTokens }
            : {}),
        };
      }
      break;
    }

    case "tool.result": {
      next.toolResults = [
        ...acc.toolResults,
        {
          callId: event.callId,
          toolName: event.toolName,
          output: event.output,
          isError: event.isError,
        },
      ];
      break;
    }

    case "result": {
      // Finalize any in-flight streaming entry.
      if (next.streamIdx !== -1 && next.streamIdx < next.messages.length) {
        const m = next.messages[next.streamIdx]!;
        next.messages[next.streamIdx] = { ...m, streaming: false };
      }
      next.streamIdx = -1;
      next.result = {
        subtype: event.subtype,
        usage: event.usage,
        numTurns: event.numTurns,
        sessionId: event.sessionId,
        request: event.request,
        callId: event.callId,
        cost: event.cost,
      };
      // Promote cost to top-level for easy access.
      if (event.cost) {
        next.cost = event.cost;
      }
      // Use the authoritative total from the terminal result.
      next.usage = event.usage;
      break;
    }

    case "session.init":
      // Informational — no state change needed beyond recording event.
      // Return acc-with-event for the events list but no other change.
      // We still want to yield for onEvent consumers, so use a lightweight update:
      return { ...acc, events: [...acc.events, event], lastEvent: event };

    case "compaction":
      // Informational — record event only.
      return { ...acc, events: [...acc.events, event], lastEvent: event };

    default:
      // Unknown event type — record event but ignore gracefully.
      return { ...acc, events: [...acc.events, event], lastEvent: event };
  }

  return next;
}

/**
 * Parse a Eidentic SSE NDJSON stream from a ReadableStreamDefaultReader<Uint8Array>.
 * Yields ParsedStreamState after every event parsed.
 *
 * The SSE format used by @eidentic/server is:
 *   event: <type>\n
 *   data: <json>\n
 *   \n
 */
export async function* parseEidenticStream(
  reader: ReadableStreamDefaultReader<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncGenerator<ParsedStreamState> {
  let acc = emptyAccumulator();
  const decoder = new TextDecoder();
  // These three are outer-scope so they persist across chunk boundaries.
  let buf = "";
  let sseEventType = "";
  let sseEventData = "";

  const processChunk = function* (chunk: string): Generator<ParsedStreamState> {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        sseEventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        sseEventData = line.slice(5).trim();
      } else if (line === "" && sseEventType && sseEventData) {
        try {
          const parsed = JSON.parse(sseEventData) as Record<string, unknown>;
          // Reconstruct a StreamEvent — the server sends the type as the SSE event field
          // and the payload as data (without the `type` field inside JSON).
          const streamEvent = { type: sseEventType, ...parsed } as unknown as StreamEvent;
          const next = applyEvent(acc, streamEvent);
          // Always yield — even for informational events — so onEvent callbacks fire.
          // The lastEvent field lets callers identify what changed.
          if (next !== acc) {
            acc = next;
            yield toState(acc);
          }
        } catch {
          // Malformed JSON — ignore.
        }
        sseEventType = "";
        sseEventData = "";
      }
    }
  };

  // Supports both ReadableStreamDefaultReader and AsyncIterable.
  if (Symbol.asyncIterator in reader) {
    for await (const chunk of reader as AsyncIterable<Uint8Array>) {
      yield* processChunk(decoder.decode(chunk, { stream: true }));
    }
  } else {
    const r = reader as ReadableStreamDefaultReader<Uint8Array>;
    while (true) {
      const { done, value } = await r.read();
      if (done) break;
      yield* processChunk(decoder.decode(value, { stream: true }));
    }
  }

  // Flush any remaining buffer content.
  if (buf.trim()) {
    yield* processChunk("\n");
  }
}
