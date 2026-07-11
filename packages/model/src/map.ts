import { tool, jsonSchema, type Instructions, type ModelMessage as AIMessage, type SystemModelMessage, type ToolSet, type TextPart, type ToolCallPart, type ImagePart } from "ai";
import type {
  ModelMessage as KMessage,
  ContentBlock,
  ToolSchema,
  ModelResponse,
} from "@eidentic/types";
import { decodeMultimodalInput } from "@eidentic/types";

/**
 * The Anthropic cache-control provider-options breakpoint. Applied to the system message when
 * `cacheControl` is requested. Other providers either cache automatically (OpenAI) or ignore
 * unknown providerOptions gracefully — no error is thrown.
 */
const ANTHROPIC_CACHE_BREAKPOINT: SystemModelMessage["providerOptions"] = {
  anthropic: { cacheControl: { type: "ephemeral" } },
};

/**
 * Split Eidentic messages into AI SDK's `instructions` option + non-system `messages`.
 * When `cacheControl` is `true`, the system value is returned as a `SystemModelMessage`
 * object carrying an Anthropic `cacheControl: { type: "ephemeral" }` breakpoint. Providers
 * that do not support prefix caching ignore the `providerOptions` field silently.
 */
export function mapMessages(
  msgs: KMessage[],
  opts?: { cacheControl?: boolean; unsafeAllowRemoteImageUrls?: boolean },
): { instructions?: Instructions; messages: AIMessage[] } {
  const systemParts: string[] = [];
  const messages: AIMessage[] = [];

  for (const m of msgs) {
    if (m.role === "system") {
      systemParts.push(typeof m.content === "string" ? m.content : textOf(m.content));
      continue;
    }
    if (m.role === "user") {
      // Resolve user content: string | ContentBlock[] → ContentBlock[] | plain string.
      // When the content is a multimodal-encoded string (from Agent.query with image blocks),
      // decode it back to ContentBlock[] so the image parts are forwarded to the AI SDK.
      const userBlocks: ContentBlock[] | null =
        typeof m.content === "string"
          ? decodeMultimodalInput(m.content)  // null if plain text
          : (m.content as ContentBlock[]);

      if (userBlocks !== null) {
        // Build a multi-part user message — include text and image parts.
        const hasImages = userBlocks.some((b) => b.type === "image");
        if (hasImages) {
          const parts: Array<TextPart | ImagePart> = userBlocks.flatMap<TextPart | ImagePart>((b) => {
            if (b.type === "text") return [{ type: "text" as const, text: b.text }];
            if (b.type === "image") {
              const img = b.image;
              if (img.url && opts?.unsafeAllowRemoteImageUrls !== true) {
                throw new Error(
                  "remote image URLs are denied at the model boundary; resolve and validate the " +
                  "image to bounded base64 data first, or explicitly opt into unsafe provider-side fetching",
                );
              }
              const source = img.url ? new URL(img.url) : img.data;
              // An image block with neither url nor data has nothing to forward.
              if (source === undefined) return [];
              const imagePart: ImagePart = {
                type: "image" as const,
                image: source,
                ...(img.mediaType ? { mediaType: img.mediaType } : {}),
              };
              return [imagePart];
            }
            return [];
          });
          if (parts.length > 0) messages.push({ role: "user", content: parts });
        } else {
          // Text-only ContentBlock[] — collapse to a plain string (back-compat).
          messages.push({ role: "user", content: textOf(userBlocks) });
        }
      } else {
        // Plain string content.
        messages.push({ role: "user", content: m.content as string });
      }
      continue;
    }
    if (m.role === "assistant") {
      const parts: Array<TextPart | ToolCallPart> =
        typeof m.content === "string"
          ? [{ type: "text" as const, text: m.content }]
          : (m.content as ContentBlock[]).flatMap<TextPart | ToolCallPart>((b) =>
              b.type === "text"
                ? [{ type: "text" as const, text: b.text }]
                : b.type === "tool_use"
                  ? [{ type: "tool-call" as const, toolCallId: b.callId, toolName: b.name, input: b.input }]
                  : [],
            );
      if (parts.length > 0) messages.push({ role: "assistant", content: parts });
      continue;
    }
    // role === "tool"
    messages.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
      toolCallId: m.callId,
      toolName: m.toolName,
      output: { type: "text", value: m.content },
        },
      ],
    });
  }

  if (!systemParts.length) return { messages };

  const systemText = systemParts.join("\n\n");
  if (opts?.cacheControl) {
    // Return a SystemModelMessage so the AI SDK forwards providerOptions to the model provider.
    // Anthropic reads cacheControl to place a KV-cache breakpoint after the system message.
    // Other providers ignore the providerOptions field gracefully.
    return {
      instructions: { role: "system" as const, content: systemText, providerOptions: ANTHROPIC_CACHE_BREAKPOINT },
      messages,
    };
  }
  return { instructions: systemText, messages };
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Build an AI SDK ToolSet from Eidentic tool schemas — WITHOUT execute, so the model returns tool calls. */
export function buildTools(schemas: ToolSchema[]): ToolSet {
  return Object.fromEntries(
    schemas.map((s) => [
      s.name,
      tool({ description: s.description, inputSchema: jsonSchema(s.inputSchema as Parameters<typeof jsonSchema>[0]) }),
    ]),
  );
}

/** Minimal shape of the AI SDK generateText result that we read. */
export interface AIResultLike {
  text: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number };
  };
  /**
   * Present when the call was made with `output` (structured output). The AI SDK
   * parses the model's JSON against the schema and exposes it here. Accessing this getter on a
   * turn where the model produced no structured object can throw inside the SDK, so callers read
   * it via `readStructuredOutput`, which swallows that and only when tool calls are absent.
   */
  output?: unknown;
}

/**
 * Safely read the structured `output` from an AI SDK result. The SDK getter can throw
 * when no object was produced (e.g. the turn emitted tool calls instead), so we swallow that and
 * return undefined — the loop treats "no object this turn" identically to a normal text turn.
 */
export function readStructuredOutput(result: AIResultLike): unknown {
  try {
    return result.output;
  } catch {
    return undefined;
  }
}

export function readUsageCacheReadTokens(usage: AIResultLike["usage"]): number | undefined {
  return usage.inputTokenDetails?.cacheReadTokens;
}

export function mapResult(result: AIResultLike, opts?: { structured?: boolean }): ModelResponse {
  const content: ContentBlock[] = [];
  if (result.text) content.push({ type: "text", text: result.text });
  for (const tc of result.toolCalls) {
    content.push({ type: "tool_use", callId: tc.toolCallId, name: tc.toolName, input: tc.input });
  }
  const cached = readUsageCacheReadTokens(result.usage);
  // Only surface a structured object when structured output was REQUESTED for this call AND the turn
  // is terminal (no tool calls) — output is meaningful only once the model stops calling
  // tools and emits its final structured answer. Reading it otherwise would either throw inside the
  // SDK (no output configured) or return the raw text, neither of which is a structured object.
  const object = opts?.structured && result.toolCalls.length === 0
    ? readStructuredOutput(result)
    : undefined;
  return {
    content,
    usage: {
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      ...(cached !== undefined && cached > 0 ? { cachedInputTokens: cached } : {}),
    },
    ...(object !== undefined ? { object } : {}),
  };
}
