import { describe, it, expect, vi } from "vitest";
import type { LanguageModel } from "ai";
import { createOllamaModel } from "../src/ollama.js";
import { AIModel } from "../src/model.js";
import type { OllamaProviderFactory } from "../src/ollama.js";

/**
 * Tests for createOllamaModel.
 * We never hit a real Ollama instance — the provider factory is injected via the
 * `_factory` option so no `ollama-ai-provider` package is needed to run these tests.
 */

/** Build a minimal fake LanguageModel matching AI SDK v6 shape. */
function makeFakeLanguageModel(modelId: string): LanguageModel {
  return {
    specificationVersion: "v2",
    provider: "ollama",
    modelId,
    defaultObjectGenerationMode: "json" as const,
    doGenerate: vi.fn(),
    doStream: vi.fn(),
  } as unknown as LanguageModel;
}

/** Build a fake OllamaProviderFactory. */
function makeFakeFactory(capturedBaseURL?: { value?: string }): OllamaProviderFactory {
  return {
    createOllama: (opts?: { baseURL?: string }) => {
      if (capturedBaseURL) capturedBaseURL.value = opts?.baseURL;
      return (modelId: string) => makeFakeLanguageModel(modelId);
    },
  };
}

describe("createOllamaModel", () => {
  it("returns a LanguageModel-shaped object with the correct modelId", () => {
    const model = createOllamaModel("llama3.2", { _factory: makeFakeFactory() });
    expect(model).toBeDefined();
    expect((model as any).modelId).toBe("llama3.2");
    expect((model as any).provider).toBe("ollama");
    expect((model as any).specificationVersion).toBe("v2");
  });

  it("passes baseURL to the underlying Ollama provider", () => {
    const captured: { value?: string } = {};
    createOllamaModel("mistral", {
      baseURL: "http://192.168.1.10:11434/api",
      _factory: makeFakeFactory(captured),
    });
    expect(captured.value).toBe("http://192.168.1.10:11434/api");
  });

  it("passes no baseURL to the provider when not specified", () => {
    const captured: { value?: string } = {};
    createOllamaModel("mistral", { _factory: makeFakeFactory(captured) });
    expect(captured.value).toBeUndefined();
  });

  it("works as a drop-in for AIModel construction", () => {
    const languageModel = createOllamaModel("llava", { _factory: makeFakeFactory() });
    const aiModel = new AIModel(languageModel);
    expect(aiModel).toBeInstanceOf(AIModel);
    expect(aiModel.modelId).toBe("llava");
  });

  it("different modelIds produce distinct model objects", () => {
    const factory = makeFakeFactory();
    const m1 = createOllamaModel("llama3.2", { _factory: factory });
    const m2 = createOllamaModel("mistral", { _factory: factory });
    expect((m1 as any).modelId).toBe("llama3.2");
    expect((m2 as any).modelId).toBe("mistral");
    expect(m1).not.toBe(m2);
  });
});
