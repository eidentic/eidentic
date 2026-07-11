import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { EchoSandbox } from "@eidentic/types/testing";
import { NoopSandbox } from "@eidentic/core";
import { bashTool } from "../src/index.js";

describe("bashTool (sealed shell, §5.6)", () => {
  it("runs a command via the injected sandbox and returns stdout/exitCode", async () => {
    const t = bashTool(new EchoSandbox());
    const out = (await t.execute({ command: "echo hi" })) as { stdout: string; exitCode: number };
    expect(out.stdout).toBe("hi");
    expect(out.exitCode).toBe(0);
  });

  it("is destructive and carries NO idempotencyKey (arbitrary shell is non-idempotent)", () => {
    const t = bashTool(new EchoSandbox());
    expect(t.sideEffect).toBe("destructive");
    expect(t.idempotencyKey).toBeUndefined();
  });

  it("REFUSES under NoopSandbox (secure default) — surfaces refusal as a tool error", async () => {
    const t = bashTool(new NoopSandbox());
    await expect(t.execute({ command: "rm -rf /" })).rejects.toThrow(/refus/i);
  });

  it("passes timeoutMs and language:bash through to the sandbox", async () => {
    const calls: Array<{ code: string; opts: unknown }> = [];
    const spy = { run: async (code: string, o?: unknown) => { calls.push({ code, opts: o }); return { stdout: code, stderr: "", exitCode: 0 }; } };
    const t = bashTool(spy, { timeoutMs: 5000 });
    await t.execute({ command: "ls" });
    expect(calls[0]!.opts).toMatchObject({ language: "bash", timeoutMs: 5000 });
  });

  it("forwards the tool context AbortSignal to the sandbox", async () => {
    let seenSignal: AbortSignal | undefined;
    const spy = {
      run: async (_code: string, options?: { signal?: AbortSignal }) => {
        seenSignal = options?.signal;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const controller = new AbortController();
    const tool = bashTool(spy);
    await tool.execute({ command: "sleep 1" }, { signal: controller.signal });
    expect(seenSignal).toBe(controller.signal);
  });

  it("never imports node:child_process (host exec is forbidden by §5.6)", async () => {
    const src = await readFile(fileURLToPath(new URL("../src/bash-tool.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/child_process/);
    expect(src).not.toMatch(/node:child_process/);
  });
});
