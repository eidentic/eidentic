import { describe, it, expect } from "vitest";
import { generateSkillKeypair, signLock, verifyLock } from "../src/sign.js";
import { SkillBank } from "../src/bank.js";
import type { ExecutableSkillDef, SkillLock } from "../src/executable.js";

const FIXED = () => "2026-06-06T00:00:00.000Z";
const signedCodeSkill: ExecutableSkillDef = {
  name: "greeter-code",
  description: "greets from serialized code",
  code: `console.log("EIDENTIC_RESULT:\\"hi x\\"")`,
  tests: [{ name: "greets", input: "x", check: (output) => output === "hi x" }],
};
const codeSandbox = {
  async run() {
    return { stdout: `EIDENTIC_RESULT:"hi x"`, stderr: "", exitCode: 0 };
  },
};

describe("ed25519 sign/verify over the canonical lock (§7.6)", () => {
  it("signs a lock and verifies it", () => {
    const { publicKey, privateKey } = generateSkillKeypair();
    const lock: SkillLock = {
      name: "greeter", version: 1, author: "human", contentHash: "abc",
      tests: [{ name: "greets", passed: true }], testsPassed: true,
      createdAt: FIXED(), quarantined: false,
    };
    const signature = signLock(lock, privateKey);
    expect(typeof signature).toBe("string");
    expect(verifyLock({ ...lock, signature }, publicKey)).toBe(true);
  });

  it("fails verification when ANY signed field is tampered", () => {
    const { publicKey, privateKey } = generateSkillKeypair();
    const lock: SkillLock = {
      name: "greeter", version: 1, author: "human", contentHash: "abc",
      tests: [{ name: "greets", passed: true }], testsPassed: true,
      createdAt: FIXED(), quarantined: false,
    };
    const signature = signLock(lock, privateKey);
    // tamper: flip testsPassed / contentHash / quarantined — each must break verification
    expect(verifyLock({ ...lock, signature, contentHash: "XXX" }, publicKey)).toBe(false);
    expect(verifyLock({ ...lock, signature, testsPassed: false }, publicKey)).toBe(false);
    expect(verifyLock({ ...lock, signature, quarantined: true }, publicKey)).toBe(false);
  });

  it("fails verification under a different public key", () => {
    const a = generateSkillKeypair();
    const b = generateSkillKeypair();
    const lock: SkillLock = {
      name: "greeter", version: 1, author: "human", contentHash: "abc",
      tests: [], testsPassed: true, createdAt: FIXED(), quarantined: false,
    };
    const signature = signLock(lock, a.privateKey);
    expect(verifyLock({ ...lock, signature }, b.publicKey)).toBe(false);
  });
});

describe("SkillBank requireSigned enforcement (§7.6)", () => {
  it("rejects use() of an unsigned skill when requireSigned", async () => {
    const { publicKey } = generateSkillKeypair();
    const bank = new SkillBank({ now: FIXED, requireSigned: true, verifyKey: publicKey, sandbox: codeSandbox });
    expect((await bank.register(signedCodeSkill)).ok).toBe(true);
    await expect(bank.use("greeter-code", "x")).rejects.toThrow(/signature verification/);
  });

  it("allows use() once the lock is signed with the matching key", async () => {
    const { publicKey, privateKey } = generateSkillKeypair();
    const bank = new SkillBank({ now: FIXED, requireSigned: true, verifyKey: publicKey, sandbox: codeSandbox });
    const r = await bank.register(signedCodeSkill);
    const signature = signLock(r.lock!, privateKey);
    bank.setSignature("greeter-code", signature);
    expect(await bank.use("greeter-code", "x")).toBe("hi x");
  });

  it("rejects a signature made over a caller-mutated lock copy", async () => {
    const { publicKey, privateKey } = generateSkillKeypair();
    const bank = new SkillBank({ now: FIXED, requireSigned: true, verifyKey: publicKey, sandbox: codeSandbox });
    const result = await bank.register(signedCodeSkill);
    expect(result.ok).toBe(true);
    const forged = bank.get("greeter-code")!;
    forged.contentHash = "0".repeat(64);

    bank.setSignature("greeter-code", signLock(forged, privateKey));

    await expect(bank.use("greeter-code", "x")).rejects.toThrow(/signature verification/);
    expect(bank.get("greeter-code")!.contentHash).toBe(result.lock!.contentHash);
  });
});

describe("agent-authored quarantine (§7.6)", () => {
  it("quarantines an agent-authored skill and blocks use() until approve()", async () => {
    // Agent-authored skills MUST use `code` (sandboxed) — not an in-process `run` function (Fix 2).
    // Use a fake sandbox that returns a fixed value.
    const fakeSandbox = {
      async run(_code: string) {
        return { stdout: "EIDENTIC_RESULT:\"hi x\"", stderr: "", exitCode: 0 as const };
      },
    };
    const agentSkill: ExecutableSkillDef = {
      name: "greeter",
      description: "greets",
      code: "RESULT \"hi x\"",
      tests: [{ name: "greets", input: "x", check: (o) => o === "hi x" }],
    };
    const bank = new SkillBank({ now: FIXED, sandbox: fakeSandbox });
    const r = await bank.register(agentSkill, { author: "agent" });
    expect(r.ok).toBe(true);
    expect(r.lock!.quarantined).toBe(true);
    expect(bank.list().map((l) => l.name)).toContain("greeter"); // listed...
    await expect(bank.use("greeter", "x")).rejects.toThrow(/quarantined/); // ...but not runnable
    expect(bank.approve("greeter")).toBe(true);
    expect(bank.get("greeter")!.quarantined).toBe(false);
    expect(await bank.use("greeter", "x")).toBe("hi x");          // runnable after approval
  });
});
