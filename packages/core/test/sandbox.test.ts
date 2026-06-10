import { describe, it, expect } from "vitest";
import { NoopSandbox } from "../src/sandbox.js";
import { Agent } from "../src/agent.js";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock } from "@eidentic/types";

describe("NoopSandbox (secure default, §10.7)", () => {
  it("refuses by default with an error result (exitCode 1, no throw)", async () => {
    const sb = new NoopSandbox();
    const r = await sb.run("console.log('untrusted')");
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(r.error).toMatch(/no sandbox configured/i);
    expect(r.error).toMatch(/refusing to execute untrusted code/i);
    expect(r.error).toMatch(/@eidentic\/e2b/);
  });

  it("throws instead of returning a result when throwOnRun is set", async () => {
    const sb = new NoopSandbox({ throwOnRun: true });
    await expect(sb.run("rm -rf /")).rejects.toThrow(/no sandbox configured/i);
  });

  it("refuses regardless of language / options", async () => {
    const sb = new NoopSandbox();
    const r = await sb.run("print('x')", { language: "python", timeoutMs: 5_000 });
    expect(r.exitCode).toBe(1);
    expect(r.error).toBeDefined();
  });
});

describe("Fix 3 — AgentConfig.sandbox defaulting to NoopSandbox", () => {
  it("Agent.sandbox returns a NoopSandbox that refuses (exitCode 1) when no sandbox configured", async () => {
    const store = new InMemoryStore(); await store.migrate();
    const model = new MockModel([{ content: [textBlock("hi")], usage: { inputTokens: 1, outputTokens: 1 } }]);
    const agent = new Agent({
      id: "a", instructions: "", model, store,
      now: () => "t", newId: ((n) => () => `e${n++}`)(0),
    });
    const sb = agent.sandbox;
    const result = await sb.run("untrusted code");
    expect(result.exitCode).toBe(1);
    expect(result.error).toMatch(/no sandbox configured/i);
  });

  it("Agent.sandbox returns the configured sandbox when one is provided", async () => {
    const store = new InMemoryStore(); await store.migrate();
    const model = new MockModel([{ content: [textBlock("hi")], usage: { inputTokens: 1, outputTokens: 1 } }]);
    const customSandbox = new NoopSandbox({ throwOnRun: false });
    const agent = new Agent({
      id: "a2", instructions: "", model, store,
      sandbox: customSandbox,
      now: () => "t", newId: ((n) => () => `e${n++}`)(0),
    });
    expect(agent.sandbox).toBe(customSandbox);
  });
});
