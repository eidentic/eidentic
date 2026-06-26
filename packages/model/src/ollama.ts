import type { LanguageModel } from "ai";

/**
 * Options for `createOllamaModel`.
 */
export interface OllamaModelOptions {
  /**
   * Base URL of the Ollama server (defaults to `http://localhost:11434/api`).
   * Override when Ollama runs on a non-default port or a remote host.
   */
  baseURL?: string;
  /**
   * Injectable provider factory for testing and legacy adapters.
   * @internal
   */
  _factory?: OllamaProviderFactory;
}

/**
 * Minimal type describing what we need from an Ollama AI SDK provider.
 * @internal
 */
export interface OllamaProvider {
  (modelId: string): LanguageModel;
}

/** @internal */
export interface OllamaProviderFactory {
  createOllama(opts?: { baseURL?: string }): OllamaProvider;
}

/**
 * Create a Vercel AI SDK `LanguageModel` backed by a locally-running Ollama instance.
 *
 * @deprecated AI SDK 7 provider packages are ESM-first. Import the v7-compatible
 * `ai-sdk-ollama` provider directly instead:
 *
 * ```ts
 * import { AIModel } from "@eidentic/model";
 * import { ollama } from "ai-sdk-ollama";
 *
 * const model = new AIModel(ollama("llama3.2"));
 * ```
 *
 * @param modelId - Ollama model identifier, e.g. `"llama3.2"`, `"mistral"`, `"llava"`.
 * @param opts    - Optional configuration (baseURL + optional test factory).
 * @returns A Vercel AI SDK `LanguageModel` when a factory is provided.
 * @throws Error unless `_factory` is provided. Use `ai-sdk-ollama` directly for production code.
 */
export function createOllamaModel(modelId: string, opts?: OllamaModelOptions): LanguageModel {
  if (!opts?._factory) {
    throw new Error(
      "[eidentic/model] createOllamaModel no longer auto-loads an Ollama provider in AI SDK 7.\n" +
        "Install the v7-compatible provider and pass it directly to AIModel:\n" +
        '  import { ollama } from "ai-sdk-ollama";\n' +
        '  const model = new AIModel(ollama("llama3.2"));\n' +
        "For custom base URLs, use createOllama from ai-sdk-ollama.",
    );
  }
  const mod = opts._factory;
  const provider = mod.createOllama(opts?.baseURL ? { baseURL: opts.baseURL } : undefined);
  return provider(modelId);
}
