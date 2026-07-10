import type { SandboxPort } from "@eidentic/types";
import {
  contentHashOf,
  isToolAllowed,
  validateSkillName,
  type ExecutableSkillDef,
  type SkillLock,
  type SkillRunContext,
  type SkillTest,
} from "./executable.js";
import { verifyLock } from "./sign.js";
import { runSkillTests } from "./test-runner.js";

/** A refusing default sandbox (mirrors `@eidentic/core`'s `NoopSandbox`) kept local to preserve the
 *  `@eidentic/types`-only dep boundary: no real adapter ⇒ code-string skills cannot run. */
const REFUSING_SANDBOX: SandboxPort = {
  async run() {
    return {
      stdout: "",
      stderr: "",
      exitCode: 1,
      error: "no sandbox configured: refusing to execute untrusted code (inject a SandboxPort, e.g. @eidentic/e2b)",
    };
  },
};

const RESULT_MARKER = "EIDENTIC_RESULT:";

export interface SkillBankOptions {
  /** Sandbox for code-string skills. Defaults to a refusing sandbox (secure-by-default, §10.7). */
  sandbox?: SandboxPort;
  /** Wall-clock timeout for code-string sandbox runs. Defaults to the sandbox adapter's own policy. */
  sandboxTimeoutMs?: number;
  /**
   * When true, only serialized `code` skills may register and `use()` requires a valid signature
   * verified with `verifyKey`. In-process `run` closures are rejected because they are not
   * portably signable. Default false for trusted development compatibility.
   */
  requireSigned?: boolean;
  /** Public key (PEM) used to verify signatures when `requireSigned`. */
  verifyKey?: string;
  /** Injected clock for deterministic `skill.lock` timestamps. */
  now?: () => string;
  /**
   * Optional callTool stub used ONLY during test-gate evaluation (§7.4). When a skill test
   * calls an allowed tool and no real implementation is provided, this stub is called instead.
   * Defaults to a minimal echo stub: `\`${toolId.split("_")[0]}:${String(input)}\``.
   */
  testCallTool?: (toolId: string, input: unknown) => Promise<unknown>;
}

export type RegisterResult =
  | { ok: true; lock: SkillLock }
  | { ok: false; failures: string[] };

interface BankRecord {
  readonly def: StoredSkillDefinition;
  readonly lock: SkillLock;
}

interface StoredSkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly allowedTools?: readonly string[];
  readonly tests: readonly { readonly name: string }[];
  readonly run?: ExecutableSkillDef["run"];
  readonly code?: string;
}

type InvocableSkillDefinition = Pick<StoredSkillDefinition, "name" | "allowedTools" | "run" | "code">;

function cloneLock(lock: SkillLock): SkillLock {
  return {
    ...lock,
    tests: lock.tests.map((test) => ({ ...test })),
  };
}

function immutableLock(lock: SkillLock): SkillLock {
  const tests = Object.freeze(lock.tests.map((test) => Object.freeze({ ...test })));
  return Object.freeze({ ...lock, tests }) as SkillLock;
}

function immutableRecord(def: StoredSkillDefinition, lock: SkillLock): BankRecord {
  return Object.freeze({ def, lock: immutableLock(lock) });
}

function cloneTestInput(input: unknown, skillName: string, testName: string): unknown {
  try {
    return structuredClone(input);
  } catch {
    throw new Error(
      `executable skill "${skillName}": test "${testName}" input must be structured-cloneable`,
    );
  }
}

/** Snapshot caller-owned mutable arrays/objects before the asynchronous test gate starts. */
function snapshotCandidate(def: ExecutableSkillDef): ExecutableSkillDef {
  const allowedTools = def.allowedTools === undefined
    ? undefined
    : [...def.allowedTools];
  if (allowedTools) Object.freeze(allowedTools);
  const tests: SkillTest[] = def.tests.map((test) => Object.freeze({
    name: test.name,
    input: cloneTestInput(test.input, def.name, test.name),
    check: test.check,
  }));
  Object.freeze(tests);
  return Object.freeze({
    name: def.name,
    description: def.description,
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    tests,
    ...(def.run !== undefined ? { run: def.run } : {}),
    ...(def.code !== undefined ? { code: def.code } : {}),
  });
}

