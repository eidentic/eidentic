import { z } from "zod";
import { sha256Hex } from "./sha256.js";
import type { AuditSink, DurablePort, LoggerPort, PermissionDecision, PermissionPolicy, Scope, SecretAccessContext, SecretCapability, SecretsPort, SuspendDecision, SuspendRequest, ToolSchema } from "@eidentic/types";
import { canonicalJson, scopeKey } from "@eidentic/types";
import { evaluatePermission, argScopedDenies, filterToolsForSchema } from "./permission.js";
import { NoopLogger, envLogger } from "./logger.js";
import { sanitizeBoundaryText, sanitizeBoundaryValue } from "./boundary.js";

async function stableArgsHash(input: unknown): Promise<string> {
  return sha256Hex(canonicalJson(input));
}

/** Versioned, injective durable-ledger key for the `(sessionId, toolKey)` tuple. */
export function idempotencyLedgerKey(sessionId: string | undefined, toolKey: string): string {
  return `eidentic.idem.v2:${JSON.stringify([sessionId ?? null, toolKey])}`;
}

export type SideEffect = "read-only" | "idempotent" | "destructive";

/**
 * Internal control-flow signal (§5.7): thrown by `ctx.suspend` on the FIRST run to pause the loop
 * for a human decision. It is NOT a tool error — `execOne`/`runOne`/`dispatch` re-throw it so the
 * loop can handle it (append a `suspension` event + yield a terminal `suspended` result). Carries the
 * approval `request` and the stable `callId` (the suspension key across the original run + resume).
 */
export class SuspendSignal extends Error {
  readonly request: SuspendRequest;
  readonly callId: string;
  constructor(request: SuspendRequest, callId: string) {
    super(`tool suspended for human approval: ${request.reason}`);
    this.name = "SuspendSignal";
    this.request = request;
    this.callId = callId;
  }
}

/** Runtime context injected into every tool call (§10.3). ctx is optional so existing tools remain compatible. */
export interface ToolContext {
  /**
   * The scope for the current run, identifying the tenant boundary (user/agent/org/shared).
   * **Populated by the registry when a tool is invoked within a scoped run** (i.e. a run
   * started via `Agent.query()` or `Agent.resume()`). `undefined` when the tool is invoked
   * outside of a scoped run — for example, in unit tests that call `tool.execute()` directly,
   * or when using a bare `ToolRegistry` without a scope configured.
   *
   * Custom tool authors should guard against `undefined` before using this field:
   * ```ts
   * execute: async ({ ctx }) => {
   *   if (!ctx?.scope) throw new Error("scope required");
   *   // use ctx.scope ...
   * }
   * ```
   * Attempting to use `ctx.scope` unconditionally in tools invoked outside a scoped run
   * will produce cryptic `TypeError: Cannot read properties of undefined` errors at dispatch time.
   */
  scope?: Scope;
  secrets?: SecretCapability;
  signal?: AbortSignal;
  /**
   * Human-in-the-loop suspension (§5.7). On the FIRST run this throws a `SuspendSignal` to pause the
   * run durably; on resume (after `Agent.resume(..., { decision })`) it RETURNS the recorded decision
   * so the tool continues. Present ONLY when the run is durable; calling it on a non-durable run throws.
   */
  suspend?: (request: SuspendRequest) => Promise<SuspendDecision>;
}

export interface ToolDef<I = unknown, O = unknown> {
  id: string;
  description: string;
  inputSchema: z.ZodType<I>;
  sideEffect?: SideEffect;
  /** Secret refs this tool may read from `ctx.secrets`. Omitted/empty means no secret access. */
  requiredSecrets?: readonly string[];
  /**
   * Stable key for exactly-once dispatch (§9.3). Computed from input; required-in-practice for
   * destructive tools under durable runs.
   *
   * **Keys must vary with meaningful input.** A key that is constant (e.g. always `"my-tool"`)
   * causes every call after the first to be silently skipped — the ledger sees `status:"applied"`
   * and returns the original result without executing the tool again. The `argsHash` guard catches
   * the case where the same key is used with different input values: it returns an error rather
   * than returning stale data, but the silent-skip risk for truly constant input is real. Use a
   * key derived from the inputs that uniquely identify the intended side effect.
   *
   * **Side-effect window warning**: an unresolved intent is never re-executed automatically. If a
   * process crashes after the external side effect but before `recordCompletion`, later calls fail
   * closed as pending. Pass this key to the external provider and reconcile the intent explicitly
   * before retrying when end-to-end exactly-once behavior is required.
   */
  idempotencyKey?: (input: I) => string | Promise<string>;
  execute: (args: { input: I; ctx?: ToolContext }) => Promise<O>;
}

