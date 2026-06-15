import { createHash } from "node:crypto";
import { canonicalJson } from "@eidentic/types";
import type { SandboxPort } from "@eidentic/types";

/** One unit test for an executable skill. `check` decides pass/fail from the skill's output. */
export interface SkillTest {
  name: string;
  input: unknown;
  check: (output: unknown) => boolean;
}

/** Context handed to a typed-function skill's `run`. Minimal in v1; scope/secrets thread in later. */
export interface SkillRunContext {
  /** Invoke a tool — the bank wraps this so only `allowedTools`-matching ids succeed (deny-by-default). */
  callTool?: (toolId: string, input: unknown) => Promise<unknown>;
  /** Optional cooperative cancellation signal for long-running skill execution. */
  signal?: AbortSignal;
}

/**
 * An executable skill (§7.1). EXACTLY ONE of `run` (typed-function, trusted/dev-authored) or `code`
 * (code-string, agent-authored, executed via the injected `SandboxPort`) is provided.
 */
export interface ExecutableSkillDef {
  name: string;                 // kebab-case, ≤64 chars (validated like interop skills)
  description: string;          // ≤1024 chars
  allowedTools?: string[];      // capability scope (globs); deny-by-default at run time
  tests: SkillTest[];           // MUST all pass to register (the test-gate)
  run?: (input: unknown, ctx: SkillRunContext) => Promise<unknown>;  // typed-function form
  code?: string;                // OR code-string form: executed via SandboxPort instead of `run`
}

/** §7.6 provenance + test-gate record persisted per registered skill version. */
export interface SkillLock {
  name: string;
  version: number;              // increments per name on each successful register
  author: "human" | "agent";
  contentHash: string;          // sha256 over the canonical skill source/def
  tests: { name: string; passed: boolean }[];
  testsPassed: boolean;         // true ⇔ every test passed (registration invariant)
  createdAt: string;
  signature?: string;           // base64 ed25519 over canonical(lock minus signature)
  quarantined: boolean;         // true for agent-authored until approve(); blocks use()
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Validate a skill name exactly like interop skills (kebab-case, ≤64). Throws on violation. */
export function validateSkillName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error(`executable skill: \`name\` must be kebab-case, got "${name}"`);
  if (name.length > 64) throw new Error("executable skill: `name` must be ≤64 chars");
}

/**
 * Minimal anchored glob: `*` matches any run of characters (including empty); the whole string must
 * match. Kept LOCAL to preserve the `@eidentic/types`-only dep boundary — this is a byte-for-byte
 * mirror of `@eidentic/core`'s `globMatch` (`packages/core/src/permission.ts`). Parity is asserted by a test.
 */
export function matchSkillGlob(pattern: string, id: string): boolean {
  if (!pattern.includes("*")) return pattern === id;
  const parts = pattern.split("*");
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (i === 0) {
      if (!id.startsWith(part)) return false;
      pos = part.length;
    } else if (i === parts.length - 1) {
      if (!id.endsWith(part)) return false;
      if (id.length - part.length < pos) return false;
    } else {
      const idx = id.indexOf(part, pos);
      if (idx === -1) return false;
      pos = idx + part.length;
    }
  }
  return true;
}

/**
 * Deny-by-default capability check (§7.6). A skill with NO `allowedTools` may call NO tools; a skill
 * with `allowedTools` may call only ids matching one of its globs.
 */
export function isToolAllowed(allowedTools: string[] | undefined, toolId: string): boolean {
  if (!allowedTools || allowedTools.length === 0) return false;
  return allowedTools.some((g) => matchSkillGlob(g, toolId));
}

/**
 * sha256 over the canonical, function-free SHAPE of a skill (§7.6 content hash). Test `check`
 * functions and `run` bodies are NOT serializable, so the hash covers only the durable identity:
 * name, description, allowedTools, code (for code-string skills), and the test NAMES (order-independent).
 */
export function contentHashOf(def: {
  name: string;
  description: string;
  allowedTools?: string[];
  code?: string;
  tests?: { name: string }[];
}): string {
  const shape = {
    name: def.name,
    description: def.description,
    allowedTools: def.allowedTools ?? [],
    code: def.code ?? null,
    tests: (def.tests ?? []).map((t) => t.name).sort(),
  };
  return createHash("sha256").update(canonicalJson(shape)).digest("hex");
}

/** Re-export the injected sandbox type for ergonomic bank construction. */
export type { SandboxPort };
