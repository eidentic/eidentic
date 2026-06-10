import { z } from "zod";
import { sha256Hex } from "./sha256.js";
import type {
  ContentBlock,
  CostPolicy,
  CostThresholdInfo,
  DurablePort,
  GuardrailPort,
  LoggerPort,
  MemoryPort,
  ModelMessage,
  ModelPort,
  PermissionDecision,
  PermissionPolicy,
  PermissionMode,
  PriceTable,
  Scope,
  SecretsPort,
  SkillCatalogEntry,
  SkillPort,
  StorePort,
  StreamEvent,
  SuspendDecision,
  ToolSchema,
  TracerPort,
  Upcaster,
  Usage,
  SandboxPort,
} from "@eidentic/types";
import { addUsage, encodeMultimodalInput, extractTextFromBlocks, canonicalJson } from "@eidentic/types";
import { envLogger } from "./logger.js";
import { NoopSandbox } from "./sandbox.js";
import { ToolRegistry, createTool, type Tool } from "./tool.js";
import { Session } from "./session.js";
import { runTurn, resumeTurn, type StructuredOutputSpec } from "./loop.js";
import { isEditableMemory, memoryTools } from "./memory-tools.js";
import { hasGraph, graphTools } from "./graph-tools.js";
import { hasSkills, skillTools, hasExecutableSkills, buildSkillRunTool, type ExecutableSkillRunner } from "./skill-tools.js";
import { filterToolsForSchema } from "./permission.js";
import type { CompactionConfig } from "./compaction.js";
import { lazyDiscoveryTools, EAGER_TOOL_IDS } from "./discovery-tools.js";
import type { LazyToolConfig } from "./discovery-tools.js";
import type { AgentStrategy, StrategyContext } from "./strategies.js";

/** A sub-agent registered on a parent; becomes a `spawn_agent` target (§8.2). */
export interface SubAgent {
  /** A full Agent instance — its own model, tools, store, memory, policy. */
  agent: Agent;
  /** Shown to the parent model as this spawn target's purpose. */
  description: string;
  /** Optional typed structured return: the child's final text is JSON.parsed and validated against this. */
  outputSchema?: z.ZodType;
}

/**
 * Shared, mutable spend accumulator passed by reference across the whole agent tree (§8.6).
 * Every descendant folds its usage/usd into the SAME object so one budget governs the tree.
 */
export interface TreeBudget {
  usage: Usage;
  usd: number;
}

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

async function stableInputHash(input: unknown): Promise<string> {
  return (await sha256Hex(canonicalJson(input))).slice(0, 16);
}

/**
 * Build the loop-level structured-output spec from a user-supplied Zod schema:
 *  - `json`     — the JSON Schema sent to the model (over the `ModelRequest.outputSchema` port field),
 *  - `validate` — authoritative validation of the model's final object against the SOURCE Zod schema.
 *
 * Converting to JSON Schema for the wire while validating against the original Zod schema mirrors
 * `createTool` (which sends `z.toJSONSchema(inputSchema)` to the model but `safeParse`s with the Zod
 * schema). Validation is the source of truth; the JSON Schema is only a hint to the provider.
 */
function buildStructuredOutput(schema: z.ZodType): StructuredOutputSpec {
  return {
    json: z.toJSONSchema(schema),
    validate: (v: unknown) => {
      const r = schema.safeParse(v);
      return r.success
        ? { ok: true as const, value: r.data }
        : { ok: false as const, error: r.error.message };
    },
  };
}