export interface Tool {
  id: string;
  description: string;
  sideEffect: SideEffect;
  /** Immutable least-privilege secret capability set. Never included in the model tool schema. */
  requiredSecrets: readonly string[];
  jsonSchema: Record<string, unknown>;
  idempotencyKey?: (input: unknown) => string | Promise<string>;
  parse: (input: unknown) => { ok: true; value: unknown } | { ok: false; error: string };
  execute: (input: unknown, ctx?: ToolContext) => Promise<unknown>;
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
  /** Durable-path and permission annotations (absent on the fast path). */
  meta?: { durableSkipped?: boolean; durablePending?: boolean; durableUnprotected?: boolean; collision?: boolean; permissionDenied?: boolean };
}

export function createTool<I, O>(def: ToolDef<I, O>): Tool {
  const requiredSecrets = [...(def.requiredSecrets ?? [])];
  const seenSecretRefs = new Set<string>();
  for (const ref of requiredSecrets) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new Error(`invalid secret ref '${ref}'`);
    if (seenSecretRefs.has(ref)) throw new Error(`duplicate secret ref '${ref}'`);
    seenSecretRefs.add(ref);
  }
  Object.freeze(requiredSecrets);
  return {
    id: def.id,
    description: def.description,
    sideEffect: def.sideEffect ?? "read-only",
    requiredSecrets,
    jsonSchema: z.toJSONSchema(def.inputSchema) as Record<string, unknown>,
    ...(def.idempotencyKey ? { idempotencyKey: (input: unknown) => def.idempotencyKey!(input as I) } : {}),
    parse: (input) => {
      const r = def.inputSchema.safeParse(input);
      return r.success
        ? { ok: true, value: r.data }
        : { ok: false, error: `invalid input: ${sanitizeBoundaryText(r.error.message, 1_000)}` };
    },
    execute: (input, ctx) => def.execute({ input: input as I, ctx }),
  };
}

export interface RegistryOpts {
  /** Owning agent id, used only as immutable secret-access metadata. */
  agentId?: string;
  durable?: DurablePort;
  permissions?: PermissionPolicy;
  secrets?: SecretsPort;
  onPreToolUse?: (toolId: string, input: unknown) => PermissionDecision | void | Promise<PermissionDecision | void>;
  onPermissionRequest?: (toolId: string, input: unknown) => PermissionDecision | Promise<PermissionDecision>;
  /**
   * Post-tool-use hook: invoked after every tool dispatch (success AND error). Awaited so callers can
   * perform async side effects (logging, metrics, audit) in the dispatch critical path.
   *
   * A THROWING hook is swallowed — the error is logged at "warn" level and the run continues normally.
   * This ensures that observability hooks can never kill a production run.
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
  scope?: Scope;
  /**
   * Best-effort audit sink (§10.4/§15). Emits `permission.denied` for every denied dispatch and
   * `tool.call` for every executed dispatch. A throwing sink is swallowed + logged, like the post-hook.
   */
  onAuditEvent?: AuditSink;
  /** AbortSignal passed into every tool's ToolContext.signal for this registry's lifetime. */
  signal?: AbortSignal;
  /** The session id for this run — threaded into `ctx.suspend` so suspension keys are (sessionId, callId)-stable. */
  sessionId?: string;
  /** Structured logger for tool dispatch + permission decision logging. */
  logger?: LoggerPort;
  /** Dynamic prompt-skill capability set for this run; null means no skill is active. */
  activeSkillAllowedTools?: () => readonly string[] | null;
}

export class ToolRegistry {
  private byName = new Map<string, Tool>();
  private readonly durable?: DurablePort;
  private readonly permissions?: PermissionPolicy;
  private readonly secrets?: SecretsPort;
  private readonly onPreToolUse?: RegistryOpts["onPreToolUse"];
  private readonly onPermissionRequest?: RegistryOpts["onPermissionRequest"];
  private readonly onPostToolUse?: RegistryOpts["onPostToolUse"];
  private readonly onAuditEvent?: AuditSink;
  private readonly scope?: Scope;
  private readonly signal?: AbortSignal;
  private readonly sessionId?: string;
  private readonly agentId?: string;
  private readonly logger: LoggerPort;
  private readonly activeSkillAllowedTools?: () => readonly string[] | null;

