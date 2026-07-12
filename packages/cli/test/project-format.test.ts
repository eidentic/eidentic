import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject, resolveProject } from "../src/commands.js";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type ModelResponse } from "@eidentic/types";
import { createTool } from "@eidentic/core";
import { z } from "zod";

describe("resolveProject", () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `eidentic-project-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
    root = realpathSync(root);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("keeps an existing eidentic.config.ts authoritative", () => {
    mkdirSync(join(root, "agent"));
    writeFileSync(join(root, "agent", "instructions.md"), "Directory instructions");
    writeFileSync(join(root, "eidentic.config.ts"), "export const agents = {};");

    expect(resolveProject(root)).toEqual({
      kind: "config",
      root,
      configPath: join(root, "eidentic.config.ts"),
    });
  });

  it("discovers an agent directory when no legacy config exists", () => {
    mkdirSync(join(root, "agent"));
    writeFileSync(join(root, "agent", "instructions.md"), "You are concise.\n");
    writeFileSync(join(root, "agent", "agent.ts"), "export default {};\n");

    expect(resolveProject(root)).toEqual({
      kind: "directory",
      root,
      agentRoot: join(root, "agent"),
      instructionsPath: join(root, "agent", "instructions.md"),
      agentModulePath: join(root, "agent", "agent.ts"),
    });
  });

  it("accepts an explicit agent directory", () => {
    const agentRoot = join(root, "custom-agent");
    mkdirSync(agentRoot);
    writeFileSync(join(agentRoot, "instructions.md"), "Custom");

    expect(resolveProject(root, agentRoot)).toMatchObject({
      kind: "directory",
      root,
      agentRoot,
      instructionsPath: join(agentRoot, "instructions.md"),
    });
  });

  it("returns null when neither supported project format exists", () => {
    expect(resolveProject(root)).toBeNull();
  });

  it("discovers supported tool modules in deterministic filename order", () => {
    mkdirSync(join(root, "agent", "tools"), { recursive: true });
    writeFileSync(join(root, "agent", "instructions.md"), "Tools");
    writeFileSync(join(root, "agent", "tools", "zeta.ts"), "export default {};\n");
    writeFileSync(join(root, "agent", "tools", "alpha.mjs"), "export default {};\n");
    writeFileSync(join(root, "agent", "tools", "notes.md"), "ignored");

    expect(resolveProject(root)).toMatchObject({
      kind: "directory",
      toolModulePaths: [
        join(root, "agent", "tools", "alpha.mjs"),
        join(root, "agent", "tools", "zeta.ts"),
      ],
    });
  });

  it("rejects a discovered tool symlink that escapes the project root", () => {
    const outside = join(tmpdir(), `eidentic-outside-tool-${Date.now()}.ts`);
    writeFileSync(outside, "export default {};\n");
    mkdirSync(join(root, "agent", "tools"), { recursive: true });
    writeFileSync(join(root, "agent", "instructions.md"), "Tools");
    symlinkSync(outside, join(root, "agent", "tools", "escape.ts"));
    try {
      expect(() => resolveProject(root)).toThrow(/outside.*project root/i);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("rejects an empty tools directory symlink that escapes the project root", () => {
    mkdirSync(join(root, "agent"));
    writeFileSync(join(root, "agent", "instructions.md"), "Safe instructions");
    const outside = join(tmpdir(), `eidentic-outside-tools-${Date.now()}`);
    mkdirSync(outside);
    symlinkSync(outside, join(root, "agent", "tools"));
    try {
      expect(() => resolveProject(root)).toThrow(/tools directory.*outside|outside.*project root/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects an instructions symlink that escapes the project root", () => {
    const outside = join(tmpdir(), `eidentic-outside-${Date.now()}.md`);
    writeFileSync(outside, "outside");
    mkdirSync(join(root, "agent"));
    symlinkSync(outside, join(root, "agent", "instructions.md"));

    try {
      expect(() => resolveProject(root)).toThrow(/outside|symlink|project root/i);
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

describe("loadProject directory mode", () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `eidentic-load-project-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, "agent"), { recursive: true });
    root = realpathSync(root);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const response: ModelResponse = {
    content: [{ type: "text", text: "hello" }],
    usage: { inputTokens: 1, outputTokens: 1 },
  };

  it("compiles instructions and a runtime definition into the existing EidenticConfig shape", async () => {
    writeFileSync(join(root, "agent", "instructions.md"), "  You are precise.  \n");
    writeFileSync(join(root, "agent", "agent.ts"), "export default {};\n");
    const project = resolveProject(root)!;

    const config = await loadProject(project, {
      importDirectoryModule: async () => ({
        id: "analyst",
        model: new MockModel([response]),
        store: new InMemoryStore(),
      }),
    });

    expect(Object.keys(config.agents)).toEqual(["analyst"]);
    const events = [];
    for await (const event of config.agents.analyst!.query("hi", { sessionId: "s1" })) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "result", output: "hello" });
  });

  it("exposes a lifecycle hook that closes the directory store", async () => {
    writeFileSync(join(root, "agent", "instructions.md"), "Close cleanly.");
    writeFileSync(join(root, "agent", "agent.ts"), "export default {};\n");
    const store = new InMemoryStore();
    let closed = false;
    store.close = async () => { closed = true; };

    const config = await loadProject(resolveProject(root)!, {
      importDirectoryModule: async () => ({ model: new MockModel([response]), store }),
    });
    await config.close?.();

    expect(closed).toBe(true);
  });

  it("closes the store when a discovered tool fails validation", async () => {
    mkdirSync(join(root, "agent", "tools"));
    writeFileSync(join(root, "agent", "instructions.md"), "Close after failure.");
    writeFileSync(join(root, "agent", "agent.ts"), "export default {};\n");
    writeFileSync(join(root, "agent", "tools", "broken.ts"), "export default {};\n");
    const store = new InMemoryStore();
    let closed = false;
    store.close = async () => { closed = true; };

    await expect(loadProject(resolveProject(root)!, {
      importDirectoryModule: async () => ({ model: new MockModel([response]), store }),
      importToolModule: async () => ({}),
    })).rejects.toThrow(/valid Eidentic tool|tool id/i);
    expect(closed).toBe(true);
  });

  it("rejects empty instructions", async () => {
    writeFileSync(join(root, "agent", "instructions.md"), " \n\t");
    writeFileSync(join(root, "agent", "agent.ts"), "export default {};\n");
    await expect(loadProject(resolveProject(root)!, {
      importDirectoryModule: async () => ({ model: new MockModel([response]), store: new InMemoryStore() }),
    })).rejects.toThrow(/instructions.*empty/i);
  });

  it("rejects oversized instructions before importing executable code", async () => {
    writeFileSync(join(root, "agent", "instructions.md"), "x".repeat(256 * 1024 + 1));
    writeFileSync(join(root, "agent", "agent.ts"), "export default {};\n");
    let imported = false;
    await expect(loadProject(resolveProject(root)!, {
      importDirectoryModule: async () => {
        imported = true;
        return { model: new MockModel([response]), store: new InMemoryStore() };
      },
    })).rejects.toThrow(/too large|256/i);
    expect(imported).toBe(false);
  });

  it("rejects runtime modules that try to override instructions", async () => {
    writeFileSync(join(root, "agent", "instructions.md"), "Canonical instructions");
    writeFileSync(join(root, "agent", "agent.ts"), "export default {};\n");
    await expect(loadProject(resolveProject(root)!, {
      importDirectoryModule: async () => ({
        instructions: "hidden override",
        model: new MockModel([response]),
        store: new InMemoryStore(),
      }),
    })).rejects.toThrow(/instructions.*must come from/i);
  });

  it("explains how to configure runtime defaults when agent.ts is absent", async () => {
    writeFileSync(join(root, "agent", "instructions.md"), "Canonical instructions");
    await expect(loadProject(resolveProject(root)!)).rejects.toThrow(/agent\.ts|model.*store/i);
  });

  it("loads discovered tools and makes them callable by the agent", async () => {
    mkdirSync(join(root, "agent", "tools"));
    writeFileSync(join(root, "agent", "instructions.md"), "Use the clock tool.");
    writeFileSync(join(root, "agent", "agent.ts"), "export default {};\n");
    writeFileSync(join(root, "agent", "tools", "clock.ts"), "export default {};\n");
    const clock = createTool({
      id: "clock",
      description: "Read the clock",
      inputSchema: z.object({}),
      sideEffect: "read-only",
      execute: async () => ({ now: "2026-07-12T00:00:00.000Z" }),
    });
    const model = new MockModel([
      { content: [toolUseBlock("call-1", "clock", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const importedTools: string[] = [];
    const config = await loadProject(resolveProject(root)!, {
      importDirectoryModule: async () => ({ model, store: new InMemoryStore() }),
      importToolModule: async (path) => { importedTools.push(path); return clock; },
    });
    const events = [];
    for await (const event of config.agents.agent!.query("time?", { sessionId: "tools" })) events.push(event);
    expect(importedTools).toEqual([join(root, "agent", "tools", "clock.ts")]);
    expect(events.some((event) => event.type === "tool.result")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "result", output: "done" });
  });

  it("auto-wires only secrets declared by directory tools", async () => {
    mkdirSync(join(root, "agent", "tools"));
    writeFileSync(join(root, "agent", "instructions.md"), "Use the API tool.");
    writeFileSync(join(root, "agent", "agent.ts"), "export default {};\n");
    writeFileSync(join(root, "agent", "tools", "api.ts"), "export default {};\n");
    const api = createTool({
      id: "api",
      description: "Use an API credential",
      inputSchema: z.object({}),
      requiredSecrets: ["SERVICE_TOKEN"],
      execute: async ({ ctx }) => ({ token: await ctx!.secrets!.require("SERVICE_TOKEN") }),
    });
    const model = new MockModel([
      { content: [toolUseBlock("call-1", "api", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const config = await loadProject(resolveProject(root)!, {
      env: { SERVICE_TOKEN: "directory-secret", UNDECLARED_TOKEN: "must-not-be-exposed" },
      importDirectoryModule: async () => ({ model, store: new InMemoryStore() }),
      importToolModule: async () => api,
    });

    const events = [];
    for await (const event of config.agents.agent!.query("call", { sessionId: "secret" })) events.push(event);

    expect(config.requiredSecrets).toEqual(["SERVICE_TOKEN"]);
    expect(JSON.stringify(events)).not.toContain("directory-secret");
    expect(events.find((event) => event.type === "tool.result")).toMatchObject({
      output: { token: "***" },
    });
  });

  it("preserves an explicitly configured secret provider", async () => {
    writeFileSync(join(root, "agent", "instructions.md"), "Use configured secrets.");
    writeFileSync(join(root, "agent", "agent.ts"), "export default {};\n");
    const api = createTool({
      id: "custom_api",
      description: "Use a custom vault",
      inputSchema: z.object({}),
      requiredSecrets: ["SERVICE_TOKEN"],
      execute: async ({ ctx }) => ({ present: Boolean(await ctx!.secrets!.get("SERVICE_TOKEN")) }),
    });
    const config = await loadProject(resolveProject(root)!, {
      env: { SERVICE_TOKEN: "environment-value" },
      importDirectoryModule: async () => ({
        model: new MockModel([response]),
        store: new InMemoryStore(),
        tools: [api],
        secrets: { get: async () => "custom-value" },
      }),
    });

    expect(config.requiredSecrets).toEqual([]);
  });
});