export interface AgentConfig {
  id: string;
  instructions: string;
  model: ModelPort;
  tools?: Tool[];
  store: StorePort;
  maxTurns?: number;
  now?: () => string;
  newId?: () => string;
  memory?: MemoryPort;
  skills?: SkillPort;
  /** When true, the run is durable: checkpoints + exactly-once side effects. Requires the store to implement DurablePort. */
  durable?: boolean;
  // --- Plan 9b: cost governor + tracing ---
  /** Hard ceilings + soft cap (§11.2). `policy.maxTurns` overrides `maxTurns`. */
  policy?: CostPolicy;
  /** USD price table by model id; enables `usd` accounting + `maxCostUsd`/`softCostUsd`. */
  prices?: PriceTable;
  /** Model id used for price lookup and the `gen_ai.request.model` span attribute. */
  modelId?: string;
  /** OTel tracer (§11.1). Defaults to undefined (no spans). */
  tracer?: TracerPort;
  /**
   * Structured logger. When absent, defaults to `envLogger()` which is silent unless `DEBUG=eidentic:*`
   * is set — so the no-config path produces no output. Inject pino/datadog/etc. for production.
   */
  logger?: LoggerPort;
  /** Soft-cap hook: called once when `policy.softCostUsd` is first crossed. Does not abort. */
  onCostThreshold?: (info: CostThresholdInfo) => void;
  /** Injectable monotonic clock for wall-clock enforcement (ms). Defaults to Date.now. */
  monotonicNow?: () => number;
  // --- Plan 10: security foundations (§10.4 + §20) ---
  /** Deny-by-default permission policy. Statically-denied tools are removed from the schema sent to the model. */
  permissions?: PermissionPolicy;
  /** Credential vault; tools receive it in their ctx at call time (model never sees the values, §10.3). */
  secrets?: SecretsPort;
  /** Pre-tool-use hook: return "deny"/"allow" to short-circuit policy, or void/undefined to continue. */
  onPreToolUse?: (toolId: string, input: unknown) => PermissionDecision | void | Promise<PermissionDecision | void>;
  /** Dynamic resolver for "ask"-mode tools. Must return "allow" or "deny". */
  onPermissionRequest?: (toolId: string, input: unknown) => PermissionDecision | Promise<PermissionDecision>;
  /**
   * Post-tool-use hook: invoked after every tool dispatch (success AND error), awaited.
   *
   * A **throwing hook is swallowed** — the error is logged at "warn" level and the run continues
   * normally. This ensures observability hooks can never kill a production run.
   *
   * Fires at the single dispatch choke point in `ToolRegistry.runOne`, so it covers the normal
   * loop, the resume re-dispatch path, and any strategy sub-runs that use the same registry.
   * Does NOT fire for permission-denied or parse-error short-circuits (those never reach execution).
   *
   * @param info.toolId      - The tool's registered id.
   * @param info.input       - The parsed, validated input passed to the tool.
   * @param info.output      - The tool's return value (or the error object on an error result).
   * @param info.isError     - `true` when the tool threw or the dispatch produced an error result.
   * @param info.durationMs  - Wall-clock milliseconds from dispatch start to completion.
   * @param info.sessionId   - The session id for the current run (empty string when not set).
   */
  onPostToolUse?: (info: {
    toolId: string;
    input: unknown;
    output: unknown;
    isError: boolean;
    durationMs: number;
    sessionId: string;
  }) => void | Promise<void>;
  // --- Plan 12a/13a ---
  /**
   * Sandbox adapter for executing untrusted/agent-generated code (§10.5, §10.7).
   * Defaults to `new NoopSandbox()` — which refuses all `run()` calls — so deployments
   * that wire no real sandbox get safe refusals rather than host-process execution.
   * Future executors (plan 12b skill exec) should read `agent.sandbox` instead of
   * constructing their own to get this fail-safe default by construction.
   */
  sandbox?: SandboxPort;
  // --- D7: content guardrails ---
  /**
   * Input/output content guardrails (D7). One or more `GuardrailPort` instances applied in order.
   * Off by default (no guardrails when omitted).
   *
   * - **Input guardrails** run on the user's raw text before the first model call:
   *   `block` → run terminates with `subtype: "guardrail"` (model is never called);
   *   `redact` → the redacted text is passed to the model instead.
   * - **Output guardrails** run on the assistant's final text before it is returned:
   *   `block` → the final event carries a safe replacement message and `subtype: "guardrail"`;
   *   `redact` → the final event carries the redacted text.
   *
   * Multiple guardrails run in order; the first `block` result wins.
   *
   * The reference adapter `regexPiiGuardrail()` from `@eidentic/core` covers emails, phone numbers,
   * credit-card numbers, and SSNs with a pure-JS regex implementation (no external deps).
   * For enterprise deployments, wire in an external content-moderation API via this port.
   */
  guardrails?: GuardrailPort | GuardrailPort[];
  // --- Plan 13a: multi-agent (§8) ---
  /** Named sub-agents; each becomes a `spawn_agent` target shown to the parent model. */
  subAgents?: Record<string, SubAgent>;
  /** Max spawn depth (§8.3). Default 1: sub-agents cannot spawn sub-sub-agents. */
  maxDepth?: number;
  /**
   * Registered executable skill bank (§7.4). When present, a `skill_run` tool is added to
   * each per-query registry so the model can invoke registered, approved skills. Skill
   * authoring/registration is HOST-SIDE ONLY — the agent can ONLY RUN already-registered,
   * non-quarantined skills. `SkillBank` from `@eidentic/skills` structurally satisfies this
   * interface; the dep boundary is preserved via a structural interface (no runtime import).
   */
  executableSkills?: ExecutableSkillRunner;
  // --- Plan 15: context-engine compaction (§4.4) ---
  /** Progressive token-budget-triggered compaction of the in-context window. Absent → never compacts. */
  compaction?: CompactionConfig;
  /** Fired before any compaction drops/condenses, so the caller can archive the full transcript. */
  onPreCompact?: (info: { messages: ModelMessage[]; estTokens: number }) => void | Promise<void>;
  // --- Plan 19: lazy tool discovery (§5.4) ---
  /**
   * Context-cost control for large toolsets. `false` (or omitted) → DISABLED: manifest is
   * byte-identical to today's full `registry.schemas()` every turn.
   * `true` → AUTO with defaults: lazy activates only when the effective toolset exceeds `threshold`
   * (default 20), so small agents are unaffected with zero config.
   * An object overrides `threshold`/`eager`/`topK`.
   * The eager set ALWAYS includes `search_tools`/`load_tool` so discovery is always reachable.
   * Discovery is a context optimization only — it NEVER gates dispatch (permissions are the only gate).
   */
  lazyTools?: boolean | { threshold?: number; eager?: string[]; topK?: number };
  // --- Plan 20: composable agent strategies (§3.6) ---
  /**
   * Reasoning strategy layered over the ReAct loop. Absent (or `react()`) → the default loop,
   * behavior byte-identical to today. Pass `reflection({...})` or `planAndExecute({...})` for
   * multi-pass critique or hierarchical plan execution.
   *
   * Note: strategies are forward-run only for v1. `resume()` always uses the plain react path.
   */
  strategy?: AgentStrategy;
  // --- §19.1: event-schema upcasting ---
  /**
   * Custom upcaster chain for event-schema migration (§19.1). Merged on top of the built-in
   * DEFAULT_UPCASTERS registry (custom wins). Use when replaying a log persisted at an older
   * EVENT_SCHEMA_VERSION: add upcasters[n] = (e) => { ...transform...; return { ...e, schemaVersion: n+1 } }
   * for each version gap. At v1 this field is not needed — the built-in registry handles everything.
   */
  upcasters?: Record<number, Upcaster>;
  // --- §19.4: instruction/prompt versioning ---
  /**
   * An opaque version tag for the agent's instructions (§19.4). When set, it is included in the
   * `session.init` stream event payload so traces/sessions record which prompt version produced them.
   * No behavior change when unset — the `session.init` payload is byte-identical to before.
   */
  instructionsVersion?: string;
  /**
   * Per-turn context injection hook. Called at the start of each model turn (before the model call).
   * The returned string(s) are appended to that turn's model request as a clearly-delimited
   * system-reminder block inside a user-role message so the model sees them as contextual guidance.
   *
   * **Semantics:**
   * - Called once per model turn (turn 0, 1, 2, …) — even on the resume path.
   * - The returned string(s) are ephemeral: they are NOT persisted to the session event log and
   *   will NOT appear on subsequent turns or on session replay. Each turn gets a fresh injection
   *   if the hook returns content for it.
   * - Returning `void` (or `undefined`) for a turn suppresses injection for that turn.
   * - Multiple strings are concatenated with a newline separator inside the block.
   *
   * **Use cases:** updated user preferences, ambient system state, per-turn feature flags, external
   * tool results that should not be part of the permanent record.
   *
   * **Security note:** the returned content is trusted operator content — it is injected as a
   * system-level message. Do NOT forward untrusted user or third-party content here without
   * sanitisation. Prompt-injection via this hook has the same severity as modifying `instructions`.
   *
   * **Async:** the hook is awaited; async hooks (e.g. fetching fresh preferences from a DB) work.
   */
  onTurnStart?: (ctx: { sessionId: string; turn: number }) => string | string[] | void | Promise<string | string[] | void>;
  // --- UI affordance: static opening message ---
  /**
   * Optional static greeting shown to the user before the first turn. This is a **UI affordance**
   * — it is never sent to the model, never persisted as an assistant event, and costs no tokens.
   *
   * **Full prompt-customization story:**
   * - **System prompt / persona** — `instructions` shapes the model's behavior and tone.
   * - **Persona / memory** — memory blocks (`AgentConfig.memory`) inject per-user/org context.
   * - **User prompt** — the input string passed to `agent.query(input, ...)`.
   * - **Greeting** — this field: a static string shown to the user by the UI (e.g. a chat widget)
   *   as an initial assistant bubble before the first message. Read via `agent.greeting` or
   *   from the `session.init` stream event's `greeting` field so the front-end can render it
   *   immediately — no round-trip needed.
   *
   * When absent, `agent.greeting` returns `undefined` and the `session.init` event omits the field.
   */
  greeting?: string;
  // --- D6: prompt caching ---
  /**
   * When `true`, each model call marks the stable system-prompt prefix as cacheable using the
   * provider's KV-cache (prefix-caching) mechanism. On Anthropic the AI SDK sets
   * `cacheControl: { type: "ephemeral" }` on the system message; OpenAI caches the prefix
   * automatically; other providers ignore the hint gracefully.
   *
   * Off by default — requests are byte-identical when `promptCache` is absent or `false`.
   * Most effective when the system prompt is large (thousands of tokens) and stable across turns.
   * Cache hits surface via `Usage.cachedInputTokens` and the OTel `kv_cache_hit_rate` attribute.
   */
  promptCache?: boolean;
  // --- Feature 1: model retry/backoff ---
  /**
   * Retry transient model failures (network errors, 429, 5xx) on the non-streaming path.
   * When set, `complete()` is retried up to `maxAttempts` times with `backoffMs` between tries.
   * **Streaming is NOT retried** — once the streaming call yields its first delta, retrying is
   * impossible without rebuffering (which breaks incremental streaming). AbortError is never retried.
   * Default: OFF (omit for no retries).
   */
  modelRetry?: { maxAttempts: number; backoffMs?: number };
  // --- Feature 1: model fallback chain ---
  /**
   * Ordered list of fallback `ModelPort` instances tried when the primary model fails after
   * exhausting `modelRetry` (or immediately on any failure when no retry is configured).
   * The first fallback that succeeds wins; if all fallbacks also fail the last error surfaces.
   *
   * **Streaming fallback:** only attempted when the primary stream throws BEFORE any delta has
   * been yielded. Once the consumer has received a delta the stream has started and cannot be
   * rewound — the run terminates with an error instead of falling back.
   *
   * **AbortError:** never triggers fallback. An abort propagates immediately regardless of
   * how many fallbacks remain.
   *
   * Default: none (no fallbacks — primary only).
   */
  modelFallback?: ModelPort[];
  // --- Feature 2: structured-output validation retry ---
  /**
   * When `outputSchema` is used and the model's final answer fails schema validation, retry
   * with a corrective message up to `maxAttempts` additional times before surfacing the error.
   *
   * `maxAttempts` is the number of RETRIES beyond the first attempt:
   * - `{ maxAttempts: 0 }` → no retries; validation failure is terminal immediately.
   * - `{ maxAttempts: 2 }` → up to 3 total model calls (1 initial + 2 retries).
   *
   * Default: ON with `maxAttempts: 2` — prevents a single bad structured response from
   * failing the whole run. Set `{ maxAttempts: 0 }` to restore previous behavior.
   */
  structuredOutputRetry?: { maxAttempts: number };
}

