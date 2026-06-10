/**
 * `eidentic` — convenience umbrella package.
 *
 * Install once and get the common Eidentic stack:
 *
 *   npm i eidentic ai @ai-sdk/openai
 *
 * Optional adapters (vector stores, sandboxes, eval, etc.) are opt-in:
 *
 *   npm i @eidentic/pgvector      # PostgreSQL vector store
 *   npm i @eidentic/lancedb       # LanceDB vector store
 *   npm i @eidentic/transformers  # local embedding / rerank
 *   npm i @eidentic/e2b           # E2B sandbox
 *   npm i @eidentic/mcp           # MCP host
 *   npm i @eidentic/skills        # skill substrate
 *   npm i @eidentic/eval          # eval harness
 */

// --- Core agent primitives ---
export {
  Agent,
  createTool,
  ToolRegistry,
  SuspendSignal,
  memoryTools,
  isEditableMemory,
  graphTools,
  hasGraph,
  // Kept despite internal-flag: smoke.test.ts asserts these by name; removing would break existing tests.
  replayHash,
  evaluatePermission,
  filterToolsForSchema,
  globMatch,
  EnvSecrets,
  NoopSandbox,
  NoopLogger,
  envLogger,
  estimateTokens,
  compactMessages,
  react,
  reflection,
  planAndExecute,
  regexPiiGuardrail,
  topicGuardrail,
} from "@eidentic/core";

export type {
  AgentConfig,
  QueryOptions,
  SubAgent,
  EraseScopeResult,
  Tool,
  ToolDef,
  ToolCall,
  ToolResult,
  SideEffect,
  ToolContext,
  RegistryOpts,
  GraphMemory,
  ExecutableSkillRunner,
  CompactionConfig,
  LazyToolConfig,
  ManifestState,
  AgentStrategy,
  StrategyContext,
  GroundSignal,
  RegexPiiGuardrailOptions,
  TopicGuardrailOptions,
} from "@eidentic/core";

// --- Shared types (ports, errors, protocol, observability, security) ---
// @eidentic/types is the canonical source for all shared type contracts.
export {
  scopeKey,
  textBlock,
  toolUseBlock,
  imageBlock,
  isToolUse,
  isText,
  isImage,
  EVENT_SCHEMA_VERSION,
  EidenticError,
  BudgetError,
  ValidationError,
  ToolError,
  StoreConflictError,
  tokenize,
} from "@eidentic/types";

export type {
  Scope,
  ModelMessage,
  ToolSchema,
  ModelRequest,
  ModelResponse,
  ModelStreamPart,
  ModelPort,
  MemoryBlock,
  BlockHistoryEntry,
  BlockEdit,
  RetrievalQuery,
  MemorySnippet,
  RetrievedMemory,
  MemoryEvent,
  MemoryPort,
  EditableMemoryPort,
  VectorEntry,
  VectorSearchResult,
  VectorPort,
  EmbeddingPort,
  RerankPort,
  SessionRecord,
  StorePort,
  Fact,
  AssertFactInput,
  FactQuery,
  GraphPort,
  Checkpoint,
  IdempotencyStatus,
  IdempotencyRecord,
  DurablePort,
  SuspendRequest,
  SuspendDecision,
  SkillCatalogEntry,
  SkillProvenance,
  LoadedSkill,
  SkillPort,
  ContentBlock,
  Usage,
  StreamDelta,
  TerminationSubtype,
  EventKind,
  StoredEvent,
  StreamEvent,
  ErrorClass,
  CostBreakdown,
  ModelPrice,
  PriceTable,
  CostPolicy,
  CostThresholdInfo,
  Span,
  TracerPort,
  PermissionMode,
  PermissionDecision,
  PermissionPolicy,
  SecretsPort,
  SandboxResult,
  SandboxRunOptions,
  SandboxPort,
  GuardrailPort,
  GuardrailResult,
  GuardrailContext,
} from "@eidentic/types";

// --- AI SDK model adapter ---
export { AIModel, AIEmbedder, defaultPrices, pricesUpdatedAt, fetchLatestPrices, mapLiteLLM } from "@eidentic/model";
export type { ModelResolver } from "@eidentic/model";

// --- SQLite persistence ---
export { SqliteStore } from "@eidentic/sqlite";

// --- Memory layer ---
export {
  Memory,
  reciprocalRankFusion,
  BlockEditor,
  Consolidator,
  passiveExtract,
  ConsolidationScheduler,
} from "@eidentic/memory";

export type {
  MemoryOptions,
  BlockHealth,
  DedupeOptions,
  DedupeResult,
  RecencyOptions,
  BlockSpec,
  BlockEditorOptions,
  ConsolidatorOptions,
  ConsolidationResult,
  ExtractedFact,
  PassiveFact,
  ConsolidationSchedulerOptions,
  MaintenanceResult,
} from "@eidentic/memory";
