import type { Scope } from "./ports.js";

/**
 * Controls how the permission system evaluates tool access for a session.
 *
 * - `"default"` — allow unless denied by a `deny` glob. Equivalent to allow-unless-denied.
 * - `"plan"` — read-only tools only; all non-`"read-only"` side-effect tools are denied at both
 *   schema and dispatch layers (the model never sees them and cannot call them).
 * - `"ask"` — every tool that is not pre-approved by an `allow` glob requires dynamic resolution
 *   via `onPermissionRequest` at dispatch time. Without a resolver, unlisted tools are denied.
 * - `"bypass"` — skips the plan-mode and ask-mode checks; deny globs and `onPreToolUse` still apply.
 * - `"acceptEdits"` — **currently behaves identically to `"default"` (allow-unless-denied)**;
 *   reserved for future finer-grained edit-class gating (e.g. distinguishing file writes from
 *   code execution). Do NOT rely on `acceptEdits` providing any additional protection beyond what
 *   `deny` globs and `onPreToolUse` already give you — that gating is planned but not yet
 *   implemented.
 */
export type PermissionMode = "default" | "plan" | "acceptEdits" | "ask" | "bypass";
export type PermissionDecision = "allow" | "deny" | "ask";

/** Deny-by-default-capable permission policy (design §10.4). Tool ids matched by glob (`*` wildcard). */
export interface PermissionPolicy {
  mode?: PermissionMode;   // default "default"
  allow?: string[];        // tool-id globs pre-approved
  ask?: string[];          // tool-id globs that require dynamic approval
  deny?: string[];         // tool-id globs denied (bare-name deny ⇒ removed from schema)
  /** Fall-through decision when no allow/ask/deny/mode rule matches. Defaults to "allow" for back-compat. */
  default?: PermissionDecision;
}

/** Credential vault: the model never sees secrets; tools fetch them at call time (§10.3). */
export interface SecretsPort {
  get(ref: string): Promise<string | undefined>;
}

/** Result of running code in a `SandboxPort`. `exitCode` 0 = success; non-zero = failure. */
export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Set when execution itself errored (e.g. a thrown exception inside the sandbox). */
  error?: string;
}

/** Options for a single sandboxed run. */
export interface SandboxRunOptions {
  /** Language of `code`. Adapters map this to their runtime; default is implementation-defined. */
  language?: "javascript" | "python" | "bash";
  /** Wall-clock budget for the run, in milliseconds. */
  timeoutMs?: number;
  /** Extra environment variables exposed to the sandboxed process. */
  env?: Record<string, string>;
  /**
   * Optional abort signal. When the signal fires, adapters SHOULD abort the in-flight execution
   * (e.g. kill the sandbox) and throw a `DOMException("sandbox run aborted", "AbortError")`.
   * Adapters that do not support cancellation may ignore this field — callers should not rely on
   * strict cancellation guarantees from every adapter.
   */
  signal?: AbortSignal;
}

/**
 * Runs untrusted / agent-generated code and skill scripts OFF the host process (§10.3, §10.5).
 * Implementations that cannot actually isolate MUST refuse to execute — see `NoopSandbox` in
 * `@eidentic/core` (secure-by-default: "no sandbox ⇒ no untrusted exec", §10.7).
 */
export interface SandboxPort {
  /** Execute `code` in isolation and return its captured output. */
  run(code: string, opts?: SandboxRunOptions): Promise<SandboxResult>;
}

// --- Guardrail port (D7) ---

/**
 * Context passed to each guardrail check. Provided on a best-effort basis; both fields are
 * optional so a guardrail implementation is never required to use them.
 */
export interface GuardrailContext {
  /** The agent's identifier — useful for per-agent guardrail policies. */
  agentId?: string;
  /** The session identifier for the current run. */
  sessionId?: string;
  /** Which side of the run is being inspected. */
  source?: "input" | "output";
  /** Optional channel label supplied by the host, e.g. "email" or "chat". */
  channel?: string;
  /** Host-supplied metadata for guardrail analytics/routing. */
  metadata?: Record<string, unknown>;
}

/**
 * What a guardrail may do with the checked text:
 *
 * - `{ action: "allow" }` — pass the text through unchanged.
 * - `{ action: "block"; reason: string }` — terminate the run immediately.
 *   On **input** the run exits with `subtype: "guardrail"` before the model is called.
 *   On **output** the final text is replaced with a safe message and the run exits with
 *   `subtype: "guardrail"`.
 * - `{ action: "redact"; text: string; reason?: string }` — replace the text with
 *   `result.text` (the redacted version) and continue.
 *   On **input** the redacted text is passed to the model instead of the original.
 *   On **output** the final event carries the redacted text.
 */
export type GuardrailResult =
  | { action: "allow" }
  | { action: "block"; reason: string; code?: string; severity?: "low" | "medium" | "high" }
  | { action: "redact"; text: string; reason?: string; code?: string; severity?: "low" | "medium" | "high" };

/**
 * Content guardrail port (D7). Implement this interface to add PII redaction, content
 * moderation, compliance filtering, or any other text inspection step.
 *
 * - `checkInput` is called on the user's raw input **before** the first model call.
 * - `checkOutput` is called on the assistant's final text **before** it is returned.
 *
 * Either method may be omitted; an absent method is a no-op. Both methods may return a plain
 * value or a Promise so synchronous implementations do not need to return a resolved Promise.
 *
 * Multiple guardrails may be provided in `AgentConfig.guardrails`; they run in array order
 * and the first `block` wins. A `redact` result passes the redacted text to the next guardrail
 * in the chain.
 *
 * Example (external content-moderation service):
 * ```ts
 * const moderationGuardrail: GuardrailPort = {
 *   async checkInput(text) {
 *     const result = await moderationApi.check(text);
 *     if (result.flagged) return { action: "block", reason: result.reason };
 *     return { action: "allow" };
 *   },
 * };
 * ```
 */
export interface GuardrailPort {
  checkInput?(text: string, ctx?: GuardrailContext): Promise<GuardrailResult> | GuardrailResult;
  checkOutput?(text: string, ctx?: GuardrailContext): Promise<GuardrailResult> | GuardrailResult;
}

// Re-export Scope so consumers of security.ts have it available if needed.
export type { Scope };