export interface QueryOptions {
  sessionId: string;
  userId?: string;
  /** The org identity for multi-tenant session ownership (Fix 1). When set, recorded on the SessionRecord. */
  orgId?: string;
  /** The API key identity for multi-tenant session ownership (H1 fix). When set and no userId/orgId
   * is present, recorded on the SessionRecord so apiKey-only principals own their sessions. */
  apiKey?: string;
  /** AbortSignal threaded into ToolContext.signal for every tool invocation in this query. */
  signal?: AbortSignal;
  /**
   * Structured / schema-constrained final output. Pass a Zod schema (same convention as
   * `createTool`'s `inputSchema`). The agent still runs its full multi-turn tool loop; only the
   * FINAL (tool-less) turn is constrained to emit an object matching this schema. The parsed,
   * validated value is surfaced on the terminal `result` event as `result.object` (alongside the
   * raw text on `result.output`). If the model's structured answer fails validation, the run
   * terminates with `subtype: "error"` describing the mismatch. Backward-compatible: when omitted,
   * `query()` behaves byte-identically to before.
   *
   * Strategies: when a `strategy` is configured, the schema constrains ONLY the strategy's FINAL
   * answer — intermediate react sub-runs (reflection's draft/critique passes, planAndExecute's
   * per-step runs) stay UNCONSTRAINED so they can call tools / emit free text. After the strategy
   * produces its accepted answer, a single final schema-constrained pass renders it as the object.
   */
  outputSchema?: z.ZodType;
}

/**
 * Internal-only query options (NOT part of the public API). `_depth` tracks spawn depth for
 * schema-level maxDepth gating (§8.3); `_budget` is the shared tree spend accumulator (§8.6).
 * Threaded only by `spawn_agent`; public callers use `QueryOptions`.
 */
interface InternalQueryOptions extends QueryOptions {
  _depth?: number;
  _budget?: TreeBudget;
}

const defaultNow = () => new Date().toISOString();

/** Module-level monotone counter — shared across all Agent instances so defaultNewId never collides. */
let _globalIdSeq = 0;

/** Structural check: does the store also implement DurablePort? */
function asDurable(store: StorePort): DurablePort | undefined {
  const d = store as Partial<DurablePort>;
  return typeof d.writeCheckpoint === "function" &&
    typeof d.lastCheckpoint === "function" &&
    typeof d.recordIntent === "function" &&
    typeof d.recordCompletion === "function" &&
    typeof d.getIdempotency === "function"
    ? (store as unknown as DurablePort)
    : undefined;
}

export class Agent {
  private readonly baseTools: Tool[];
  private readonly registry: ToolRegistry;
  private defaultNewId = () => `evt_${Date.now().toString(36)}_${(_globalIdSeq++).toString(36)}`;
  private readonly _sandbox: SandboxPort;
  /**
   * Mutable effective permission policy (design §10.4: "modes are changeable mid-session").
   * Initialized from `config.permissions`; updated by `setPermissionMode`.
   * Each call to `query()` or `resume()` reads the CURRENT value of this field,
   * so a mode change takes effect on the next turn/query.
   */
  private _effectivePermissions: PermissionPolicy | undefined;
  /** Memoized lazy store migration so callers don't have to call `store.migrate()` themselves. */
  private _migrated?: Promise<void>;
  /** One-time guard for the "memory configured but no userId" warning. */
  private _warnedNoUserId = false;

  constructor(private readonly config: AgentConfig) {
    this.baseTools = config.tools ?? [];
    this.registry = new ToolRegistry(this.baseTools);
    this._sandbox = config.sandbox ?? new NoopSandbox();
    this._effectivePermissions = config.permissions ? { ...config.permissions } : undefined;

    // A11: Warn once when no permissions policy is configured but dangerous tools are registered.
    // Without a policy, ALL tools are allowed by default — including bash, write_file, spawn_agent,
    // and any tool with sideEffect:"destructive". This is a one-time construction-time warning.
    if (!config.permissions) {
      const DANGEROUS_IDS = new Set(["bash", "write_file", "spawn_agent"]);
      const dangerousTools = this.baseTools.filter(
        (t) => DANGEROUS_IDS.has(t.id) || t.sideEffect === "destructive",
      );
      if (dangerousTools.length > 0) {
        const logger = config.logger ?? envLogger();
        const names = dangerousTools.map((t) => `'${t.id}'`).join(", ");
        logger.log(
          "warn",
          "eidentic:permission",
          `Agent '${config.id}' has no permissions policy but registers dangerous tools: [${names}]. ` +
            "Without a policy, ALL tool calls are permitted. Pass `permissions` to restrict access " +
            "(e.g. { mode: 'auto' } or { deny: ['bash', 'write_file'] }).",
        );
      }
    }
  }

