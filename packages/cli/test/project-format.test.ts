import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject, resolveProject } from "../src/commands.js";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import type { ModelResponse } from "@eidentic/types";

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
});
