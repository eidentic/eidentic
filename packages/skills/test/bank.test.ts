import { describe, it, expect } from "vitest";
import type { SandboxPort, SandboxResult } from "@eidentic/types";
import { SkillBank } from "../src/bank.js";
import type { ExecutableSkillDef } from "../src/executable.js";

const FIXED = () => "2026-06-06T00:00:00.000Z";

/** Trusted-dev fake: runs the code-string protocol — code prints `EIDENTIC_RESULT:<json>` to stdout. */
class FakeJsSandbox implements SandboxPort {
  /** Last code string passed to run() — used to inspect the injected preamble. */
  lastCode = "";
  async run(code: string): Promise<SandboxResult> {
    this.lastCode = code;
    // The bank wraps the skill body so it prints EIDENTIC_RESULT:<json>; here we just eval that marker.
    // For tests we recognise a tiny protocol: code is `RESULT <json>` ⇒ echo it back as the marker.
    // Strip the injected INPUT preamble first (it is a `const INPUT = ...;\n` prefix).
    const stripped = code.replace(/^const INPUT = .*?;\n/s, "");
    const m = /^RESULT (.*)$/s.exec(stripped.trim());
    if (m) return { stdout: `EIDENTIC_RESULT:${m[1]}`, stderr: "", exitCode: 0 };
    if (stripped.trim() === "BOOM") return { stdout: "", stderr: "boom", exitCode: 1, error: "boom" };
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}

const doubler: ExecutableSkillDef = {
  name: "doubler",
  description: "doubles a number",
  tests: [
    { name: "doubles 2", input: 2, check: (o) => o === 4 },
    { name: "doubles 0", input: 0, check: (o) => o === 0 },
  ],
  run: async (input) => (input as number) * 2,
};

describe("SkillBank test-gate (§7.4)", () => {
  it("registers a skill ONLY when all tests pass, writing a versioned skill.lock", async () => {
    const bank = new SkillBank({ now: FIXED });
    const r = await bank.register(doubler);
    expect(r.ok).toBe(true);
    expect(r.lock).toBeDefined();
    expect(r.lock!.name).toBe("doubler");
    expect(r.lock!.version).toBe(1);
    expect(r.lock!.author).toBe("human");
    expect(r.lock!.testsPassed).toBe(true);
    expect(r.lock!.tests).toEqual([
      { name: "doubles 2", passed: true },
      { name: "doubles 0", passed: true },
    ]);
    expect(r.lock!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.lock!.quarantined).toBe(false);          // human-authored ⇒ trusted
    expect(r.lock!.createdAt).toBe(FIXED());
    expect(bank.get("doubler")).not.toBeNull();
    expect(bank.list().map((l) => l.name)).toContain("doubler");
  });

  it("does NOT register when any test fails (returns failures, not added)", async () => {
    const bank = new SkillBank({ now: FIXED });
    const broken: ExecutableSkillDef = {
      name: "broken",
      description: "claims to double but doesn't",
      tests: [
        { name: "should double 2", input: 2, check: (o) => o === 4 },
        { name: "should double 3", input: 3, check: (o) => o === 6 },
      ],
      run: async (input) => (input as number) + 1, // wrong
    };
    const r = await bank.register(broken);
    expect(r.ok).toBe(false);
    expect(r.lock).toBeUndefined();
    expect(r.failures).toEqual(["should double 2", "should double 3"]);
    expect(bank.get("broken")).toBeNull();                 // INVARIANT: not registered
    expect(bank.list().some((l) => l.name === "broken")).toBe(false);
  });

  it("bumps version per name on each successful re-register", async () => {
    const bank = new SkillBank({ now: FIXED });
    expect((await bank.register(doubler)).lock!.version).toBe(1);
    expect((await bank.register(doubler)).lock!.version).toBe(2);
  });

  it("rejects a malformed skill name", async () => {
    const bank = new SkillBank({ now: FIXED });
    await expect(bank.register({ ...doubler, name: "Not Kebab" })).rejects.toThrow(/kebab-case/);
  });

  it("rejects a skill with tests: [] (vacuous test-gate pass) — not registered", async () => {
    const bank = new SkillBank({ now: FIXED });
    const noTests: ExecutableSkillDef = {
      name: "no-tests",
      description: "declares no tests",
      tests: [],
      run: async (input) => input,
    };
    const r = await bank.register(noTests);
    expect(r.ok).toBe(false);
    expect(r.lock).toBeUndefined();
    expect(r.failures).toEqual(expect.arrayContaining([expect.stringMatching(/no tests declared/)]));
    expect(bank.get("no-tests")).toBeNull();                 // INVARIANT: not registered
    expect(bank.list().some((l) => l.name === "no-tests")).toBe(false);
  });

  it("rejects a def with neither run nor code, and one with both", async () => {
    const bank = new SkillBank({ now: FIXED });
    await expect(bank.register({ name: "empty", description: "d", tests: [] } as never))
      .rejects.toThrow(/exactly one of `run` or `code`/);
    await expect(bank.register({ ...doubler, code: "x" })).rejects.toThrow(/exactly one of `run` or `code`/);
  });
});

describe("SkillBank allowed-tools enforcement (§7.6, deny-by-default)", () => {
  it("blocks a tool call NOT in allowedTools and allows a matching one", async () => {
    const calls: string[] = [];
    const bank = new SkillBank({ now: FIXED });
    const skill: ExecutableSkillDef = {
      name: "reader",
      description: "reads then tries to delete",
      allowedTools: ["read_*"],
      tests: [{ name: "reads fine", input: "f", check: (o) => o === "read:f" }],
      run: async (input, ctx) => {
        // allowed: matches read_*
        const got = await ctx.callTool!("read_file", input);
        // not allowed: delete_all is outside the scope ⇒ must throw
        try {
          await ctx.callTool!("delete_all", {});
          calls.push("delete-succeeded");
        } catch {
          calls.push("delete-blocked");
        }
        return got;
      },
    };
    const r = await bank.register(skill);
    expect(r.ok).toBe(true);                               // test passed using only the allowed tool

    const out = await bank.use("reader", "f", {
      callTool: async (toolId, input) => `${toolId.split("_")[0]}:${input}`,
    });
    expect(out).toBe("read:f");
    expect(calls).toContain("delete-blocked");             // unlisted tool was rejected at runtime
  });

  it("denies ALL tools when a skill declares no allowedTools", async () => {
    const bank = new SkillBank({ now: FIXED });
    const skill: ExecutableSkillDef = {
      name: "no-scope",
      description: "tries a tool with empty scope",
      tests: [{ name: "tool blocked", input: 0, check: (o) => o === "blocked" }],
      run: async (_input, ctx) => {
        try { await ctx.callTool!("read_file", {}); return "allowed"; }
        catch { return "blocked"; }
      },
    };
    expect((await bank.register(skill)).ok).toBe(true);    // passes BECAUSE the tool is denied
  });
});

describe("SkillBank code-string execution via SandboxPort (§7.6)", () => {
  it("runs a code-string skill through the injected sandbox", async () => {
    const bank = new SkillBank({ now: FIXED, sandbox: new FakeJsSandbox() });
    const skill: ExecutableSkillDef = {
      name: "echo-code",
      description: "code-string skill that returns a fixed value",
      code: "RESULT 42",
      tests: [{ name: "returns 42", input: null, check: (o) => o === 42 }],
    };
    const r = await bank.register(skill, { author: "agent" });
    expect(r.ok).toBe(true);
    expect(r.lock!.quarantined).toBe(true);               // agent-authored ⇒ quarantined (Task 3 gates use)
  });

  it("a code-string skill with NO sandbox refuses (NoopSandbox default) ⇒ test fails", async () => {
    // Default sandbox is a refusing one; supply a refusing fake to assert the secure default behavior.
    const refusing: SandboxPort = { async run() { return { stdout: "", stderr: "", exitCode: 1, error: "no sandbox configured" }; } };
    const bank = new SkillBank({ now: FIXED, sandbox: refusing });
    const skill: ExecutableSkillDef = {
      name: "needs-sandbox",
      description: "code-string skill that cannot run without a real sandbox",
      code: "RESULT 1",
      tests: [{ name: "would return 1", input: null, check: (o) => o === 1 }],
    };
    const r = await bank.register(skill, { author: "agent" });
    expect(r.ok).toBe(false);                              // refused ⇒ no usable output ⇒ test fails ⇒ not registered
    expect(bank.get("needs-sandbox")).toBeNull();
  });
});

describe("Fix 2 — agent-authored skills must use code (sandboxed), not run (§7.6 security)", () => {
  it("rejects an agent-authored skill that provides a `run` function", async () => {
    const bank = new SkillBank({ now: FIXED });
    const skill: ExecutableSkillDef = {
      name: "agent-run",
      description: "agent skill with in-process run (disallowed)",
      tests: [{ name: "passes", input: 1, check: (o) => o === 2 }],
      run: async (input) => (input as number) + 1,
    };
    const r = await bank.register(skill, { author: "agent" });
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual(expect.arrayContaining([expect.stringMatching(/agent-authored.*code.*sandboxed/)]));
    expect(bank.get("agent-run")).toBeNull();             // NOT registered
  });

  it("allows an agent-authored skill with `code` + a real sandbox (registered, quarantined)", async () => {
    const bank = new SkillBank({ now: FIXED, sandbox: new FakeJsSandbox() });
    const skill: ExecutableSkillDef = {
      name: "agent-code",
      description: "agent skill with sandboxed code (allowed)",
      code: "RESULT 99",
      tests: [{ name: "returns 99", input: null, check: (o) => o === 99 }],
    };
    const r = await bank.register(skill, { author: "agent" });
    expect(r.ok).toBe(true);
    expect(r.lock!.quarantined).toBe(true);               // quarantined until approve()
    expect(bank.get("agent-code")).not.toBeNull();
  });

  it("human-authored skills with `run` are NOT rejected (only agent is restricted)", async () => {
    const bank = new SkillBank({ now: FIXED });
    const r = await bank.register(doubler);               // doubler uses `run`, author defaults to human
    expect(r.ok).toBe(true);
    expect(r.lock!.author).toBe("human");
  });
});

describe("Fix 3 — approve() strips stale signature (§7.6 security)", () => {
  it("approve() removes an existing signature from the lock", async () => {
    const { publicKey, privateKey } = (await import("../src/sign.js")).generateSkillKeypair();
    const bank = new SkillBank({ now: FIXED, requireSigned: true, verifyKey: publicKey });
    // Register as agent (quarantined), then sign the quarantined lock.
    const bank2 = new SkillBank({ now: FIXED });         // separate bank without requireSigned for registration
    const codeBank = new SkillBank({ now: FIXED, sandbox: new FakeJsSandbox() });
    const skill: ExecutableSkillDef = {
      name: "signed-skill",
      description: "skill signed while quarantined",
      code: "RESULT true",
      tests: [{ name: "returns true", input: null, check: (o) => o === true }],
    };
    const r = await codeBank.register(skill, { author: "agent" });
    expect(r.ok).toBe(true);
    expect(r.lock!.quarantined).toBe(true);

    // Sign the quarantined lock.
    const { signLock } = await import("../src/sign.js");
    const sig = signLock(r.lock!, privateKey);
    codeBank.setSignature("signed-skill", sig);
    expect(codeBank.get("signed-skill")!.signature).toBeDefined();

    // After approve(), the signature must be stripped.
    codeBank.approve("signed-skill");
    const afterApprove = codeBank.get("signed-skill")!;
    expect(afterApprove.quarantined).toBe(false);
    expect(afterApprove.signature).toBeUndefined();
  });

  it("under requireSigned, use() is rejected after approve() (stale sig stripped) until re-signed", async () => {
    const { generateSkillKeypair, signLock } = await import("../src/sign.js");
    const { publicKey, privateKey } = generateSkillKeypair();
    const bank = new SkillBank({ now: FIXED, requireSigned: true, verifyKey: publicKey, sandbox: new FakeJsSandbox() });
    const skill: ExecutableSkillDef = {
      name: "re-sign-skill",
      description: "skill that needs re-sign after approve",
      code: "RESULT 1",
      tests: [{ name: "returns 1", input: null, check: (o) => o === 1 }],
    };

    // Register as agent → quarantined.
    const r = await bank.register(skill, { author: "agent" });
    expect(r.ok).toBe(true);

    // Sign the quarantined lock, then approve (which strips the sig).
    const sig = signLock(r.lock!, privateKey);
    bank.setSignature("re-sign-skill", sig);
    bank.approve("re-sign-skill");

    // use() must be rejected: approved lock has no signature, requireSigned blocks it.
    await expect(bank.use("re-sign-skill", null)).rejects.toThrow(/signature verification/);

    // Re-sign the now-approved (non-quarantined) lock → use() must succeed.
    const approvedLock = bank.get("re-sign-skill")!;
    const newSig = signLock(approvedLock, privateKey);
    bank.setSignature("re-sign-skill", newSig);
    await expect(bank.use("re-sign-skill", null)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// M3 fix — code-string skill receives INPUT
// ---------------------------------------------------------------------------

describe("M3 fix — code-string skill: sandbox receives injected INPUT preamble", () => {
  it("INPUT preamble is prepended to the code passed to the sandbox", async () => {
    const sandbox = new FakeJsSandbox();
    const bank = new SkillBank({ now: FIXED, sandbox });

    // A code-string skill that echoes back RESULT 42 regardless of INPUT
    // (the sandbox fake strips the preamble and interprets RESULT <json>).
    const skill: ExecutableSkillDef = {
      name: "input-check",
      description: "verifies INPUT is injected",
      code: "RESULT 42",
      tests: [{ name: "returns 42", input: null, check: (o) => o === 42 }],
    };
    await bank.register(skill, { author: "agent" });
    bank.approve("input-check");

    await bank.use("input-check", { x: 1 });

    // The code sent to the sandbox must start with the INPUT preamble.
    expect(sandbox.lastCode).toMatch(/^const INPUT = /);
    // The preamble must encode the input correctly.
    expect(sandbox.lastCode).toContain('"x":1');
  });

  it("INPUT value differs per invocation and is accessible in the preamble", async () => {
    // Register with a sandbox that captures only USE calls (after registration).
    // Use the same FakeJsSandbox for registration, then swap to a capturing one.
    const registerSandbox = new FakeJsSandbox();
    const bank = new SkillBank({ now: FIXED, sandbox: registerSandbox });
    const skill: ExecutableSkillDef = {
      name: "vary-input",
      description: "varies by input",
      code: "RESULT null",
      tests: [{ name: "ok", input: 0, check: (o) => o === null }],
    };
    await bank.register(skill, { author: "agent" });
    bank.approve("vary-input");

    // Now swap to a fresh capturing sandbox for the use() calls.
    const capturedCodes: string[] = [];
    const capturingSandbox: SandboxPort = {
      async run(code) {
        capturedCodes.push(code);
        return { stdout: "EIDENTIC_RESULT:null", stderr: "", exitCode: 0 };
      },
    };
    // Inject the sandbox by creating a new bank instance that re-uses the same registered skill.
    // Simpler: just verify via registerSandbox's lastCode directly per use() call by using a
    // bank with a per-call capture sandbox from the start, relying on the test gate code being
    // the 0th capture (input=0) and use() calls being 1st+2nd.
    const capBank = new SkillBank({ now: FIXED, sandbox: { async run(code) { capturedCodes.push(code); return { stdout: "EIDENTIC_RESULT:null", stderr: "", exitCode: 0 }; } } });
    await capBank.register(skill, { author: "agent" });
    capBank.approve("vary-input");

    // capturedCodes[0] is from the test-gate (input=0), capturedCodes[1] onwards are use() calls.
    const beforeUse = capturedCodes.length;
    await capBank.use("vary-input", 42);
    await capBank.use("vary-input", "hello world");

    expect(capturedCodes[beforeUse]).toContain("INPUT = 42");
    expect(capturedCodes[beforeUse + 1]).toContain('INPUT = "hello world"');
    void capturingSandbox; // suppress unused var warning
  });

  it("input containing special characters (quotes, newlines) is safely embedded in the preamble", async () => {
    const capturedCode = { value: "" };
    const safeSandbox: SandboxPort = {
      async run(code) {
        capturedCode.value = code;
        return { stdout: "EIDENTIC_RESULT:true", stderr: "", exitCode: 0 };
      },
    };

    const bank = new SkillBank({ now: FIXED, sandbox: safeSandbox });
    const skill: ExecutableSkillDef = {
      name: "special-chars",
      description: "special chars in input",
      code: "// body",
      tests: [{ name: "ok", input: 0, check: () => true }],
    };
    await bank.register(skill, { author: "agent" });
    bank.approve("special-chars");

    // Input containing characters that require JSON escaping: double-quotes, backslashes, newlines.
    const trickyInput = { msg: 'say "hello"\nand\\goodbye' };
    await bank.use("special-chars", trickyInput);

    // The preamble must be present.
    expect(capturedCode.value).toMatch(/^const INPUT = /);
    // The input must be present as a JSON-serialized object (verifiable by round-tripping).
    const preambleMatch = capturedCode.value.match(/^const INPUT = (.+?);/);
    expect(preambleMatch).not.toBeNull();
    const parsed = JSON.parse(preambleMatch![1]!);
    expect(parsed).toEqual(trickyInput);
  });
});
