/**
 * AI SDK UI message-stream bridge (§ feat/ai-sdk-ui-stream).
 *
 * Converts Eidentic's `StreamEvent` async iterable into the Vercel AI SDK v6
 * UI message-stream protocol so that a Next.js `app/api/chat/route.ts` can
 * call `return toUIMessageStreamResponse(agent.query(input, { sessionId }))`
 * and a `useChat` (or CopilotKit) frontend just works.
 *
 * ## Mapping
 *
 * | Eidentic `StreamEvent`               | AI SDK `UIMessageChunk`                  |
 * |-------------------------------------|------------------------------------------|
 * | `stream.delta`                      | `text-delta` (streaming token)           |
 * | `assistant` text blocks             | `text-start` + `text-delta` + `text-end` |
 * | `assistant` tool_use blocks         | `tool-input-available`                   |
 * | `tool.result` (success)             | `tool-output-available`                  |
 * | `tool.result` (error)               | `tool-output-error`                      |
 * | `result` (terminal, any subtype)    | `finish`                                 |
 * | `error` (thrown inside generator)  | `error` chunk (via `onError`)            |
 *
 * `session.init` and `compaction` events are silently ignored — they carry
 * metadata/audit information that is not meaningful to a chat UI.
 *
 * ## Usage (Next.js App Router)
 *
 * ```ts
 * // app/api/chat/route.ts
 * import { toUIMessageStreamResponse } from "@eidentic/server";
 * import { myAgent } from "@/lib/agent";
 *
 * export async function POST(req: Request) {
 *   const { messages, sessionId } = await req.json();
 *   const input = messages.at(-1)?.content ?? "";
 *   return toUIMessageStreamResponse(
 *     myAgent.query(input, { sessionId }),
 *   );
 * }
 * ```
 *
 * On the client, configure `useChat` to point at this route — no further
 * changes are needed since the response uses the standard AI SDK SSE wire
 * format.
 */

