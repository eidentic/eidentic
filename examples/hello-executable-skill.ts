/**
 * Executable skills + safety substrate (§7.1, §7.4, §7.6).
 *
 * Demonstrates, with NO infra:
 *   1. A typed-function executable skill registers ONLY when all its tests pass (test-gate), and a
 *      skill with a failing test is REJECTED (not registered).
 *   2. `allowed-tools` is enforced deny-by-default: a skill scoped to `read_*` cannot call `delete_all`.
 *   3. `skill.lock` provenance is signed (ed25519) and verifies; a tampered lock fails verification.
 *   4. Agent-authored skills with an in-process `run` function are REJECTED (security rule §7.6).
 *   5. Agent-authored skills correctly use a sandboxed `code` string, are QUARANTINED until `approve()`,
 *      and run via the injected `SandboxPort` once approved.
 *
 * Run:  pnpm -C examples hello:executable-skill
 */
import {
  SkillBank,
  generateSkillKeypair,
  signLock,
  verifyLock,
  type ExecutableSkillDef,
} from "@eidentic/skills";
import type { SandboxPort, SandboxResult } from "@eidentic/types";

// ---------------------------------------------------------------------------
// DEMO-ONLY inline sandbox — NOT real isolation.
//
// A real sandbox (e.g. @eidentic/e2b's E2BSandbox) runs code in an isolated
// microVM off-process. This Function-based executor is used here ONLY to make
// the demo self-contained and infra-free. Never use this in production.
// ---------------------------------------------------------------------------
const inlineDemoSandbox: SandboxPort = {
  async run(code: string): Promise<SandboxResult> {
    const lines: string[] = [];
    // Capture console.log output from the evaluated code.
    const capturedLog = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function("console", code);
      fn({ log: capturedLog });
    } catch (err) {
      return { stdout: "", stderr: String(err), exitCode: 1, error: String(err) };
    }
    return { stdout: lines.join("\n"), stderr: "", exitCode: 0 };
  },
};