  constructor(tools: Tool[], opts?: RegistryOpts) {
    for (const t of tools) this.byName.set(t.id, t);
    this.durable = opts?.durable;
    this.permissions = opts?.permissions;
    this.secrets = opts?.secrets;
    this.onPreToolUse = opts?.onPreToolUse;
    this.onPermissionRequest = opts?.onPermissionRequest;
    this.onPostToolUse = opts?.onPostToolUse;
    this.onAuditEvent = opts?.onAuditEvent;
    this.scope = opts?.scope;
    this.signal = opts?.signal;
    this.sessionId = opts?.sessionId;
    this.agentId = opts?.agentId;
    this.activeSkillAllowedTools = opts?.activeSkillAllowedTools;
    // Default to envLogger so warn/error always surface (e.g. "destructive tool without idempotencyKey").
    // When a logger is explicitly injected (via Agent.buildRegistry), it takes precedence.
    this.logger = opts?.logger ?? envLogger();
  }

  schemas(): ToolSchema[] {
    // Apply schema-layer permission filtering here so that bare-name deny entries remove tools
    // even when permissions were provided on the registry directly (not pre-filtered externally).
    const visible = this.permissions
      ? filterToolsForSchema([...this.byName.values()], this.permissions)
      : [...this.byName.values()];
    const skillVisible = visible.filter((tool) => this.skillAllows(tool.id));
    return skillVisible.map((t) => ({
      name: t.id,
      description: t.description,
      inputSchema: t.jsonSchema,
    }));
  }

  /** Read-only calls run concurrently; mutating calls run serially. Order preserved. */
  async dispatch(calls: ToolCall[]): Promise<ToolResult[]> {
    if (calls.some((call) => call.name === "skill_use")) {
      const sequential: ToolResult[] = [];
      for (const call of calls) sequential.push(await this.runOne(call));
      return sequential;
    }
    const results: ToolResult[] = new Array(calls.length);
    const mutating: number[] = [];
    const readonly: number[] = [];
    calls.forEach((c, i) => {
      const t = this.byName.get(c.name);
      (t && t.sideEffect === "read-only" ? readonly : mutating).push(i);
    });
    await Promise.all(readonly.map((i) => this.runOne(calls[i]!).then((r) => void (results[i] = r))));
    for (const i of mutating) results[i] = await this.runOne(calls[i]!);
    return results;
  }

  private async resolvePermission(tool: Tool, input: unknown): Promise<"allow" | "deny"> {
    // Step 1: policy evaluation. Static and argument-scoped denies are absolute: a hook may
    // impose an additional denial or approve an "ask", but can never bypass a deny rule.
    const dec = evaluatePermission(this.permissions, tool);

    // Step 1b: arg-scoped deny patterns — evaluated after bare-name deny check, BEFORE hooks.
    // These fire even under mode:"bypass" (§10.4: deny beats mode over modes, not over pre-hooks).
    // Only fires when no bare-name deny already denied (dec !== "deny"), because bare denies
    // are already terminal; arg-scoped denies are a separate conditional guard.
    if (dec !== "deny" && this.permissions) {
      const serialized = JSON.stringify(input) ?? "undefined";
      if (argScopedDenies(this.permissions, tool.id, serialized)) {
        this.logger.log("debug", "eidentic:permission", "decision", { tool: tool.id, decision: "deny", reason: "arg-scoped-deny" });
        return "deny";
      }
    }

    if (dec === "deny") {
      this.logger.log("debug", "eidentic:permission", "decision", { tool: tool.id, decision: "deny", reason: "policy" });
      return "deny";
    }

    // Step 2: pre-tool hook can further restrict, or explicitly approve an ask/default decision.
    if (this.onPreToolUse) {
      const pre = await this.onPreToolUse(tool.id, input);
      if (pre === "deny") {
        this.logger.log("debug", "eidentic:permission", "decision", { tool: tool.id, decision: "deny", reason: "onPreToolUse" });
        return "deny";
      }
      if (pre === "allow") {
        this.logger.log("debug", "eidentic:permission", "decision", { tool: tool.id, decision: "allow", reason: "onPreToolUse" });
        return "allow";
      }
    }

    // Step 3: "ask" → resolve dynamically.
    if (dec === "ask") {
      if (!this.onPermissionRequest) {
        this.logger.log("debug", "eidentic:permission", "decision", { tool: tool.id, decision: "deny", reason: "ask-no-resolver" });
        return "deny"; // safe default: no resolver → deny
      }
      const resolved = await this.onPermissionRequest(tool.id, input);
      const finalDec = resolved === "allow" ? "allow" : "deny";
      this.logger.log("debug", "eidentic:permission", "decision", { tool: tool.id, decision: finalDec, reason: "ask-resolved" });
      return finalDec;
    }

    this.logger.log("debug", "eidentic:permission", "decision", { tool: tool.id, decision: "allow", reason: "policy" });
    return "allow";
  }