function storedDefinitionOf(def: ExecutableSkillDef): StoredSkillDefinition {
  const tests = Object.freeze(def.tests.map((test) => Object.freeze({ name: test.name })));
  return Object.freeze({
    name: def.name,
    description: def.description,
    ...(def.allowedTools !== undefined
      ? { allowedTools: Object.freeze([...def.allowedTools]) }
      : {}),
    tests,
    ...(def.run !== undefined ? { run: def.run } : {}),
    ...(def.code !== undefined ? { code: def.code } : {}),
  });
}

/** Default test-gate callTool stub: echoes `toolId-prefix:input` so skills that call an allowed tool
 *  during test-gate get a deterministic, observable response without a real host implementation. */
async function defaultTestCallTool(toolId: string, input: unknown): Promise<unknown> {
  return `${toolId.split("_")[0]}:${String(input)}`;
}

export class SkillBank {
  readonly #records = new Map<string, BankRecord>();
  readonly #order: string[] = [];
  readonly #versions = new Map<string, number>();
  readonly #sandbox: SandboxPort;
  readonly #sandboxTimeoutMs: number | undefined;
  readonly #requireSigned: boolean;
  readonly #verifyKey?: string;
  readonly #now: () => string;
  readonly #testCallTool: (toolId: string, input: unknown) => Promise<unknown>;

  constructor(opts?: SkillBankOptions) {
    this.#sandbox = opts?.sandbox ?? REFUSING_SANDBOX;
    this.#sandboxTimeoutMs = opts?.sandboxTimeoutMs;
    this.#requireSigned = opts?.requireSigned ?? false;
    if (opts?.verifyKey !== undefined) this.#verifyKey = opts.verifyKey;
    this.#now = opts?.now ?? (() => new Date().toISOString());
    this.#testCallTool = opts?.testCallTool ?? defaultTestCallTool;
  }