async function main() {
  // ---- 1. Test-gate: passing skill registers, failing skill is rejected -------------------------
  const bank = new SkillBank({ sandbox: inlineDemoSandbox });

  const doubler: ExecutableSkillDef = {
    name: "doubler",
    description: "doubles a number",
    tests: [
      { name: "doubles 2", input: 2, check: (o) => o === 4 },
      { name: "doubles 5", input: 5, check: (o) => o === 10 },
    ],
    run: async (input) => (input as number) * 2,
  };
  const ok = await bank.register(doubler);
  console.log("[register doubler] ok:", ok.ok, "version:", ok.ok && ok.lock.version);
  console.log("[skill.lock]", JSON.stringify(bank.get("doubler"), null, 2));

  const broken: ExecutableSkillDef = {
    name: "broken-doubler",
    description: "claims to double but adds one",
    tests: [{ name: "doubles 2", input: 2, check: (o) => o === 4 }],
    run: async (input) => (input as number) + 1,
  };
  const bad = await bank.register(broken);
  console.log("[register broken] ok:", bad.ok, "failures:", bad.ok ? [] : bad.failures);
  console.log("[broken registered?]", bank.get("broken-doubler") !== null); // false — test-gate held

  // ---- 2. allowed-tools enforcement (deny-by-default) -------------------------------------------
  const reader: ExecutableSkillDef = {
    name: "reader",
    description: "reads a file then tries (and fails) to delete everything",
    allowedTools: ["read_*"],
    tests: [{ name: "reads", input: "notes.md", check: (o) => o === "read:notes.md" }],
    run: async (input, ctx) => {
      const got = await ctx.callTool!("read_file", input);     // allowed (matches read_*)
      try {
        await ctx.callTool!("delete_all", {});                 // NOT allowed ⇒ throws
        console.log("[reader] delete_all SUCCEEDED — this should never print");
      } catch (e) {
        console.log("[reader] delete_all blocked:", (e as Error).message);
      }
      return got;
    },
  };
  await bank.register(reader);
  const out = await bank.use("reader", "notes.md", {
    callTool: async (toolId, input) => `${toolId.split("_")[0]}:${input}`,
  });
  console.log("[reader] result:", out);

  // ---- 3. Signing: sign → verify → tamper fails -------------------------------------------------
  const { publicKey, privateKey } = generateSkillKeypair();
  const lock = bank.get("doubler")!;
  const signature = signLock(lock, privateKey);
  console.log("[sign] verify signed lock :", verifyLock({ ...lock, signature }, publicKey)); // true
  console.log("[sign] verify tampered lock:", verifyLock({ ...lock, signature, contentHash: "TAMPERED" }, publicKey)); // false

  // requireSigned bank: use() refused until the lock is signed with the matching key.
  const signedBank = new SkillBank({ requireSigned: true, verifyKey: publicKey });
  const reg = await signedBank.register(doubler);
  try {
    await signedBank.use("doubler", 2);
  } catch (e) {
    console.log("[requireSigned] unsigned use refused:", (e as Error).message);
  }
  signedBank.setSignature("doubler", signLock(reg.ok ? reg.lock : lock, privateKey));
  console.log("[requireSigned] signed use:", await signedBank.use("doubler", 2)); // 4

  // ---- 4. Security rule: agent-authored skill with `run` is REJECTED (§7.6) --------------------
  //
  // Since the security fix, registering an agent-authored skill that provides an in-process `run`
  // function is REJECTED immediately — agent-generated logic must never run in-process. This is a
  // feature, not a bug. The error message explains the required path (use `code` instead).
  const agentRunSkill: ExecutableSkillDef = {
    name: "agent-greeter-unsafe",
    description: "an agent-authored skill using an in-process run function (disallowed)",
    tests: [{ name: "greets", input: "world", check: (o) => o === "hi world" }],
    run: async (input) => `hi ${input}`,
  };
  const rejected = await bank.register(agentRunSkill, { author: "agent" });
  console.log("[agent-run] ok:", rejected.ok); // false — correctly rejected
  console.log("[agent-run] reason:", !rejected.ok && rejected.failures[0]);
  console.log("[agent-run] registered?", bank.get("agent-greeter-unsafe") !== null); // false

  // ---- 5. Agent-authored quarantine: code-string path (correct) ---------------------------------
  //
  // Agent-authored skills must supply `code` (a code string executed via the SandboxPort). The bank
  // does NOT forward `input` into the sandbox call — the code string is self-contained. Here we bake
  // "world" into the code so the skill produces a fixed, verifiable result.
  //
  // The code must print the result marker exactly: EIDENTIC_RESULT:<json>
  // The bank uses lastIndexOf to find the marker and JSON.parses what follows.
  //
  // The inline inlineDemoSandbox above executes the code via `new Function` with a captured console.log.
  // In production, replace it with @eidentic/e2b's E2BSandbox for real off-process isolation.
  const agentCodeSkill: ExecutableSkillDef = {
    name: "agent-greeter",
    description: "an agent-authored skill using sandboxed code (correct path)",
    // The code string is self-contained. It prints EIDENTIC_RESULT:<json> so the bank can extract the value.
    code: `
// Agent-authored skill body — runs inside the sandbox.
// Input is baked into the code string (the bank does not forward it at runtime).
const input = "world";
const result = "hi " + input;
console.log("EIDENTIC_RESULT:" + JSON.stringify(result));
`.trim(),
    // Test: the code always returns "hi world" regardless of the test input value, so the check
    // simply verifies the fixed output. This is the expected pattern for code-string skills.
    tests: [{ name: "greets world", input: "world", check: (o) => o === "hi world" }],
  };

  const ar = await bank.register(agentCodeSkill, { author: "agent" });
  console.log("[agent-code] registered ok:", ar.ok); // true
  console.log("[agent-code] quarantined:", ar.ok && ar.lock.quarantined); // true — blocked until approve()

  // While quarantined, use() is refused.
  try {
    await bank.use("agent-greeter", "world");
  } catch (e) {
    console.log("[agent-code] use while quarantined refused:", (e as Error).message);
  }

  // After approve(), the skill runs via the sandbox and returns its result.
  bank.approve("agent-greeter");
  const agentResult = await bank.use("agent-greeter", "world");
  console.log("[agent-code] use after approve:", agentResult); // hi world
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