  private async runOne(call: ToolCall): Promise<ToolResult> {
    const tool = this.byName.get(call.name);
    if (!tool) {
      const valid = [...this.byName.keys()].join(", ");
      return { callId: call.callId, toolName: call.name, isError: true, output: { error: `unknown tool '${call.name}'. valid tools: ${valid}` } };
    }
    if (!this.skillAllows(call.name)) {
      this.emitDenied(call.name, "denied");
      return {
        callId: call.callId,
        toolName: call.name,
        isError: true,
        output: { error: `active skill does not allow tool: ${call.name}` },
        meta: { permissionDenied: true },
      };
    }
    const parsed = tool.parse(call.input);
    if (!parsed.ok) {
      return { callId: call.callId, toolName: call.name, isError: true, output: { error: parsed.error } };
    }
    const dispatchStart = Date.now();

    this.logger.log("debug", "eidentic:tool", "dispatch", { tool: call.name, sideEffect: tool.sideEffect });

    // Permission gate (§10.4): only when policy or hooks are configured.
    // Defense-in-depth: if the gate itself throws, treat as deny (fail-closed).
    const hasGate = this.permissions !== undefined || this.onPreToolUse !== undefined;
    if (hasGate) {
      let decision: "allow" | "deny";
      try {
        decision = await this.resolvePermission(tool, parsed.value);
      } catch (gateErr) {
        const raw = sanitizeBoundaryText(gateErr instanceof Error ? gateErr.message : String(gateErr), 500);
        this.logger.log("debug", "eidentic:tool", "result", { tool: call.name, ok: false, reason: "permission-gate-error", error: raw });
        this.emitDenied(tool.id, "gate-error");
        return {
          callId: call.callId,
          toolName: call.name,
          isError: true,
          output: { error: "permission gate error (denied)" },
          meta: { permissionDenied: true },
        };
      }
      if (decision === "deny") {
        this.logger.log("debug", "eidentic:tool", "result", { tool: call.name, ok: false, reason: "permission-denied" });
        this.emitDenied(tool.id, "denied");
        return {
          callId: call.callId,
          toolName: call.name,
          isError: true,
          output: { error: `permission denied: ${call.name}` },
          meta: { permissionDenied: true },
        };
      }
    }

    // Build ctx for this invocation, including a callId-bound suspend (§5.7).
    const durable = this.durable;
    const sessionId = this.sessionId;
    const callId = call.callId;
    const scopedSecrets = this.secretCapabilitiesFor(tool);
    const ctx: ToolContext = {
      ...(this.scope !== undefined ? { scope: this.scope } : {}),
      ...(scopedSecrets !== undefined ? { secrets: scopedSecrets } : {}),
      ...(this.signal !== undefined ? { signal: this.signal } : {}),
      suspend: async (request: SuspendRequest): Promise<SuspendDecision> => {
        if (!durable || sessionId === undefined) {
          throw new Error("ctx.suspend requires durable execution (set `durable: true` and use a DurablePort store)");
        }
        const prior = await durable.getDecision(sessionId, callId);
        if (prior) return prior; // resume case: continue with the recorded decision
        throw new SuspendSignal(request, callId); // first run: pause the loop
      },
    };

    // Durable idempotency: only when a durable port is configured AND the tool is side-effecting.
    // Read-only tools never touch the ledger (§9.3: read-only is always safe to re-run).
    const sideEffecting = tool.sideEffect !== "read-only";
    if (this.durable && sideEffecting) {
      if (tool.idempotencyKey) {
        let toolKey: string;
        try {
          toolKey = await tool.idempotencyKey(parsed.value);
        } catch (e) {
          const raw = sanitizeBoundaryText(e instanceof Error ? e.message : String(e), 500);
          return { callId: call.callId, toolName: call.name, isError: true, output: { error: `idempotencyKey threw: ${raw}` } };
        }
        const key = idempotencyLedgerKey(this.sessionId, toolKey);
        const argsHash = await stableArgsHash(parsed.value);
        const idempotencyMetadata = this.sessionId !== undefined ? { sessionId: this.sessionId } : undefined;
        let rec = await this.durable.getIdempotency(key, idempotencyMetadata);
        if (rec == null && this.sessionId !== undefined) {
          // Read the immediately previous format only when ownership metadata proves the exact
          // session. Bare pre-session keys are ambiguous and intentionally fail closed.
          const legacyRec = await this.durable.getIdempotency(
            `${this.sessionId}:${toolKey}`,
            idempotencyMetadata,
          );
          if (legacyRec?.status === "applied" && legacyRec.sessionId === this.sessionId) rec = legacyRec;
        }

        const existingResult = async (existing: NonNullable<typeof rec>): Promise<ToolResult> => {
          if (existing.argsHash !== argsHash) {
            return {
              callId: call.callId,
              toolName: call.name,
              isError: true,
              output: { error: "idempotency key collision: the key was claimed with different arguments" },
              meta: { durableSkipped: true, collision: true },
            };
          }
          if (existing.status === "intent") {
            return {
              callId: call.callId,
              toolName: call.name,
              isError: true,
              output: { error: "idempotency operation is already in progress or requires reconciliation" },
              meta: { durableSkipped: true, durablePending: true },
            };
          }
          this.logger.log("debug", "eidentic:tool", "result", { tool: call.name, ok: true, durableSkipped: true });
          const skipped: ToolResult = {
            callId: call.callId,
            toolName: call.name,
            isError: false,
            output: sanitizeBoundaryValue(existing.result),
            meta: { durableSkipped: true },
          };
          await this.firePostHook(tool.id, parsed.value, skipped, dispatchStart);
          return skipped;
        };

        if (rec) return existingResult(rec);

        const claimed = await this.durable.claimIntent(key, argsHash, idempotencyMetadata);
        if (!claimed) {
          const winner = await this.durable.getIdempotency(key, idempotencyMetadata);
          if (!winner) {
            return {
              callId: call.callId,
              toolName: call.name,
              isError: true,
              output: { error: "idempotency claim was lost; execution denied" },
              meta: { durableSkipped: true, durablePending: true },
            };
          }
          return existingResult(winner);
        }

        try {
          const r = await this.execOne(call, tool, parsed.value, ctx);
          if (!r.isError) await this.durable.recordCompletion(key, r.output, idempotencyMetadata);
          this.logger.log("debug", "eidentic:tool", "result", { tool: call.name, ok: !r.isError });
          await this.firePostHook(tool.id, parsed.value, r, dispatchStart);
          return r;
        } catch (error) {
          if (error instanceof SuspendSignal) {
            const released = await this.durable.releaseIntent(key, argsHash, idempotencyMetadata);
            if (!released) throw new Error("failed to release suspended idempotency claim", { cause: error });
          }
          throw error;
        }
      }
      // Destructive/idempotent tool WITHOUT a key under durable: dispatch normally but mark unprotected (v1 policy).
      if (tool.sideEffect === "destructive") {
        this.logger.log("warn", "eidentic:tool", `destructive tool '${tool.id}' ran under durable execution without an idempotencyKey — exactly-once is NOT guaranteed for it`);
        const r = await this.execOne(call, tool, parsed.value, ctx);
        this.logger.log("debug", "eidentic:tool", "result", { tool: call.name, ok: !r.isError, durableUnprotected: true });
        const wrapped = { ...r, meta: { ...r.meta, durableUnprotected: true } };
        await this.firePostHook(tool.id, parsed.value, wrapped, dispatchStart);
        return wrapped;
      }
    }

    const result = await this.execOne(call, tool, parsed.value, ctx);
    this.logger.log("debug", "eidentic:tool", "result", { tool: call.name, ok: !result.isError });
    await this.firePostHook(tool.id, parsed.value, result, dispatchStart);
    return result;
  }

