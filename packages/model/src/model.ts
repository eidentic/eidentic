import { generateText, streamText, jsonSchema, Output, type LanguageModel } from "ai";
import type { ModelPort, ModelRequest, ModelResponse, ModelStreamPart, ContentBlock } from "@eidentic/types";
import { mapMessages, buildTools, mapResult, readUsageCacheReadTokens, type AIResultLike } from "./map.js";

const toolsArg = (t: import("ai").ToolSet) => (Object.keys(t).length > 0 ? t : undefined);

/**
 * Build the AI SDK `output` from a Eidentic `ModelRequest.outputSchema` (JSON Schema),
 * or undefined when the request did not ask for structured output. `Output.object` constrains the
 * model's final answer to the schema (sets `responseFormat: json`) while still allowing tool calls
 * on intermediate turns — exactly what the multi-turn agent loop needs.
 */
const outputArg = (schema: unknown) =>
  schema !== undefined
    ? Output.object({ schema: jsonSchema(schema as Parameters<typeof jsonSchema>[0]) })
    : undefined;

export type ModelResolver = (modelStr?: string) => LanguageModel | Promise<LanguageModel>;

type GenParams = Parameters<typeof generateText>[0];

/**
 * Keys of the AI SDK's `generateText` parameters that are generation settings (sampling,
 * limits, provider passthrough) — as opposed to prompt/tools/telemetry/internal options.
 * Listing a name that the installed AI SDK does not accept is a **compile error** (`Pick`
 * requires the key to exist), so this list can never silently drift out of sync.
 */
type GenerationSettingKey =
  | "temperature"
  | "maxOutputTokens"
  | "topP"
  | "topK"
  | "presencePenalty"
  | "frequencyPenalty"
  | "stopSequences"
  | "seed"
  | "maxRetries"
  | "providerOptions"
  | "headers";

/**
 * Generation settings forwarded to every model call, derived directly from the AI SDK's
 * `generateText` signature via `Pick`. Names and types always match the installed SDK — a
 * renamed or removed setting becomes a compile error here rather than being silently ignored
 * at runtime. All keys are optional (they are optional on the SDK type).
 *
 * @example new AIModel(anthropic("claude-sonnet-4-5"), { temperature: 0.2, maxOutputTokens: 1024 })
 */
export type AIModelOptions = Pick<GenParams, GenerationSettingKey> & {
  /**
   * @deprecated Unsafe compatibility mode: let the provider fetch user-supplied image URLs.
   * Prefer Agent multimodal.resolveRemoteImage, which validates and returns bounded base64 bytes.
   */
  unsafeAllowRemoteImageUrls?: boolean;
};

/**
 * A Eidentic `ModelPort` backed by Vercel AI SDK v7.
 * Pass a concrete AI SDK `LanguageModel` (e.g. `anthropic("claude-...")`) or a resolver
 * that turns the request's `model` string into a `LanguageModel`. The optional second
 * argument sets generation defaults (temperature, maxOutputTokens, …) applied to every call.
 */
export class AIModel implements ModelPort {
  private readonly resolve: ModelResolver;
  private readonly settings: Pick<GenParams, GenerationSettingKey>;
  private readonly unsafeAllowRemoteImageUrls: boolean;
  /** The model's own identifier, sourced from the AI SDK LanguageModel when a static model is passed. */
  readonly modelId: string | undefined;
  constructor(model: LanguageModel | ModelResolver, options: AIModelOptions = {}) {
    if (typeof model === "function") {
      this.resolve = model as ModelResolver;
      // resolver: modelId unknown at construction time
      this.modelId = undefined;
    } else {
      this.resolve = () => model;
      // AI SDK LanguageModel exposes .modelId for concrete provider models.
      this.modelId = (model as { modelId?: string }).modelId;
    }
    const { unsafeAllowRemoteImageUrls, ...settings } = options;
    this.settings = settings;
    this.unsafeAllowRemoteImageUrls = unsafeAllowRemoteImageUrls === true;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const model = await this.resolve(request.model);
    const { instructions, messages } = mapMessages(request.messages, {
      cacheControl: request.cacheControl,
      unsafeAllowRemoteImageUrls: this.unsafeAllowRemoteImageUrls,
    });
    const tools = buildTools(request.tools);

    const output = outputArg(request.outputSchema);

    const result = await generateText({
      model,
      instructions,
      messages,
      tools: toolsArg(tools),
      ...this.settings,
      // no `stopWhen` and no tool `execute` → single round-trip; tool calls returned to our loop
      ...(output ? { output } : {}),
      ...(request.signal ? { abortSignal: request.signal } : {}),
    });

    return mapResult(result as unknown as AIResultLike, { structured: output !== undefined });
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
    const model = await this.resolve(request.model);
    const { instructions, messages } = mapMessages(request.messages, {
      cacheControl: request.cacheControl,
      unsafeAllowRemoteImageUrls: this.unsafeAllowRemoteImageUrls,
    });
    const tools = buildTools(request.tools);

    const output = outputArg(request.outputSchema);

    const result = streamText({
      model,
      instructions,
      messages,
      tools: toolsArg(tools),
      ...this.settings,
      ...(output ? { output } : {}),
      ...(request.signal ? { abortSignal: request.signal } : {}),
    });

    const toolUses: ContentBlock[] = [];
    for await (const part of result.stream) {
      if (part.type === "text-delta") {
        yield { type: "delta", delta: { text: part.text } };
      } else if (part.type === "tool-call") {
        toolUses.push({ type: "tool_use", callId: part.toolCallId, name: part.toolName, input: part.input });
      } else if (part.type === "error") {
        throw part.error instanceof Error ? part.error : new Error(`model stream error: ${String(part.error)}`);
      }
    }

    // M17 fix: if the stream was aborted mid-flight, `result.text`/`usage` resolve with partial
    // content. Throw the standard abort error so the loop sees an aborted result rather than a
    // spurious `final` event containing truncated output.
    if (request.signal?.aborted) {
      throw new DOMException("stream aborted", "AbortError");
    }

    const text = await result.text;
    const usage = await result.usage;
    const content: ContentBlock[] = [];
    if (text) content.push({ type: "text", text });
    content.push(...toolUses);

    const cached = readUsageCacheReadTokens(usage);
    // Surface the structured object only on a terminal (tool-less) turn — mirrors mapResult().
    // AI SDK v7 exposes the parsed value via `result.output` when `output: Output.object(...)`
    // was requested. If no structured output was produced, the SDK can throw; in that case the
    // core loop re-validates the terminal text and reports the useful schema/parse error.
    let object: unknown;
    if (output && toolUses.length === 0) {
      try {
        object = await result.output;
      } catch {
        object = undefined;
      }
    }
    yield {
      type: "final",
      response: {
        content,
        usage: {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          ...(cached !== undefined && cached > 0 ? { cachedInputTokens: cached } : {}),
        },
        ...(object !== undefined ? { object } : {}),
      },
    };
  }
}
