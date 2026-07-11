import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject, INIT_PROVIDERS } from "../src/commands.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `eidentic-init-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// initProject — anthropic (default)
// ---------------------------------------------------------------------------

describe("initProject() — default (anthropic)", () => {
  it("creates all 5 files on a fresh directory", () => {
    const { created, skipped } = initProject(tmpDir);

    expect(skipped).toHaveLength(0);

    // All expected files should have been created
    const expectedFiles = ["eidentic.config.ts", "src/agent.ts", ".env.example", ".env", ".gitignore"];
    for (const f of expectedFiles) {
      expect(existsSync(join(tmpDir, f)), `${f} should exist`).toBe(true);
    }

    // created list should mention each file (some may have extra annotation like "(appended .env)")
    const createdFlat = created.join(" ");
    expect(createdFlat).toContain("eidentic.config.ts");
    expect(createdFlat).toContain("src/agent.ts");
    expect(createdFlat).toContain(".env.example");
    expect(createdFlat).toContain(".env");
    expect(createdFlat).toContain(".gitignore");
  });

  it("eidentic.config.ts exports agents and reads from env", () => {
    initProject(tmpDir);
    const config = readFileSync(join(tmpDir, "eidentic.config.ts"), "utf8");
    expect(config).toContain("export const agents");
    expect(config).toContain("ANTHROPIC_API_KEY");
    expect(config).toContain("anthropic(");
    // Sample tool must be present so a fresh agent shows a tool in Studio
    expect(config).toContain("createTool");
    expect(config).toContain("get_time");
    expect(config).toContain("tools: [getTime]");
  });

  it(".env contains ANTHROPIC_API_KEY", () => {
    initProject(tmpDir);
    const env = readFileSync(join(tmpDir, ".env"), "utf8");
    expect(env).toContain("ANTHROPIC_API_KEY");
  });

  it(".env.example contains ANTHROPIC_API_KEY", () => {
    initProject(tmpDir);
    const envEx = readFileSync(join(tmpDir, ".env.example"), "utf8");
    expect(envEx).toContain("ANTHROPIC_API_KEY");
  });

  it(".gitignore contains .env", () => {
    initProject(tmpDir);
    const gi = readFileSync(join(tmpDir, ".gitignore"), "utf8");
    expect(gi).toContain(".env");
  });

  it("src/agent.ts has loadEnvFile and anthropic import", () => {
    initProject(tmpDir);
    const agent = readFileSync(join(tmpDir, "src/agent.ts"), "utf8");
    expect(agent).toContain("loadEnvFile");
    expect(agent).toContain("anthropic");
  });
});

