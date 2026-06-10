/**
 * Shared test-gate logic: runs all `SkillTest`s against an `ExecutableSkillDef` and returns
 * per-test pass/fail. Used by both `SkillBank.register` and `evolveSkill` so the test-gate
 * logic is NOT duplicated — both share the same evaluation surface.
 *
 * For typed-function skills (`run`), the tests are run directly. For code-string skills
 * (`code`), an optional `invoker` must be provided by the caller (SkillBank provides this
 * to route through its sandbox). Without an invoker, code-string skills always fail.
 */

import type { ExecutableSkillDef, SkillTest } from "./executable.js";

/** Default callTool stub: echoes `toolId-prefix:input` — mirrors SkillBank's defaultTestCallTool. */
async function defaultCallTool(toolId: string, input: unknown): Promise<unknown> {
  return `${toolId.split("_")[0]}:${String(input)}`;
}

/**
 * Run all tests in a skill def and return per-test pass/fail.
 *
 * @param def      - The skill to test.
 * @param callTool - Optional tool stub (defaults to the echo stub used by SkillBank).
 * @param invoker  - Optional custom invoker for code-string skills (SkillBank injects `this.invoke`
 *                   to route through the sandbox). Without this, code-string skills always fail.
 */
export async function runSkillTests(
  def: ExecutableSkillDef,
  callTool: (toolId: string, input: unknown) => Promise<unknown> = defaultCallTool,
  invoker?: (def: ExecutableSkillDef, input: unknown) => Promise<unknown>,
): Promise<{ name: string; passed: boolean }[]> {
  const results: { name: string; passed: boolean }[] = [];

  for (const t of def.tests) {
    let passed = false;
    try {
      let output: unknown;
      if (typeof def.run === "function") {
        output = await def.run(t.input, { callTool });
      } else if (invoker) {
        output = await invoker(def, t.input);
      } else {
        // code-string skill without an invoker — cannot run, fails the test.
        passed = false;
        results.push({ name: t.name, passed });
        continue;
      }
      passed = t.check(output);
    } catch {
      passed = false;
    }
    results.push({ name: t.name, passed });
  }

  return results;
}

export type { ExecutableSkillDef, SkillTest };
