import { createRequire } from "node:module";
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
   * Injectable provider factory for testing. When provided, the `ollama-ai-provider`
   * peer dependency is NOT resolved — the factory is called directly. In production
   * code, leave this unset.
   * @internal
   */
  _factory?: OllamaProviderFactory;
}

/**
 * Minimal type describing what we need from `ollama-ai-provider`.
 * @internal
 */
export interface OllamaProvider {
  (modelId: string): LanguageModel;
}

/** @internal */
export interface OllamaProviderFactory {
  createOllama(opts?: { baseURL?: string }): OllamaProvider;
}

/** Lazy-require the optional peer dep. Throws a clear message if not installed. */
function loadOllamaModule(): OllamaProviderFactory {
  // In CJS builds `require` is available as a global; in ESM builds we derive it from
  // import.meta.url. This is identical to the pattern in @eidentic/sqlite. The esbuild
  // warning ("import.meta not available with cjs") is a false positive: at CJS runtime
  // `typeof require === "function"` is true so the createRequire branch is never reached.
  const req: NodeRequire =
    typeof require === "function"
      ? require
      : createRequire(import.meta.url);
  try {
    return req("ollama-ai-provider") as OllamaProviderFactory;
  } catch {
    throw new Error(
      "[eidentic/model] createOllamaModel requires the `ollama-ai-provider` package.\n" +
        "Install it in your project:\n" +
        "  npm install ollama-ai-provider\n" +
        "  # or\n" +
        "  pnpm add ollama-ai-provider",
    );
  }
}

/**
 * Create a Vercel AI SDK `LanguageModel` backed by a locally-running Ollama instance.
 *
 * `ollama-ai-provider` is an **optional peer dependency** — install it separately:
 * ```sh
 * npm install ollama-ai-provider
 * # or
 * pnpm add ollama-ai-provider
 * ```
 *
 * **Usage:**
 * ```ts
 * import { AIModel, createOllamaModel } from "@eidentic/model";
 *
 * // Default: connects to http://localhost:11434/api
 * const model = new AIModel(createOllamaModel("llama3.2"));
 *
 * // Multimodal (vision-capable) model:
 * const visionModel = new AIModel(createOllamaModel("llava"));
 *
 * // Custom server URL:
 * const remoteModel = new AIModel(
 *   createOllamaModel("mistral", { baseURL: "http://192.168.1.10:11434/api" }),
 * );
 * ```
 *
 * No API key required — works entirely offline.
 *
 * @param modelId - Ollama model identifier, e.g. `"llama3.2"`, `"mistral"`, `"llava"`.
 * @param opts    - Optional configuration (baseURL + optional test factory).
 * @returns A Vercel AI SDK `LanguageModel` that routes calls to the local Ollama server.
 * @throws Error if `ollama-ai-provider` is not installed and no `_factory` is provided.
 */
export function createOllamaModel(modelId: string, opts?: OllamaModelOptions): LanguageModel {
  const mod = opts?._factory ?? loadOllamaModule();
  const provider = mod.createOllama(opts?.baseURL ? { baseURL: opts.baseURL } : undefined);
  return provider(modelId);
}