  private skillAllows(toolId: string): boolean {
    const allowed = this.activeSkillAllowedTools?.();
    if (allowed === null || allowed === undefined) return true;
    if (toolId === "skill_search" || toolId === "skill_use" || toolId === "skill_read") return true;
    return allowed.includes("*") || allowed.includes(toolId);
  }

  /** Expose only refs declared by this tool; never pass the ambient vault object through. */
  private secretCapabilitiesFor(tool: Tool): SecretCapability | undefined {
    if (!this.secrets || tool.requiredSecrets.length === 0) return undefined;
    const source = this.secrets;
    const allowed = new Set(tool.requiredSecrets);
    const immutableScope = this.scope === undefined ? undefined : Object.freeze({ ...this.scope }) as Scope;
    const context: SecretAccessContext = Object.freeze({
      ...(this.agentId !== undefined ? { agentId: this.agentId } : {}),
      toolId: tool.id,
      ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
      ...(immutableScope !== undefined ? { scope: immutableScope } : {}),
    });
    const get = async (ref: string): Promise<string | undefined> => {
        if (!allowed.has(ref)) {
          this.logger.log("warn", "eidentic:secrets", "access denied", { tool: tool.id, ref });
          throw new Error(`secret capability denied: tool '${tool.id}' did not declare '${ref}'`);
        }
        const value = await source.get(ref, context);
        this.logger.log("debug", "eidentic:secrets", "access", { tool: tool.id, ref, found: value !== undefined });
        return value;
    };
    return {
      get,
      require: async (ref: string): Promise<string> => {
        const value = await get(ref);
        if (value === undefined || value === "") {
          throw new Error(`required secret '${ref}' is not configured`);
        }
        return value;
      },
    };
  }

