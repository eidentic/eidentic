import { describe, it, expect } from "vitest";
import {
  Agent,
  createTool,
  ToolRegistry,
  AIModel,
  AIEmbedder,
  SqliteStore,
  Memory,
  SuspendSignal,
  EnvSecrets,
  NoopSandbox,
  NoopLogger,
  envLogger,
  estimateTokens,
  compactMessages,
  replayHash,
  evaluatePermission,
  filterToolsForSchema,
  globMatch,
  memoryTools,
  isEditableMemory,
  graphTools,
  hasGraph,
  textBlock,
  toolUseBlock,
  imageBlock,
  isToolUse,
  isText,
  isImage,
  scopeKey,
  EidenticError,
  BudgetError,
  ValidationError,
  ToolError,
  StoreConflictError,
  tokenize,
  EVENT_SCHEMA_VERSION,
  BlockEditor,
  Consolidator,
  ConsolidationScheduler,
  reciprocalRankFusion,
  passiveExtract,
  regexPiiGuardrail,
  topicGuardrail,
} from "eidentic";
import type {
  Scope,
  ModelPort,
  StorePort,
  MemoryPort,
  AgentConfig,
  Tool,
  EraseScopeResult,
  GuardrailPort,
  GuardrailResult,
  GuardrailContext,
  RecencyOptions,
} from "eidentic";

describe("eidentic umbrella smoke test", () => {
  it("exports Agent", () => {
    expect(Agent).toBeDefined();
  });

  it("exports createTool", () => {
    expect(createTool).toBeDefined();
  });

  it("exports ToolRegistry", () => {
    expect(ToolRegistry).toBeDefined();
  });

  it("exports AIModel", () => {
    expect(AIModel).toBeDefined();
  });

  it("exports AIEmbedder", () => {
    expect(AIEmbedder).toBeDefined();
  });

  it("exports SqliteStore", () => {
    expect(SqliteStore).toBeDefined();
  });

  it("exports Memory", () => {
    expect(Memory).toBeDefined();
  });

  it("exports SuspendSignal", () => {
    expect(SuspendSignal).toBeDefined();
  });

  it("exports EnvSecrets", () => {
    expect(EnvSecrets).toBeDefined();
  });

  it("exports NoopSandbox", () => {
    expect(NoopSandbox).toBeDefined();
  });

  it("exports NoopLogger", () => {
    expect(NoopLogger).toBeDefined();
    expect(NoopLogger.enabled("debug", "test")).toBe(false);
  });

  it("exports envLogger", () => {
    expect(envLogger).toBeDefined();
    const logger = envLogger();
    expect(typeof logger.log).toBe("function");
  });

  it("exports estimateTokens", () => {
    expect(estimateTokens).toBeDefined();
  });

  it("exports compactMessages", () => {
    expect(compactMessages).toBeDefined();
  });

  it("exports replayHash", () => {
    expect(replayHash).toBeDefined();
  });

  it("exports evaluatePermission", () => {
    expect(evaluatePermission).toBeDefined();
  });

  it("exports filterToolsForSchema", () => {
    expect(filterToolsForSchema).toBeDefined();
  });

  it("exports globMatch", () => {
    expect(globMatch).toBeDefined();
  });

  it("exports memoryTools", () => {
    expect(memoryTools).toBeDefined();
  });

  it("exports isEditableMemory", () => {
    expect(isEditableMemory).toBeDefined();
  });

  it("exports graphTools", () => {
    expect(graphTools).toBeDefined();
  });

  it("exports hasGraph", () => {
    expect(hasGraph).toBeDefined();
  });

  it("exports textBlock", () => {
    expect(textBlock).toBeDefined();
    const b = textBlock("hello");
    expect(b.type).toBe("text");
  });

  it("exports toolUseBlock", () => {
    expect(toolUseBlock).toBeDefined();
  });

  it("exports imageBlock", () => {
    expect(imageBlock).toBeDefined();
    const b = imageBlock({ url: "https://example.com/img.png" });
    expect(b.type).toBe("image");
  });

  it("exports isToolUse", () => {
    expect(isToolUse).toBeDefined();
  });

  it("exports isText", () => {
    expect(isText).toBeDefined();
  });

  it("exports isImage", () => {
    expect(isImage).toBeDefined();
    const b = imageBlock({ url: "https://example.com/img.png" });
    expect(isImage(b)).toBe(true);
    expect(isImage(textBlock("hi"))).toBe(false);
  });

  it("exports scopeKey", () => {
    expect(scopeKey).toBeDefined();
    const key = scopeKey({ kind: "agent", agentId: "test" });
    expect(key).toBe("agent:test");
  });

  it("exports EidenticError", () => {
    expect(EidenticError).toBeDefined();
  });

  it("exports BudgetError", () => {
    expect(BudgetError).toBeDefined();
  });

  it("exports ValidationError", () => {
    expect(ValidationError).toBeDefined();
  });

  it("exports ToolError", () => {
    expect(ToolError).toBeDefined();
  });

  it("exports StoreConflictError", () => {
    expect(StoreConflictError).toBeDefined();
  });

  it("exports tokenize", () => {
    expect(tokenize).toBeDefined();
    expect(tokenize("hello world")).toEqual(["hello", "world"]);
  });

  it("exports EVENT_SCHEMA_VERSION", () => {
    expect(EVENT_SCHEMA_VERSION).toBeDefined();
    expect(typeof EVENT_SCHEMA_VERSION).toBe("number");
  });

  it("exports BlockEditor", () => {
    expect(BlockEditor).toBeDefined();
  });

  it("exports Consolidator", () => {
    expect(Consolidator).toBeDefined();
  });

  it("exports ConsolidationScheduler", () => {
    expect(ConsolidationScheduler).toBeDefined();
  });

  it("exports reciprocalRankFusion", () => {
    expect(reciprocalRankFusion).toBeDefined();
  });

  it("exports passiveExtract", () => {
    expect(passiveExtract).toBeDefined();
  });

  it("exports regexPiiGuardrail", () => {
    expect(regexPiiGuardrail).toBeDefined();
    const g = regexPiiGuardrail({ mode: "redact" });
    expect(typeof g).toBe("object");
  });

  it("exports topicGuardrail", () => {
    expect(topicGuardrail).toBeDefined();
  });

  it("type imports resolve (Scope, ModelPort, StorePort, MemoryPort, AgentConfig, Tool)", () => {
    // These are type-only; the test just ensures the types compile and imports resolve.
    const _scope: Scope = { kind: "agent", agentId: "x" };
    expect(_scope).toBeDefined();
  });

  it("type imports resolve (EraseScopeResult, GuardrailPort, GuardrailResult, GuardrailContext, RecencyOptions)", () => {
    // Type-only imports — compile check only.
    const _guard: GuardrailResult = { action: "allow" };
    const _ctx: GuardrailContext = { agentId: "x" };
    const _recency: RecencyOptions = { halfLifeMs: 3600_000 };
    expect(_guard).toBeDefined();
    expect(_ctx).toBeDefined();
    expect(_recency).toBeDefined();
  });
});