describe("initProject() — directory format", () => {
  it("creates a readable agent directory without a competing legacy config", () => {
    const result = initProject(tmpDir, { format: "directory" });
    expect(result.skipped).toHaveLength(0);
    expect(existsSync(join(tmpDir, "agent", "instructions.md"))).toBe(true);
    expect(existsSync(join(tmpDir, "agent", "agent.ts"))).toBe(true);
    expect(existsSync(join(tmpDir, "agent", "tools", "get-time.ts"))).toBe(true);
    expect(existsSync(join(tmpDir, "eidentic.config.ts"))).toBe(false);
    expect(existsSync(join(tmpDir, "src", "agent.ts"))).toBe(false);
  });

  it("keeps instructions, runtime configuration, and tools in separate files", () => {
    initProject(tmpDir, { format: "directory", provider: "openai", model: "gpt-4o-mini" });
    expect(readFileSync(join(tmpDir, "agent", "instructions.md"), "utf8"))
      .toContain("helpful assistant");
    const runtime = readFileSync(join(tmpDir, "agent", "agent.ts"), "utf8");
    expect(runtime).toContain('openai("gpt-4o-mini")');
    expect(runtime).toContain("export default");
    expect(runtime).not.toContain("createTool");
    const tool = readFileSync(join(tmpDir, "agent", "tools", "get-time.ts"), "utf8");
    expect(tool).toContain("createTool");
    expect(tool).toContain('id: "get_time"');
  });

  it("is idempotent for directory projects", () => {
    initProject(tmpDir, { format: "directory" });
    const second = initProject(tmpDir, { format: "directory" });
    expect(second.skipped).toEqual(expect.arrayContaining([
      "agent/instructions.md", "agent/agent.ts", "agent/tools/get-time.ts", ".env",
    ]));
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("initProject() — idempotent", () => {
  it("second call skips all files", () => {
    const first = initProject(tmpDir);
    expect(first.created.length).toBeGreaterThan(0);

    const second = initProject(tmpDir);
    // All core files should be skipped
    const skippedFlat = second.skipped.join(" ");
    expect(skippedFlat).toContain("eidentic.config.ts");
    expect(skippedFlat).toContain("src/agent.ts");
    expect(skippedFlat).toContain(".env.example");
    expect(skippedFlat).toContain(".env");
  });

  it("does not modify existing file contents on second call", () => {
    initProject(tmpDir);
    const configBefore = readFileSync(join(tmpDir, "eidentic.config.ts"), "utf8");
    initProject(tmpDir);
    const configAfter = readFileSync(join(tmpDir, "eidentic.config.ts"), "utf8");
    expect(configAfter).toBe(configBefore);
  });
});

// ---------------------------------------------------------------------------
// Provider support
// ---------------------------------------------------------------------------

describe("initProject() — openai provider", () => {
  it("writes openai import and OPENAI_API_KEY", () => {
    initProject(tmpDir, { provider: "openai" });

    const config = readFileSync(join(tmpDir, "eidentic.config.ts"), "utf8");
    expect(config).toContain("OPENAI_API_KEY");
    expect(config).toContain("openai(");

    const env = readFileSync(join(tmpDir, ".env"), "utf8");
    expect(env).toContain("OPENAI_API_KEY");

    const agent = readFileSync(join(tmpDir, "src/agent.ts"), "utf8");
    expect(agent).toContain("openai");
  });
});

describe("initProject() — google provider", () => {
  it("writes google import and GOOGLE_GENERATIVE_AI_API_KEY", () => {
    initProject(tmpDir, { provider: "google" });

    const config = readFileSync(join(tmpDir, "eidentic.config.ts"), "utf8");
    expect(config).toContain("GOOGLE_GENERATIVE_AI_API_KEY");
    expect(config).toContain("google(");
  });
});

// ---------------------------------------------------------------------------
// model option
// ---------------------------------------------------------------------------

describe("initProject() — model option", () => {
  it("uses the specified model id in eidentic.config.ts and src/agent.ts", () => {
    initProject(tmpDir, { model: "claude-haiku-4-5" });

    const config = readFileSync(join(tmpDir, "eidentic.config.ts"), "utf8");
    expect(config).toContain('anthropic("claude-haiku-4-5")');

    const agent = readFileSync(join(tmpDir, "src/agent.ts"), "utf8");
    expect(agent).toContain('anthropic("claude-haiku-4-5")');
  });

  it("uses provider default model when model is not specified", () => {
    initProject(tmpDir, { provider: "anthropic" });
    const config = readFileSync(join(tmpDir, "eidentic.config.ts"), "utf8");
    expect(config).toContain(`anthropic("${INIT_PROVIDERS.anthropic.modelId}")`);
  });

  it("uses specified model with openai provider", () => {
    initProject(tmpDir, { provider: "openai", model: "gpt-4o-mini" });
    const config = readFileSync(join(tmpDir, "eidentic.config.ts"), "utf8");
    expect(config).toContain('openai("gpt-4o-mini")');
    const agent = readFileSync(join(tmpDir, "src/agent.ts"), "utf8");
    expect(agent).toContain('openai("gpt-4o-mini")');
  });
});

// ---------------------------------------------------------------------------
// apiKey option
// ---------------------------------------------------------------------------

describe("initProject() — apiKey option", () => {
  it("creates .env with owner-only permissions", () => {
    initProject(tmpDir, { apiKey: "sk-test-key-123" });
    expect(statSync(join(tmpDir, ".env")).mode & 0o777).toBe(0o600);
  });

  it("rejects line breaks in apiKey values before creating project files", () => {
    expect(() => initProject(tmpDir, {
      apiKey: "safe\nINJECTED_KEY=attacker",
    })).toThrow(/line break|invalid/i);
    expect(existsSync(join(tmpDir, ".env"))).toBe(false);
  });

  it("writes the key into .env when apiKey is provided", () => {
    initProject(tmpDir, { apiKey: "sk-test-key-123" });

    const env = readFileSync(join(tmpDir, ".env"), "utf8");
    expect(env).toBe("ANTHROPIC_API_KEY=sk-test-key-123\n");
  });

  it("ensures .gitignore contains .env BEFORE writing the key", () => {
    initProject(tmpDir, { apiKey: "sk-test-key-123" });

    // .gitignore must exist and contain .env
    const gi = readFileSync(join(tmpDir, ".gitignore"), "utf8");
    expect(gi).toContain(".env");

    // The key must be in .env
    const env = readFileSync(join(tmpDir, ".env"), "utf8");
    expect(env).toContain("sk-test-key-123");
  });

  it(".env.example always has empty value even when apiKey is provided", () => {
    initProject(tmpDir, { apiKey: "sk-test-key-123" });

    const envEx = readFileSync(join(tmpDir, ".env.example"), "utf8");
    expect(envEx).toContain("ANTHROPIC_API_KEY=");
    expect(envEx).not.toContain("sk-test-key-123");
  });

  it("writes empty value in .env when apiKey is not provided", () => {
    initProject(tmpDir);
    const env = readFileSync(join(tmpDir, ".env"), "utf8");
    expect(env).toBe("ANTHROPIC_API_KEY=\n");
  });

  it("writes openai key with correct env var name", () => {
    initProject(tmpDir, { provider: "openai", apiKey: "sk-openai-test" });
    const env = readFileSync(join(tmpDir, ".env"), "utf8");
    expect(env).toBe("OPENAI_API_KEY=sk-openai-test\n");
  });
});

// ---------------------------------------------------------------------------
// INIT_PROVIDERS map
// ---------------------------------------------------------------------------

describe("INIT_PROVIDERS", () => {
  it("each provider has a non-empty models array", () => {
    for (const [name, meta] of Object.entries(INIT_PROVIDERS)) {
      expect(Array.isArray(meta.models), `${name}.models should be an array`).toBe(true);
      expect(meta.models.length, `${name}.models should not be empty`).toBeGreaterThan(0);
    }
  });

  it("each provider's default modelId is in its models list", () => {
    for (const [name, meta] of Object.entries(INIT_PROVIDERS)) {
      expect(meta.models, `${name}.modelId should be in models list`).toContain(meta.modelId);
    }
  });
});

// ---------------------------------------------------------------------------
// .gitignore edge cases
// ---------------------------------------------------------------------------

describe("initProject() — .gitignore edge cases", () => {
  it("appends .env to an existing .gitignore that lacks it", () => {
    const giPath = join(tmpDir, ".gitignore");
    // write a gitignore without .env
    require("node:fs").writeFileSync(giPath, "node_modules\ndist\n");

    const { created } = initProject(tmpDir);
    const gi = readFileSync(giPath, "utf8");
    expect(gi).toContain(".env");
    // created should mention .gitignore with "appended"
    expect(created.join(" ")).toContain("appended");
  });

  it("skips .gitignore that already contains .env", () => {
    const giPath = join(tmpDir, ".gitignore");
    require("node:fs").writeFileSync(giPath, "node_modules\n.env\ndist\n");

    const { skipped } = initProject(tmpDir);
    // .gitignore should be in skipped (content unchanged)
    expect(skipped.join(" ")).toContain(".gitignore");
    // content should be unchanged
    const gi = readFileSync(giPath, "utf8");
    expect(gi).toBe("node_modules\n.env\ndist\n");
  });
});