import {
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";
import type { StreamEvent } from "@eidentic/types";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ToUIMessageStreamOptions {
  /**
   * Optional HTTP headers to include in the `Response` returned by
   * `toUIMessageStreamResponse`. Useful for CORS, cache-control, etc.
   */
  headers?: Headers | Record<string, string>;
  /**
   * HTTP status code for the response. Defaults to 200.
   */
  status?: number;
}

// ---------------------------------------------------------------------------
// Core transform: AsyncIterable<StreamEvent> → ReadableStream<UIMessageChunk>
// ---------------------------------------------------------------------------

/**
 * Converts a Eidentic `StreamEvent` async iterable into a
 * `ReadableStream<UIMessageChunk>` compatible with the Vercel AI SDK v6
 * UI message-stream protocol.
 *
 * Use `toUIMessageStreamResponse` for the common case of returning a `Response`
 * from a Next.js route handler. Use this function directly when you need the
 * raw stream (e.g. for piping to a Node.js `ServerResponse`).
 */
export function toUIMessageStream(
  events: AsyncIterable<StreamEvent>,
): ReadableStream {
  return createUIMessageStream({
    execute: async ({ writer }) => {
      // Emit start so useChat creates the assistant message immediately.
      writer.write({ type: "start" });
      writer.write({ type: "start-step" });

      // Track whether we are currently inside a streaming text block.
      // `stream.delta` events arrive interleaved with `assistant` events, so
      // we open a single text block on the first delta and close it once we
      // see a non-delta assistant event (or `result`).
      let textBlockOpen = false;
      let textBlockId = "text-0";
      // Whether the CURRENT assistant turn already emitted its text via `stream.delta` tokens.
      // When it did, the turn-final `assistant` event's text blocks are the SAME text accumulated —
      // re-emitting them would duplicate the message in the UI — so we skip them. Reset per turn.
      let streamedText = false;

      function openTextBlock(id: string) {
        if (!textBlockOpen) {
          textBlockId = id;
          writer.write({ type: "text-start", id: textBlockId });
          textBlockOpen = true;
        }
      }

      function closeTextBlock() {
        if (textBlockOpen) {
          writer.write({ type: "text-end", id: textBlockId });
          textBlockOpen = false;
        }
      }

      for await (const ev of events) {
        switch (ev.type) {
          // ------------------------------------------------------------------
          // Streaming token delta — primary hot path for live text streaming
          // ------------------------------------------------------------------
          case "stream.delta": {
            streamedText = true;
            openTextBlock("streaming-text");
            writer.write({ type: "text-delta", delta: ev.delta.text, id: textBlockId });
            break;
          }

          // ------------------------------------------------------------------
          // Assistant turn — complete content blocks (text + tool_use)
          // ------------------------------------------------------------------
          case "assistant": {
            // If we were streaming deltas, the assistant event signals the
            // full turn is done; close the open delta block first.
            closeTextBlock();

            for (const block of ev.content) {
              if (block.type === "text") {
                // Only emit the text here when the turn was NOT streamed token-by-token. When
                // `streamedText` is set, this text was already delivered via `stream.delta` above,
                // so re-emitting it as a second block would duplicate the assistant message.
                if (!streamedText) {
                  const id = `text-${crypto.randomUUID()}`;
                  writer.write({ type: "text-start", id });
                  writer.write({ type: "text-delta", delta: block.text, id });
                  writer.write({ type: "text-end", id });
                }
              } else if (block.type === "tool_use") {
                // Tool call available — let the UI show the tool invocation.
                writer.write({
                  type: "tool-input-available",
                  toolCallId: block.callId,
                  toolName: block.name,
                  input: block.input,
                });
              }
              // "thinking" blocks are intentionally ignored — they are
              // internal reasoning and not meaningful to a chat UI.
            }
            // Turn complete — the next assistant turn streams (or not) independently.
            streamedText = false;
            break;
          }

          // ------------------------------------------------------------------
          // Tool result
          // ------------------------------------------------------------------
          case "tool.result": {
            if (ev.isError) {
              writer.write({
                type: "tool-output-error",
                toolCallId: ev.callId,
                errorText:
                  typeof ev.output === "string"
                    ? ev.output
                    : JSON.stringify(ev.output),
              });
            } else {
              writer.write({
                type: "tool-output-available",
                toolCallId: ev.callId,
                output: ev.output,
              });
            }
            break;
          }

          // ------------------------------------------------------------------
          // Terminal result — stream is done
          // ------------------------------------------------------------------
          case "result": {
            // Close any open text block before finishing.
            closeTextBlock();

            // Map Eidentic termination subtypes to AI SDK finish reasons.
            // AI SDK FinishReason: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other" | "unknown"
            const finishReason = (() => {
              switch (ev.subtype) {
                case "success":
                  return "stop" as const;
                case "max_tokens":
                  return "length" as const;
                case "error":
                  return "error" as const;
                case "max_turns":
                case "max_cost":
                case "max_wall_clock":
                case "aborted":
                case "suspended":
                default:
                  return "other" as const;
              }
            })();

            writer.write({ type: "finish-step" });
            writer.write({ type: "finish", finishReason });
            break;
          }

          // ------------------------------------------------------------------
          // Ignored events — metadata / audit signals not meaningful to UI
          // ------------------------------------------------------------------
          case "session.init":
          case "compaction":
            break;
        }
      }
    },

    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      return `Stream error: ${msg}`;
    },
  });
}

// ---------------------------------------------------------------------------
// Convenience wrapper: returns a Response ready for Next.js route handlers
// ---------------------------------------------------------------------------

/**
 * Converts a Eidentic `StreamEvent` async iterable into a `Response` that
 * streams AI SDK UI message chunks to the client (SSE format).
 *
 * This is the primary integration point for Next.js App Router route handlers.
 * The returned `Response` is directly compatible with `useChat` from the
 * `@ai-sdk/react` package and frameworks that speak the AI SDK UI wire format
 * (CopilotKit, etc.).
 *
 * @example
 * ```ts
 * // app/api/chat/route.ts
 * import { toUIMessageStreamResponse } from "@eidentic/server";
 * import { myAgent } from "@/lib/agent";
 *
 * export async function POST(req: Request) {
 *   const { messages, sessionId } = await req.json();
 *   const input = messages.at(-1)?.content ?? "";
 *   return toUIMessageStreamResponse(
 *     myAgent.query(input, { sessionId }),
 *   );
 * }
 * ```
 */
export function toUIMessageStreamResponse(
  events: AsyncIterable<StreamEvent>,
  opts: ToUIMessageStreamOptions = {},
): Response {
  return createUIMessageStreamResponse({
    stream: toUIMessageStream(events),
    status: opts.status,
    headers: opts.headers,
  });
}