  /**
   * Invoke `onPostToolUse` if configured. Swallows and logs any error so a throwing hook never
   * kills the run (observability hooks must not affect control flow).
   */
  private async firePostHook(toolId: string, input: unknown, result: ToolResult, startMs: number): Promise<void> {
    const durationMs = Date.now() - startMs;
    if (this.onPostToolUse) {
      try {
        await this.onPostToolUse({
          toolId,
          input,
          output: result.output,
          isError: result.isError,
          durationMs,
          sessionId: this.sessionId ?? "",
        });
      } catch (err) {
        this.logger.log("warn", "eidentic:tool", `onPostToolUse hook threw (swallowed): ${sanitizeBoundaryText(err instanceof Error ? err.message : String(err), 500)}`);
      }
    }
    // Audit: one `tool.call` per executed dispatch (success, error, or durable-skip). Denials are
    // emitted separately at the gate, since they never reach execution.
    this.emitAudit({
      type: "tool.call",
      at: Date.now(),
      toolId,
      sessionId: this.sessionId ?? "",
      ...(this.scope !== undefined ? { scopeKey: scopeKey(this.scope) } : {}),
      isError: result.isError,
      durationMs,
    });
  }

  /** Emit a `permission.denied` audit event for a tool that the gate refused. */
  private emitDenied(toolId: string, reason: "denied" | "gate-error"): void {
    this.emitAudit({
      type: "permission.denied",
      at: Date.now(),
      toolId,
      sessionId: this.sessionId ?? "",
      ...(this.scope !== undefined ? { scopeKey: scopeKey(this.scope) } : {}),
      reason,
    });
  }

  /** Emit an audit event through the configured sink. Best-effort: a throwing sink is swallowed + logged. */
  private emitAudit(event: import("@eidentic/types").AuditEvent): void {
    if (!this.onAuditEvent) return;
    try {
      this.onAuditEvent(event);
    } catch (err) {
      this.logger.log("warn", "eidentic:tool", `onAuditEvent sink threw (swallowed): ${sanitizeBoundaryText(err instanceof Error ? err.message : String(err), 500)}`);
    }
  }

  private async execOne(call: ToolCall, tool: Tool, value: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const output = sanitizeBoundaryValue(await tool.execute(value, ctx));
      return { callId: call.callId, toolName: call.name, isError: false, output };
    } catch (e) {
      if (e instanceof SuspendSignal) throw e; // §5.7: NOT a tool error — propagate to the loop.
      const error = sanitizeBoundaryText(e instanceof Error ? e.message : String(e), 500);
      return { callId: call.callId, toolName: call.name, isError: true, output: { error } };
    }
  }
}