  /**
   * §7.4 create→evaluate→register. Runs ALL `def.tests`; registers ONLY if every test passes
   * (the test-gate). Computes a content hash, writes a versioned `skill.lock` with provenance,
   * and quarantines agent-authored skills unless `author === "human"`.
   */
  async register(
    def: ExecutableSkillDef,
    opts?: { author?: "human" | "agent" },
  ): Promise<RegisterResult> {
    // Provenance is security-sensitive state. Snapshot it before the test gate yields so a
    // caller cannot change an agent-authored registration into a trusted human one mid-flight.
    const author = opts?.author ?? "human";
    validateSkillName(def.name);
    const hasRun = typeof def.run === "function";
    const hasCode = typeof def.code === "string";
    if (hasRun === hasCode) {
      throw new Error("executable skill: provide exactly one of `run` or `code`");
    }

    // Security (§7.6): agent-authored skills MUST use `code` (sandboxed), never in-process `run`.
    // This ensures agent-generated logic never executes in-process, even during the test-gate.
    if (author === "agent" && hasRun) {
      return { ok: false, failures: ["agent-authored skills must use 'code' (sandboxed), not an in-process 'run' function"] };
    }

    // Function.toString() cannot attest closure state, native bindings, or runtime dependencies.
    // Claiming such a function is signed would be security theatre, so signed banks accept only
    // serialized code whose exact bytes are included in contentHash.
    if (this.#requireSigned && hasRun) {
      return {
        ok: false,
        failures: [
          "requireSigned skill banks cannot register an in-process `run` function because its function body and closure cannot be signed reliably; migrate to serialized `code` executed in a sandbox",
        ],
      };
    }

    // Take the ownership boundary snapshot only after synchronous shape validation, but before
    // the first await in the test gate. Caller mutations can no longer swap tested code/capabilities.
    const candidate = snapshotCandidate(def);

    if (candidate.tests.length === 0) {
      return { ok: false, failures: ["no tests declared: executable skills must declare at least one test (test-gate)"] };
    }

    // Evaluate (§7.4): run every test, recording per-test pass/fail. Reuses the shared
    // runSkillTests helper (also used by evolveSkill — NOT duplicated). Allowed tools are
    // proxied through the injected testCallTool stub; the invoker enforces deny-by-default.
    const results = await this.runBankTests(candidate);
    const testsPassed = results.every((r) => r.passed);
    if (!testsPassed) {
      // INVARIANT: a failing test means the skill is NOT registered.
      return { ok: false, failures: results.filter((r) => !r.passed).map((r) => r.name) };
    }

    const version = (this.#versions.get(candidate.name) ?? 0) + 1;
    this.#versions.set(candidate.name, version);
    const storedDef = storedDefinitionOf(candidate);
    const lock: SkillLock = {
      name: candidate.name,
      version,
      author,
      contentHash: contentHashOf(storedDef),
      tests: results,
      testsPassed: true,
      createdAt: this.#now(),
      quarantined: author === "agent", // agent-authored quarantined until approve() (§7.6)
    };
    if (!this.#records.has(candidate.name)) this.#order.push(candidate.name);
    this.#records.set(candidate.name, immutableRecord(storedDef, lock));
    return { ok: true, lock: cloneLock(lock) };
  }

  /** §7.6 quarantine release: clear quarantine for an agent-authored skill (only after tests passed).
   *  Strips the existing signature (if any) because flipping `quarantined` makes it stale. */
  approve(name: string): boolean {
    const rec = this.#records.get(name);
    if (!rec) return false;
    this.assertIntegrity(rec, "approve");
    const { signature: _drop, ...rest } = rec.lock;
    this.#records.set(name, immutableRecord(rec.def, { ...rest, quarantined: false }));
    return true;
  }

  /** Attach a signature to a registered skill's lock (produced by `signLock`, §7.6). */
  setSignature(name: string, signature: string): boolean {
    const rec = this.#records.get(name);
    if (!rec) return false;
    this.assertIntegrity(rec, "setSignature");
    this.#records.set(name, immutableRecord(rec.def, { ...rec.lock, signature }));
    return true;
  }

  /** The `skill.lock` for a registered skill, or null. Quarantined skills ARE returned here (listed, not runnable). */
  get(name: string): SkillLock | null {
    const lock = this.#records.get(name)?.lock;
    return lock ? cloneLock(lock) : null;
  }

  /** All registered skill.locks in registration order (includes quarantined — they are listed but not runnable). */
  list(): SkillLock[] {
    return this.#order.map((n) => cloneLock(this.#records.get(n)!.lock));
  }

  /**
   * §7.4 use. Runs a registered, NON-quarantined, (if `requireSigned`) signature-verified skill,
   * enforcing `allowedTools` on `ctx.callTool` (deny-by-default). Code-string skills run via the
   * injected `SandboxPort`. Throws on: unknown skill, quarantined skill, signature failure.
   */
  async use(name: string, input: unknown, ctx?: SkillRunContext): Promise<unknown> {
    const rec = this.#records.get(name);
    if (!rec) throw new Error(`SkillBank.use: unknown skill "${name}"`);
    this.assertIntegrity(rec, "use");
    if (rec.lock.quarantined) throw new Error(`SkillBank.use: skill "${name}" is quarantined (needs approve())`);
    if (this.#requireSigned) {
      if (typeof rec.def.run === "function") {
        throw new Error(
          `SkillBank.use: signed skill "${name}" uses an unverifiable in-process function; migrate to serialized code`,
        );
      }
      const ok = await this.verifySignature(rec.lock);
      if (!ok) throw new Error(`SkillBank.use: skill "${name}" failed signature verification`);
    }
    return this.invoke(rec.def, input, ctx);
  }

  /** Run a skill def (typed-function via `run`, or code-string via the sandbox), enforcing allowedTools. */
  private async invoke(def: InvocableSkillDefinition, input: unknown, ctx?: SkillRunContext): Promise<unknown> {
    const scopedCtx: SkillRunContext = {
      callTool: this.wrapCallTool(def.allowedTools, ctx?.callTool),
      ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
    };
    if (typeof def.run === "function") {
      return def.run(input, scopedCtx);
    }
    // Code-string: execute via the injected sandbox. The skill body must print `EIDENTIC_RESULT:<json>`.
    // Inject the serialized input as a `const INPUT = …;` preamble so the code can access it.
    // JSON.stringify is safe here: even if the value contains special characters (quotes, newlines,
    // </script>, etc.) the serialized form is a valid JS string literal because JSON encoding
    // escapes all characters that could break out of the literal context (M3 fix).
    const inputPreamble = `const INPUT = ${JSON.stringify(input)};\n`;
    const codeWithInput = inputPreamble + def.code!;
    const res = await this.#sandbox.run(codeWithInput, {
      language: "javascript",
      ...(this.#sandboxTimeoutMs !== undefined ? { timeoutMs: this.#sandboxTimeoutMs } : {}),
      ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    if (res.exitCode !== 0) {
      throw new Error(`SkillBank: sandboxed skill "${def.name}" failed (exitCode ${res.exitCode}): ${res.error ?? res.stderr}`);
    }
    const idx = res.stdout.lastIndexOf(RESULT_MARKER);
    if (idx === -1) return undefined;
    const json = res.stdout.slice(idx + RESULT_MARKER.length).trim();
    try {
      return JSON.parse(json);
    } catch {
      return json; // tolerate a non-JSON marker payload
    }
  }

  /** Wrap a host `callTool` so a tool id NOT matching the skill's `allowedTools` is rejected (deny-by-default). */
  private wrapCallTool(
    allowedTools: readonly string[] | undefined,
    callTool: SkillRunContext["callTool"],
  ): SkillRunContext["callTool"] {
    return async (toolId: string, input: unknown): Promise<unknown> => {
      if (!isToolAllowed(allowedTools, toolId)) {
        throw new Error(`skill capability scope: tool "${toolId}" is not in allowed-tools ${JSON.stringify(allowedTools ?? [])}`);
      }
      if (!callTool) throw new Error(`skill capability scope: no host callTool provided for "${toolId}"`);
      return callTool(toolId, input);
    };
  }

  /**
   * Run tests for a skill using the bank's own invoke machinery (which routes through the sandbox
   * for code-string skills and uses the bank's testCallTool stub). This is the bank-side test-gate
   * that feeds into `register`. The shared `runSkillTests` in test-runner.ts is used by evolveSkill
   * for typed-function skills; the bank adds sandbox routing on top for code-string skills via the
   * optional `invoker` parameter.
   */
  private async runBankTests(def: ExecutableSkillDef): Promise<{ name: string; passed: boolean }[]> {
    const wrappedCallTool = this.wrapCallTool(def.allowedTools, this.#testCallTool);
    return runSkillTests(
      def,
      wrappedCallTool,
      // For code-string skills, route through the bank's full invoke machinery (sandbox-aware).
      async (skillDef, input) => this.invoke(skillDef, input, { callTool: this.#testCallTool }),
    );
  }

  private assertIntegrity(rec: BankRecord, operation: "approve" | "setSignature" | "use"): void {
    const actualHash = contentHashOf(rec.def);
    const lockTests = rec.lock.tests.map((test) => test.name).sort();
    const definitionTests = rec.def.tests.map((test) => test.name).sort();
    const testsMatch = lockTests.length === definitionTests.length &&
      lockTests.every((name, index) => name === definitionTests[index]);
    if (
      actualHash !== rec.lock.contentHash ||
      rec.lock.name !== rec.def.name ||
      !rec.lock.testsPassed ||
      rec.lock.tests.some((test) => !test.passed) ||
      !testsMatch
    ) {
      throw new Error(
        `SkillBank.${operation}: skill "${rec.lock.name}" failed integrity/content hash verification`,
      );
    }
  }

  /** Verify the lock signature against the configured `verifyKey` (§7.6). */
  protected async verifySignature(lock: SkillLock): Promise<boolean> {
    if (this.#verifyKey === undefined) return false; // requireSigned but no key ⇒ cannot verify ⇒ deny
    return verifyLock(lock, this.#verifyKey);
  }
}

export type { SkillTest, ExecutableSkillDef, SkillLock, SkillRunContext };