  /**
   * Change the permission mode for the agent's effective policy (§10.4).
   * The change takes effect on the NEXT call to `query()` or `resume()` — satisfying
   * the "mid-session, between turns" requirement. Existing in-flight turns are unaffected.
   *
   * If no `permissions` were configured on the agent, this call initialises an effective
   * policy with only the specified mode (all other fields stay absent).
   */
  setPermissionMode(mode: PermissionMode): void {
    if (this._effectivePermissions) {
      this._effectivePermissions = { ...this._effectivePermissions, mode };
    } else {
      this._effectivePermissions = { mode };
    }
  }

  /**
   * The resolved sandbox adapter for this agent (§10.5, §10.7).
   * Defaults to `NoopSandbox` — which refuses all `run()` calls with exitCode 1 — when no
   * sandbox was configured. Future executors should read this property rather than constructing
   * their own sandbox instances to get the secure-by-default behaviour.
   */
  get sandbox(): SandboxPort {
    return this._sandbox;
  }

  /**
   * The agent's persistent event store. Exposed as a public getter so consumers (e.g. the
   * server package) can read events without resorting to private-field casts.
   */
  get store(): StorePort {
    return this.config.store;
  }

  /** The model id configured on the agent (may be undefined if the model does not advertise one). */
  get modelId(): string | undefined {
    return this.config.modelId ?? this.config.model.modelId;
  }

  /** The agent's system prompt / instructions. */
  get instructions(): string {
    return this.config.instructions;
  }

  /**
   * The agent's static greeting (UI affordance). Present when `AgentConfig.greeting` was set;
   * `undefined` otherwise. Also surfaced on the `session.init` stream event as `greeting`.
   */
  get greeting(): string | undefined {
    return this.config.greeting;
  }

  /**
   * Returns the agent's prompt-skill catalog entries (Tier-1, always-in-context).
   * These come from `config.skills` (a SkillPort / SkillSet). Returns [] when no
   * skills are configured or the configured value does not implement `catalog()`.
   */
  skillCatalog(): SkillCatalogEntry[] {
    if (this.config.skills && hasSkills(this.config.skills)) {
      return this.config.skills.catalog();
    }
    return [];
  }

  /**
   * The effective tool set for a default (agent-scoped) query — the configured tools plus
   * all auto-added tool groups (memory_*, graph_*, skill_*, spawn_agent, discovery) that would
   * be present in a fresh turn. The set is assembled without a live durable/signal/session;
   * it is intended for introspection (e.g. the Studio UI) rather than execution.
   */
  toolSchemas(): ToolSchema[] {
    const scope: Scope = { kind: "agent", agentId: this.config.id };
    const tools = [...this.baseTools];

    if (this.config.memory && isEditableMemory(this.config.memory)) {
      const mem = this.config.memory;
      tools.push(...memoryTools(mem, scope));
      if (hasGraph(mem)) tools.push(...graphTools(mem, scope));
    }
    if (this.config.skills && hasSkills(this.config.skills)) {
      tools.push(...skillTools(this.config.skills));
    }
    // spawn_agent: include at depth=0 (the surface introspection case).
    const spawnTool = this.buildSpawnTool(0, { usage: { inputTokens: 0, outputTokens: 0 }, usd: 0 });
    if (spawnTool) tools.push(spawnTool);

    // skill_run: represented by a stub ref (just to get its schema) — we use a no-op ref since
    // we only need the schema list, not dispatch.
    if (this.config.executableSkills && hasExecutableSkills(this.config.executableSkills)) {
      const stubRef: { registry: import("./tool.js").ToolRegistry | null } = { registry: null };
      tools.push(buildSkillRunTool(this.config.executableSkills, stubRef));
    }

    // discovery meta-tools (schema only — no lazy overhead since we skip the registry build).
    const lazyTools = this.resolveLazyTools();
    if (lazyTools) {
      tools.push(...lazyDiscoveryTools(() => [], { eager: lazyTools.eager, topK: lazyTools.topK }));
    }

    // Build a minimal registry (no durable/secrets/signal) to apply permission filtering,
    // then return schemas as the caller would see them.
    const registry = this.buildRegistry(tools, undefined, scope, undefined, undefined);
    return registry.schemas();
  }

  private resolveDurable(): DurablePort | undefined {
    if (!this.config.durable) return undefined;
    const d = asDurable(this.config.store);
    if (!d) {
      throw new Error(
        "Agent: `durable: true` requires a store implementing DurablePort (e.g. SqliteStore). " +
        "The configured store does not provide checkpoint/idempotency methods.",
      );
    }
    return d;
  }

  /** Resolve the run's LazyToolConfig from config, or undefined when disabled. */
  private resolveLazyTools(): LazyToolConfig | undefined {
    const cfg = this.config.lazyTools;
    if (cfg === undefined || cfg === false) {
      // Omitted/false → DISABLED so the manifest is byte-identical with zero overhead.
      // Opt in with `true` or an object to get AUTO.
      return undefined;
    }
    const obj = cfg === true ? {} : cfg;
    const eager = new Set<string>(obj.eager ?? EAGER_TOOL_IDS);
    // The two meta-tools MUST be eager so the model can always discover, regardless of caller override.
    eager.add("search_tools");
    eager.add("load_tool");
    return { eager, topK: obj.topK ?? 5, threshold: obj.threshold ?? 20 };
  }

