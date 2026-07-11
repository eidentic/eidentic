import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProject } from "../src/commands.js";

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