  /**
   * Build the `spawn_agent` tool for this query, or `undefined` when it should be absent
   * from the schema (§8.3: no subAgents, OR depth budget exhausted). When present, calling it
   * runs the chosen sub-agent in a fresh isolated session and folds its cost into the tree budget.
   * §16.4: `signal` is the parent query's AbortSignal, threaded into the child so the parent's
   * abort propagates down the tree.
   */
  private buildSpawnTool(depth: number, budget: TreeBudget, signal?: AbortSignal): Tool | undefined {
    const subAgents = this.config.subAgents;
    if (!subAgents) return undefined;
    const names = Object.keys(subAgents);
    if (names.length === 0) return undefined;
    const maxDepth = this.config.maxDepth ?? 1;
    if (depth >= maxDepth) return undefined; // schema-level depth gate

    const newId = this.config.newId ?? this.defaultNewId;
    const policy = this.config.policy;

    // The enum MUST be non-empty (Zod requires ≥1) — guaranteed by the names.length check above.
    const agentEnum = z.enum(names as [string, ...string[]]);
    const roster = names.map((n) => `- ${n}: ${subAgents[n]!.description}`).join("\n");

    const spawnInputSchema = z.object({
      agent: agentEnum,
      input: z.string().describe("The full self-contained instruction for the sub-agent."),
    });

    return createTool({
      id: "spawn_agent",
      description:
        "Delegate a focused sub-task to a specialized sub-agent. The sub-agent runs in a fresh, " +
        "isolated context (it receives ONLY your `input`, never this conversation) and returns its result.\n" +
        `Available sub-agents:\n${roster}`,
      // A sub-agent run is re-runnable but not a pure read; "idempotent" so the registry serializes
      // spawns (NOT concurrent) — required to keep the shared tree-budget accounting consistent (§8.6).
      sideEffect: "idempotent",
      // Fix 2: stable idempotency key so a durable resume skips re-running the subtree (§9.3).
      idempotencyKey: async (inp) => `spawn:${inp.agent}:${await stableInputHash(inp.input)}`,
      inputSchema: spawnInputSchema,
      execute: async ({ input }) => {
        const sub = subAgents[input.agent];
        if (!sub) throw new Error(`unknown sub-agent '${input.agent}'`);

        // §8.6 pre-spawn tree-budget gate: refuse to launch if the tree is already at/over budget.
        if (policy?.maxCostUsd !== undefined && budget.usd >= policy.maxCostUsd) {
          throw new Error(`tree cost budget exceeded ($${budget.usd.toFixed(4)} >= $${policy.maxCostUsd}); aborting spawn`);
        }
        if (policy?.maxTokens !== undefined && budget.usage.inputTokens + budget.usage.outputTokens >= policy.maxTokens) {
          throw new Error(`tree token budget exceeded; aborting spawn`);
        }

        // Run the child in a FRESH isolated session; only `input` crosses the boundary (§8.3).
        // §16.4: thread the parent's signal into the child so aborting the parent aborts children.
        const childOpts: InternalQueryOptions = {
          sessionId: `${newId()}_child`,
          _depth: depth + 1,
          _budget: budget,
          ...(signal ? { signal } : {}),
        };

        let childOutput = "";
        let childUsage: Usage = { ...ZERO_USAGE };
        let childUsd: number | undefined;
        let childSubtype: string = "error";
        for await (const ev of sub.agent.query(input.input, childOpts)) {
          if (ev.type === "result") {
            childOutput = typeof ev.output === "string" ? ev.output : (ev.output == null ? "" : String(ev.output));
            childUsage = ev.usage;
            childUsd = ev.cost?.usd;
            childSubtype = ev.subtype;
          }
        }

        // Fold the child's OWN-FOREGROUND spend into the shared tree budget (§8.6).
        // Tokens: childUsage is already the child's own foreground (correct, unchanged).
        //
        // Fix 1 — USD: childUsd (= child's cost.usd from breakdownFor) equals:
        //   child_own_foreground_usd + budget.usd_at_the_time_child_called_breakdownFor
        // budget.usd AT THIS POINT (after the for-await) already contains any grandchildren's spend
        // accumulated during the child's run. That is exactly what child's breakdownFor used as its
        // `childrenUsd`. So:
        //   child_own_foreground_usd = childUsd - budget.usd  (snapshot AFTER the child's run)
        // This avoids the double-count: grandchild spend already in budget.usd is NOT added again.
        const budgetUsdAfterChild = budget.usd;
        budget.usage = addUsage(budget.usage, childUsage);
        if (childUsd !== undefined) {
          const childOwnForegroundUsd = Math.max(0, childUsd - budgetUsdAfterChild);
          budget.usd += childOwnForegroundUsd;
        }

        // Fix 3: a non-success terminal is just as failed as a malformed output — surface as tool error.
        if (childSubtype !== "success") {
          throw new Error(`sub-agent '${input.agent}' did not succeed: ${childSubtype}`);
        }

        if (sub.outputSchema) {
          let json: unknown;
          try {
            json = JSON.parse(childOutput);
          } catch {
            throw new Error(`sub-agent '${input.agent}' output is not valid JSON for the requested schema: ${childOutput.slice(0, 200)}`);
          }
          const parsed = sub.outputSchema.safeParse(json);
          if (!parsed.success) {
            throw new Error(`sub-agent '${input.agent}' output failed schema validation: ${parsed.error.message}`);
          }
          return { ok: true, output: parsed.data, usage: childUsage };
        }

        return { ok: true, output: childOutput, usage: childUsage };
      },
    });
  }

  /**
   * Assemble the per-run tool list from the base tools + memory/graph/skills/spawnTool/skill_run/discovery.
   * Returns the final tools array and the two late-bound registry cells that must be backfilled after
   * `buildRegistry` runs (so each closure captures the final permission-filtered registry).
   */
  private buildToolsForRun(
    scope: Scope,
    spawnTool?: Tool | undefined,
    lazyTools?: LazyToolConfig | undefined,
  ): {
    tools: Tool[];
    execSkillRegRef: { registry: import("./tool.js").ToolRegistry | null };
    discoveryRegRef: { registry: import("./tool.js").ToolRegistry | null };
  } {
    const tools = [...this.baseTools];
    if (this.config.memory && isEditableMemory(this.config.memory)) {
      const mem = this.config.memory;
      tools.push(...memoryTools(mem, scope));
      if (hasGraph(mem)) tools.push(...graphTools(mem, scope));
    }
    if (this.config.skills && hasSkills(this.config.skills)) {
      tools.push(...skillTools(this.config.skills));
    }
    if (spawnTool) tools.push(spawnTool);

    const execSkillRegRef: { registry: import("./tool.js").ToolRegistry | null } = { registry: null };
    if (this.config.executableSkills && hasExecutableSkills(this.config.executableSkills)) {
      tools.push(buildSkillRunTool(this.config.executableSkills, execSkillRegRef));
    }

    const discoveryRegRef: { registry: import("./tool.js").ToolRegistry | null } = { registry: null };
    if (lazyTools) {
      tools.push(...lazyDiscoveryTools(() => discoveryRegRef.registry?.schemas() ?? [], { eager: lazyTools.eager, topK: lazyTools.topK }));
    }

    return { tools, execSkillRegRef, discoveryRegRef };
  }

  private buildRegistry(tools: Tool[], durable: DurablePort | undefined, scope: Scope, signal?: AbortSignal, sessionId?: string, logger?: import("@eidentic/types").LoggerPort): ToolRegistry {
    // Use the MUTABLE effective policy so that setPermissionMode() takes effect on the next query.
    const permissions = this._effectivePermissions;
    const { secrets, onPreToolUse, onPermissionRequest, onPostToolUse } = this.config;
    const hasSecurityConfig = permissions !== undefined || secrets !== undefined ||
      onPreToolUse !== undefined || onPermissionRequest !== undefined;

    // Apply schema-layer filtering: remove statically-denied tools before the model ever sees them.
    const filteredTools = permissions ? filterToolsForSchema(tools, permissions) : tools;

    // Reuse the cached base registry only when nothing meaningful differs from the plain baseline.
    // sessionId only matters when durable is set, and a durable run is never the baseline
    // (durable truthy ⇒ isBaseline false). So baseline reuse stays correct.
    // A logger also invalidates the baseline (logger overrides NoopLogger in the base registry).
    const isBaseline = filteredTools.length === this.baseTools.length && !durable && !hasSecurityConfig && !signal && !logger && !onPostToolUse;
    if (isBaseline) return this.registry;

    return new ToolRegistry(filteredTools, {
      ...(durable ? { durable } : {}),
      ...(permissions ? { permissions } : {}),
      ...(secrets ? { secrets } : {}),
      ...(onPreToolUse ? { onPreToolUse } : {}),
      ...(onPermissionRequest ? { onPermissionRequest } : {}),
      ...(onPostToolUse ? { onPostToolUse } : {}),
      ...(signal ? { signal } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(logger ? { logger } : {}),
      scope,
    });
  }

  /**
   * The core ReAct loop, extracted as a private generator so strategy wrappers can re-enter it.
   * When `runtime.model` is provided, it overrides `this.config.model` for this sub-run only
   * (used by planAndExecute to run steps on a cheaper executor model).
   *
   * The body is VERBATIM from the former `query` implementation — extracting it here is a pure
   * seam refactor with zero behavior change for the no-strategy path.
   */
  private async *runReact(
    input: string,
    opts: QueryOptions,
    runtime?: { model?: ModelPort },
  ): AsyncIterable<StreamEvent> {
    const internal = opts as InternalQueryOptions;
    const depth = internal._depth ?? 0;
    // Root of the tree creates the shared budget; descendants reuse the same object by reference.
    const budget: TreeBudget = internal._budget ?? { usage: { ...ZERO_USAGE }, usd: 0 };

    const now = this.config.now ?? defaultNow;
    const newId = this.config.newId ?? this.defaultNewId;
    const durable = this.resolveDurable();
    const scope: Scope = opts.userId
      ? { kind: "user", agentId: this.config.id, userId: opts.userId }
      : { kind: "agent", agentId: this.config.id };

    // §8.3: spawn_agent is added ONLY when subAgents exist AND depth < maxDepth — so a child at
    // the depth limit structurally cannot see (and thus cannot call) spawn_agent.
    // §16.4: pass the query signal so child agents abort with the parent (tree teardown).
    const spawnTool = this.buildSpawnTool(depth, budget, opts.signal);
    const lazyTools = this.resolveLazyTools();
    const { tools, execSkillRegRef, discoveryRegRef } = this.buildToolsForRun(scope, spawnTool ?? undefined, lazyTools ?? undefined);

    // Resolve logger once per run: injected logger wins; else envLogger() (silent when DEBUG unset).
    const logger = this.config.logger ?? envLogger();
    const registry = this.buildRegistry(tools, durable, scope, opts.signal, opts.sessionId, logger);
    execSkillRegRef.registry = registry;
    discoveryRegRef.registry = registry; // search/load now see the final permission-filtered catalog

    const session = await Session.open(this.config.store, {
      sessionId: opts.sessionId,
      agentId: this.config.id,
      now,
      newId,
      ...(this.config.upcasters ? { upcasters: this.config.upcasters } : {}),
      // Fix 1: record owner identity so the session belongs to the authenticated principal.
      ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
      ...(opts.orgId !== undefined ? { orgId: opts.orgId } : {}),
      // H1 fix: record apiKey when present so apiKey-only principals own their sessions.
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    });

    // runtime.model overrides this.config.model for plan-execute executor sub-runs.
    const effectiveModel = runtime?.model ?? this.config.model;

    yield* runTurn({
      agentId: this.config.id,
      instructions: this.config.instructions,
      input,
      model: effectiveModel,
      registry,
      session,
      scope,
      store: this.config.store,
      maxTurns: this.config.maxTurns ?? 16,
      memory: this.config.memory,
      logger,
      ...(durable ? { durable } : {}),
      ...(this.config.skills && hasSkills(this.config.skills) ? { skillCatalog: this.config.skills.catalog() } : {}),
      ...(this.config.policy ? { policy: this.config.policy } : {}),
      ...(this.config.prices ? { prices: this.config.prices } : {}),
      ...((this.config.modelId ?? this.config.model.modelId) ? { modelId: this.config.modelId ?? this.config.model.modelId } : {}),
      ...(this.config.tracer ? { tracer: this.config.tracer } : {}),
      ...(this.config.onCostThreshold ? { onCostThreshold: this.config.onCostThreshold } : {}),
      ...(this.config.monotonicNow ? { monotonicNow: this.config.monotonicNow } : {}),
      budget,
      ...(this.config.compaction ? { compaction: this.config.compaction } : {}),
      ...(this.config.onPreCompact ? { onPreCompact: this.config.onPreCompact } : {}),
      ...(lazyTools ? { lazyTools } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.outputSchema ? { outputSchema: buildStructuredOutput(opts.outputSchema) } : {}),
      ...(this.config.instructionsVersion !== undefined ? { instructionsVersion: this.config.instructionsVersion } : {}),
      ...(this.config.promptCache ? { promptCache: true } : {}),
      ...(this.config.guardrails ? { guardrails: Array.isArray(this.config.guardrails) ? this.config.guardrails : [this.config.guardrails] } : {}),
      ...(this.config.greeting !== undefined ? { greeting: this.config.greeting } : {}),
      ...(this.config.modelRetry ? { modelRetry: this.config.modelRetry } : {}),
      ...(this.config.modelFallback && this.config.modelFallback.length > 0 ? { modelFallback: this.config.modelFallback } : {}),
      ...(this.config.structuredOutputRetry !== undefined ? { structuredOutputRetry: this.config.structuredOutputRetry } : {}),
      ...(this.config.onTurnStart ? { onTurnStart: this.config.onTurnStart } : {}),
    });
  }

  /**
   * Run-once readiness: lazily migrate the store (so callers don't have to remember
   * `store.migrate()`), and warn (once) when memory is configured but no `userId` was passed —
   * cross-session memory is scoped per userId, so omitting it silently disables persistence.
   */
  private async ensureReady(userId: string | undefined): Promise<void> {
    this._migrated ??= Promise.resolve(this.config.store.migrate());
    await this._migrated;
    if (this.config.memory && userId === undefined && !this._warnedNoUserId) {
      this._warnedNoUserId = true;
      (this.config.logger ?? envLogger()).log(
        "warn",
        "eidentic:memory",
        "memory is configured but query()/resume() was called without `userId`. Cross-session " +
          "memory (blocks, recall, facts) is scoped per userId; without it, durable memory is not " +
          "shared across sessions. Pass { userId } to enable it.",
      );
    }
  }

  /**
   * Run the agent for one user turn, streaming events.
   *
   * **Overloads:**
   * - `query(input: string, opts)` — plain text user message (original signature, backward-compatible).
   * - `query(input: ContentBlock[], opts)` — rich multimodal input. The array may contain `text` and
   *   `image` blocks. Text blocks are extracted for guardrail checks, memory retrieval, and event
   *   logging. Image blocks are forwarded to the model as AI SDK `ImagePart`s (vision). Use this
   *   overload to pass images alongside text to vision-capable models such as `llava` (Ollama),
   *   `claude-3-5-sonnet`, `gpt-4o`, etc.
   *
   * **Example — multimodal:**
   * ```ts
   * import { imageBlock, textBlock } from "@eidentic/types";
   *
   * for await (const ev of agent.query(
   *   [textBlock("What is in this image?"), imageBlock({ url: "https://..." })],
   *   { sessionId: "s1" },
   * )) { ... }
   * ```
   */
  async *query(input: string | ContentBlock[], opts: QueryOptions): AsyncIterable<StreamEvent> {
    await this.ensureReady(opts.userId);

    // Normalize ContentBlock[] → string for the loop. When the input contains image blocks,
    // encode the full block array as a sentinel-prefixed JSON string so the event log stores
    // it faithfully and mapMessages can later decode it to produce AI SDK ImagePart objects.
    // For text-only ContentBlock[], collapse to a plain string (no encoding overhead).
    let loopInput: string;
    if (Array.isArray(input)) {
      const hasImages = input.some((b) => b.type === "image");
      loopInput = hasImages ? encodeMultimodalInput(input) : extractTextFromBlocks(input);
    } else {
      loopInput = input;
    }

    // No strategy (or react() default) → byte-identical path to the previous implementation.
    if (!this.config.strategy) {
      yield* this.runReact(loopInput, opts);
      return;
    }

    // Strategy path: build the StrategyContext and delegate.
    const boundReact = (
      reactInput: string,
      reactOpts: QueryOptions,
      runtime?: { model?: ModelPort },
    ): AsyncIterable<StreamEvent> => this.runReact(reactInput, reactOpts, runtime);

    // FIX 2: pass the internal opts (including _budget/_depth) into the StrategyContext
    // so strategies can thread the shared budget through all their sub-runs.
    const internalOpts = opts as InternalQueryOptions;

    const ctx: StrategyContext = {
      input: loopInput,
      opts,
      model: this.config.model,
      _internalOpts: internalOpts,
      react: boundReact,
    };

    yield* this.config.strategy.run(ctx);
  }

  /**
   * Continue an interrupted/suspended durable run (§9.7 / §5.7) from the persisted event log.
   * Requires `durable: true`. When `opts.decision` is provided, the run is resuming from a
   * human-in-the-loop suspension: the decision is recorded (keyed by the pending suspension's
   * callId) BEFORE replay, so the re-dispatched tool's `ctx.suspend` returns it (§9.4).
   *
   * **Ownership check**: when the caller passes any identity field (`userId`, `orgId`, or
   * `apiKey`) AND the session record has a recorded owner (set at `query()` time by Fix 1),
   * the two identities must match on all provided fields or `resume` throws `"session ownership
   * mismatch"`. When neither the caller nor the session has a recorded identity the check is
   * skipped (back-compat — legacy / NoAuth sessions continue to work). This prevents a caller
   * who guesses a `sessionId` from resuming a session that belongs to a different principal.
   *
   * Structured output: pass `outputSchema` (a Zod schema, same convention as `query`) to constrain
   * the resumed run's FINAL (tool-less) turn to emit a matching object, surfaced as `result.object`
   * on the terminal event. If the session has already terminated (the fast-path replay), the stored
   * final text is validated against the schema and the parsed object is attached. Backward-compatible:
   * when omitted, `resume()` behaves byte-identically to before.
   */
  async *resume(sessionId: string, opts?: { userId?: string; orgId?: string; apiKey?: string; decision?: SuspendDecision; signal?: AbortSignal; outputSchema?: z.ZodType }): AsyncIterable<StreamEvent> {
    await this.ensureReady(opts?.userId);
    const durable = this.resolveDurable();
    if (!durable) throw new Error("Agent.resume requires `durable: true` and a DurablePort store.");

    // Ownership check: when any identity is provided, verify it matches the session's recorded owner.
    const callerIdentity = opts?.userId !== undefined || opts?.orgId !== undefined || opts?.apiKey !== undefined;
    if (callerIdentity) {
      const rec = await this.config.store.getSession(sessionId);
      if (rec !== null) {
        const sessionHasOwner = rec.userId !== undefined || rec.orgId !== undefined || rec.apiKey !== undefined;
        if (sessionHasOwner) {
          const userMatch = opts?.userId === undefined || opts.userId === rec.userId;
          const orgMatch = opts?.orgId === undefined || opts.orgId === rec.orgId;
          const apiKeyMatch = opts?.apiKey === undefined || opts.apiKey === rec.apiKey;
          if (!userMatch || !orgMatch || !apiKeyMatch) {
            throw new Error(
              `Agent.resume: session ownership mismatch for session "${sessionId}". ` +
              `The caller identity does not match the session's recorded owner.`,
            );
          }
        }
      }
    }

    // §5.7/§9.4: if a decision was supplied, record it against the pending suspension's callId BEFORE
    // continuing, so the re-dispatched suspended tool sees the decision via ctx.suspend.
    if (opts?.decision) {
      const now = this.config.now ?? defaultNow;
      const newId = this.config.newId ?? this.defaultNewId;
      const suspSession = await Session.open(this.config.store, {
        sessionId,
        agentId: this.config.id,
        now,
        newId,
        ...(this.config.upcasters ? { upcasters: this.config.upcasters } : {}),
      });
      const pending = [...suspSession.events()].reverse().find((e) => e.kind === "suspension");
      if (!pending) throw new Error("Agent.resume: a decision was provided but the session has no pending suspension.");
      const { callId } = pending.payload as { callId: string };
      await durable.recordDecision(sessionId, callId, opts.decision);
    }

    const now = this.config.now ?? defaultNow;
    const newId = this.config.newId ?? this.defaultNewId;
    const scope: Scope = opts?.userId
      ? { kind: "user", agentId: this.config.id, userId: opts.userId }
      : { kind: "agent", agentId: this.config.id };

    const resumeLazyTools = this.resolveLazyTools();
    // resume() does not add a spawnTool (resume is always the plain react path).
    const { tools, execSkillRegRef: resumeExecSkillRegRef, discoveryRegRef: resumeDiscoveryRegRef } =
      this.buildToolsForRun(scope, undefined, resumeLazyTools ?? undefined);

    const resumeLogger2 = this.config.logger ?? envLogger();
    const registry = this.buildRegistry(tools, durable, scope, undefined, sessionId, resumeLogger2);
    resumeExecSkillRegRef.registry = registry;
    resumeDiscoveryRegRef.registry = registry;

    const session = await Session.open(this.config.store, {
      sessionId,
      agentId: this.config.id,
      now,
      newId,
      ...(this.config.upcasters ? { upcasters: this.config.upcasters } : {}),
      // Fix 1: record owner identity on resume (only affects new sessions; existing sessions already have their owner).
      ...(opts?.userId !== undefined ? { userId: opts.userId } : {}),
      ...(opts?.orgId !== undefined ? { orgId: opts.orgId } : {}),
    });

    yield* resumeTurn({
      agentId: this.config.id,
      instructions: this.config.instructions,
      input: "",
      model: this.config.model,
      registry,
      session,
      scope,
      store: this.config.store,
      maxTurns: this.config.maxTurns ?? 16,
      memory: this.config.memory,
      logger: resumeLogger2,
      durable,
      ...(this.config.skills && hasSkills(this.config.skills) ? { skillCatalog: this.config.skills.catalog() } : {}),
      ...(this.config.policy ? { policy: this.config.policy } : {}),
      ...(this.config.prices ? { prices: this.config.prices } : {}),
      ...((this.config.modelId ?? this.config.model.modelId) ? { modelId: this.config.modelId ?? this.config.model.modelId } : {}),
      ...(this.config.tracer ? { tracer: this.config.tracer } : {}),
      ...(this.config.onCostThreshold ? { onCostThreshold: this.config.onCostThreshold } : {}),
      ...(this.config.monotonicNow ? { monotonicNow: this.config.monotonicNow } : {}),
      ...(this.config.compaction ? { compaction: this.config.compaction } : {}),
      ...(this.config.onPreCompact ? { onPreCompact: this.config.onPreCompact } : {}),
      ...(resumeLazyTools ? { lazyTools: resumeLazyTools } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(this.config.instructionsVersion !== undefined ? { instructionsVersion: this.config.instructionsVersion } : {}),
      ...(this.config.promptCache ? { promptCache: true } : {}),
      ...(opts?.outputSchema ? { outputSchema: buildStructuredOutput(opts.outputSchema) } : {}),
      ...(this.config.modelRetry ? { modelRetry: this.config.modelRetry } : {}),
      ...(this.config.modelFallback && this.config.modelFallback.length > 0 ? { modelFallback: this.config.modelFallback } : {}),
      ...(this.config.structuredOutputRetry !== undefined ? { structuredOutputRetry: this.config.structuredOutputRetry } : {}),
      ...(this.config.onTurnStart ? { onTurnStart: this.config.onTurnStart } : {}),
    });
  }

  /**
   * GDPR right-to-erasure fan-out (§15): hard-delete ALL data for `scope` across every
   * subsystem the agent owns — store (sessions/events/blocks/facts/memories), vector store,
   * and graph. Returns a structured summary of deleted row counts per subsystem so callers
   * can audit what was removed.
   *
   * **Semantics — best-effort fan-out, NOT transactional/atomic:**
   * When `memory` is configured and its adapter implements `eraseScope`, deletion is delegated
   * to `Memory.eraseScope`, which attempts all three subsystems (store / vector / graph) with a
   * per-subsystem try/catch. Each subsystem is always attempted even on partial failure; the
   * in-memory maps are cleared regardless. If any subsystem throws, an aggregate error is
   * re-thrown so callers know that partial failure occurred (it is NOT silently swallowed).
   * Because this is a best-effort fan-out — NOT a distributed transaction — a partial failure
   * leaves some subsystems erased and others not. **Re-running `eraseScope` on the same scope
   * is safe (idempotent) and will erase whatever remains.**
   *
   * **Design:**
   * - When `memory` is configured and implements `eraseScope`, this delegates entirely to it
   *   (Memory fans out to store + vector + graph internally). The store erase is covered by
   *   Memory.eraseScope, so there is NO double-deletion.
   * - When `memory` is absent or does not implement `eraseScope` (older adapters), the store
   *   is erased directly and the other subsystems (vector/graph) are skipped gracefully.
   *   `result.memorySkipped` will be `true` in that case.
   *
   * **Security:** scope filtering is exact. Erasing `{ kind:"user", agentId:"a", userId:"u1" }`
   * only removes data keyed to that exact scope — user `u2`'s data is untouched. Never
   * erases across tenant boundaries.
   *
   * **Idempotent:** erasing an already-erased scope returns `{ deleted: 0 }` from each
   * subsystem (a no-op success). Safe to call multiple times.
   *
   * @param scope - The scope to erase. Construct via: `{ kind:"user", agentId: agent.config.id, userId }`.
   * @throws An aggregate error when `memory.eraseScope` is present and one or more subsystems fail.
   *         Partial erasure may have occurred — re-run to retry the remaining subsystems.
   */
  async eraseScope(scope: Scope): Promise<EraseScopeResult> {
    // Ensure migrations ran (same lazy guard as query/resume).
    this._migrated ??= Promise.resolve(this.config.store.migrate());
    await this._migrated;

    const mem = this.config.memory;
    // Structural check: does the memory adapter expose eraseScope?
    // Cast through `unknown` first so TypeScript does not complain that MemoryPort and
    // ErasableMemory have no overlapping fields — this is an intentional structural duck-type.
    const candidate = mem as unknown as Partial<ErasableMemory> | undefined;
    const erasableMemory = candidate && typeof candidate.eraseScope === "function"
      ? (candidate as ErasableMemory)
      : undefined;

    if (erasableMemory) {
      // Memory.eraseScope fans out to store + vector + graph internally.
      const { store, vector, graph } = await erasableMemory.eraseScope(scope);
      return { store, vector, graph, memorySkipped: false };
    }

    // No erasable memory — erase the store directly; vector/graph unavailable without memory.
    const { deleted: store } = await this.config.store.eraseScope(scope);
    return { store, vector: 0, graph: 0, memorySkipped: true };
  }
}

/**
 * Result of `Agent.eraseScope`: row counts deleted per subsystem.
 * - `store`  — rows deleted from the store (sessions, events, blocks, block_history, memories/FTS, facts).
 * - `vector` — vector entries deleted (0 when no vector store configured).
 * - `graph`  — graph fact rows deleted (0 when graph and store share storage, or graph absent).
 * - `memorySkipped` — true when the memory adapter was absent or did not implement `eraseScope`;
 *   in that case only the store was erased and vector/graph were skipped.
 */
export interface EraseScopeResult {
  store: number;
  vector: number;
  graph: number;
  memorySkipped: boolean;
}

/** Structural interface for a MemoryPort that also exposes eraseScope (the Memory class satisfies this). */
interface ErasableMemory {
  eraseScope(scope: Scope): Promise<{ store: number; vector: number; graph: number }>;
}
