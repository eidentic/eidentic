import { describe, it, expect, afterEach } from "vitest";
import { scaffold } from "../src/scaffold.js";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let cleanup: string | undefined;
afterEach(() => {
  if (cleanup && existsSync(cleanup)) rmSync(cleanup, { recursive: true, force: true });
  cleanup = undefined;
});

describe("create-eidentic scaffold", () => {
  it("writes the full project template", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "app");
    const files = scaffold(dir, { name: "app" });

    for (const f of ["package.json", "tsconfig.json", "src/agent.ts", ".env.example", ".gitignore", "README.md"]) {
      expect(files).toContain(f);
      expect(existsSync(join(dir, f))).toBe(true);
    }

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.name).toBe("app");
    expect(pkg.dependencies.eidentic).toBeDefined();
    expect(pkg.scripts.dev).toBe("tsx src/agent.ts");

    const agent = readFileSync(join(dir, "src/agent.ts"), "utf8");
    expect(agent).toContain('from "eidentic"');
  });

  it("refuses to clobber a non-empty target", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "app");
    scaffold(dir, {});
    expect(() => scaffold(dir, {})).toThrow(/not empty/);
  });

  it("uses anthropic provider by default (no provider option)", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "app");
    scaffold(dir, {});

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.dependencies["@ai-sdk/anthropic"]).toBeDefined();
    expect(pkg.dependencies["@ai-sdk/openai"]).toBeUndefined();

    const env = readFileSync(join(dir, ".env.example"), "utf8");
    expect(env).toContain("ANTHROPIC_API_KEY");

    const agent = readFileSync(join(dir, "src/agent.ts"), "utf8");
    expect(agent).toContain('from "@ai-sdk/anthropic"');
    expect(agent).toContain("claude-sonnet-4-5");
  });

  it("openai provider produces correct dep, env var, and import", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "app");
    scaffold(dir, { provider: "openai" });

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.dependencies["@ai-sdk/openai"]).toBeDefined();
    expect(pkg.dependencies["@ai-sdk/anthropic"]).toBeUndefined();

    const env = readFileSync(join(dir, ".env.example"), "utf8");
    expect(env).toContain("OPENAI_API_KEY");

    const agent = readFileSync(join(dir, "src/agent.ts"), "utf8");
    expect(agent).toContain('from "@ai-sdk/openai"');
    expect(agent).toContain("gpt-4o");
  });

  it("google provider produces correct dep, env var, and import", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "app");
    scaffold(dir, { provider: "google" });

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.dependencies["@ai-sdk/google"]).toBeDefined();

    const env = readFileSync(join(dir, ".env.example"), "utf8");
    expect(env).toContain("GOOGLE_GENERATIVE_AI_API_KEY");

    const agent = readFileSync(join(dir, "src/agent.ts"), "utf8");
    expect(agent).toContain('from "@ai-sdk/google"');
    expect(agent).toContain("gemini-2.5-pro");
  });
});

describe("create-eidentic nextjs-chat template", () => {
  it("writes all expected nextjs-chat files", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "nextjs-app");
    const files = scaffold(dir, { name: "nextjs-app", template: "nextjs-chat" });

    const expectedFiles = [
      "package.json",
      "tsconfig.json",
      "next.config.ts",
      "app/api/chat/route.ts",
      "app/page.tsx",
      ".env.local.example",
      ".gitignore",
      "README.md",
    ];

    for (const f of expectedFiles) {
      expect(files, `files list should contain ${f}`).toContain(f);
      expect(existsSync(join(dir, f)), `${f} should exist on disk`).toBe(true);
    }
  });

  it("nextjs-chat package.json has correct eidentic and next deps", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "nextjs-app");
    scaffold(dir, { name: "nextjs-app", template: "nextjs-chat" });

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.name).toBe("nextjs-app");
    expect(pkg.dependencies.eidentic).toBeDefined();
    expect(pkg.dependencies["@eidentic/nextjs"]).toBeDefined();
    expect(pkg.dependencies["@eidentic/libsql"]).toBeDefined();
    expect(pkg.dependencies["@ai-sdk/react"]).toBeDefined();
    expect(pkg.dependencies["@ai-sdk/anthropic"]).toBeDefined();
    expect(pkg.dependencies.next).toBeDefined();
    expect(pkg.dependencies.react).toBeDefined();
    expect(pkg.dependencies["react-dom"]).toBeDefined();
    expect(pkg.scripts.dev).toBe("next dev");
  });

  it("nextjs-chat route uses withEidentic, LibsqlStore, AIModel, and runtime=nodejs", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "nextjs-app");
    scaffold(dir, { template: "nextjs-chat" });

    const route = readFileSync(join(dir, "app/api/chat/route.ts"), "utf8");
    expect(route).toContain('from "@eidentic/nextjs"');
    expect(route).toContain("withEidentic");
    expect(route).toContain("LibsqlStore");
    expect(route).toContain("AIModel");
    expect(route).toContain('export const runtime = "nodejs"');
    expect(route).toContain("export const POST = withEidentic(agent)");
  });

  it("nextjs-chat page uses useChat from @ai-sdk/react", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "nextjs-app");
    scaffold(dir, { template: "nextjs-chat" });

    const page = readFileSync(join(dir, "app/page.tsx"), "utf8");
    expect(page).toContain('"use client"');
    expect(page).toContain('from "@ai-sdk/react"');
    expect(page).toContain("useChat");
    expect(page).toContain('api: "/api/chat"');
  });

  it("nextjs-chat next.config.ts uses eidenticNextConfig", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "nextjs-app");
    scaffold(dir, { template: "nextjs-chat" });

    const config = readFileSync(join(dir, "next.config.ts"), "utf8");
    expect(config).toContain("eidenticNextConfig");
    expect(config).toContain('from "@eidentic/nextjs"');
  });

  it("nextjs-chat .env.local.example contains ANTHROPIC_API_KEY", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "nextjs-app");
    scaffold(dir, { template: "nextjs-chat" });

    const env = readFileSync(join(dir, ".env.local.example"), "utf8");
    expect(env).toContain("ANTHROPIC_API_KEY");
  });

  it("nextjs-chat template does NOT write src/agent.ts or .env.example", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "nextjs-app");
    const files = scaffold(dir, { template: "nextjs-chat" });

    expect(files).not.toContain("src/agent.ts");
    expect(files).not.toContain(".env.example");
  });

  it("default template is unaffected when template is omitted", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "default-app");
    const files = scaffold(dir, {});

    expect(files).toContain("src/agent.ts");
    expect(files).not.toContain("app/api/chat/route.ts");
  });

  it("nextjs-chat route contains await store.migrate() call", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "nextjs-app");
    scaffold(dir, { template: "nextjs-chat" });

    const route = readFileSync(join(dir, "app/api/chat/route.ts"), "utf8");
    expect(route).toContain("await store.migrate()");
  });

  it("nextjs-chat route is syntactically valid (migrate appears after store construction)", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "nextjs-app");
    scaffold(dir, { template: "nextjs-chat" });

    const route = readFileSync(join(dir, "app/api/chat/route.ts"), "utf8");
    const storeIdx = route.indexOf("new LibsqlStore(");
    const migrateIdx = route.indexOf("await store.migrate()");
    // migrate() must appear after the store is constructed
    expect(storeIdx).toBeGreaterThanOrEqual(0);
    expect(migrateIdx).toBeGreaterThanOrEqual(0);
    expect(migrateIdx).toBeGreaterThan(storeIdx);
  });

  it("nextjs-chat route with google provider uses gemini-2.5-pro", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "nextjs-app");
    scaffold(dir, { template: "nextjs-chat", provider: "google" });

    const route = readFileSync(join(dir, "app/api/chat/route.ts"), "utf8");
    expect(route).toContain("gemini-2.5-pro");
    expect(route).not.toContain("gemini-2.0-flash");
  });

  it("nextjs-chat with openai provider injects correct import and model", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "nextjs-app");
    scaffold(dir, { template: "nextjs-chat", provider: "openai" });

    const route = readFileSync(join(dir, "app/api/chat/route.ts"), "utf8");
    expect(route).toContain('from "@ai-sdk/openai"');
    expect(route).toContain("gpt-4o");

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.dependencies["@ai-sdk/openai"]).toBeDefined();
    expect(pkg.dependencies["@ai-sdk/anthropic"]).toBeUndefined();

    const env = readFileSync(join(dir, ".env.local.example"), "utf8");
    expect(env).toContain("OPENAI_API_KEY");
  });
});

describe("create-eidentic bun-agent template", () => {
  it("writes all expected bun-agent files", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "bun-app");
    const files = scaffold(dir, { name: "bun-app", template: "bun-agent" });

    const expectedFiles = [
      "package.json",
      "tsconfig.json",
      "bunfig.toml",
      "src/server.ts",
      ".env.example",
      ".gitignore",
      "README.md",
    ];
    for (const f of expectedFiles) {
      expect(files, `files list should contain ${f}`).toContain(f);
      expect(existsSync(join(dir, f)), `${f} should exist on disk`).toBe(true);
    }
  });

  it("bun-agent package.json has bun-native scripts and correct deps", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "bun-app");
    scaffold(dir, { name: "bun-app", template: "bun-agent" });

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.name).toBe("bun-app");
    expect(pkg.scripts.dev).toContain("bun run");
    expect(pkg.scripts.start).toContain("bun run");
    expect(pkg.dependencies.eidentic).toBeDefined();
    expect(pkg.dependencies["@eidentic/server"]).toBeDefined();
    expect(pkg.dependencies["@eidentic/libsql"]).toBeDefined();
    expect(pkg.dependencies["@ai-sdk/anthropic"]).toBeDefined();
    expect(pkg.devDependencies["bun-types"]).toBeDefined();
    expect(pkg.devDependencies.typescript).toBeDefined();
  });

  it("bun-agent server uses Bun.serve, createServer, LibsqlStore, and AIModel", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "bun-app");
    scaffold(dir, { template: "bun-agent" });

    const server = readFileSync(join(dir, "src/server.ts"), "utf8");
    expect(server).toContain("Bun.serve");
    expect(server).toContain("createServer");
    expect(server).toContain("LibsqlStore");
    expect(server).toContain("AIModel");
    expect(server).toContain('from "@eidentic/server"');
    expect(server).toContain('from "@eidentic/libsql"');
    expect(server).toContain("await store.migrate()");
  });

  it("bun-agent server contains await store.migrate() after LibsqlStore construction", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "bun-app");
    scaffold(dir, { template: "bun-agent" });

    const server = readFileSync(join(dir, "src/server.ts"), "utf8");
    const storeIdx = server.indexOf("new LibsqlStore(");
    const migrateIdx = server.indexOf("await store.migrate()");
    expect(storeIdx).toBeGreaterThanOrEqual(0);
    expect(migrateIdx).toBeGreaterThanOrEqual(0);
    expect(migrateIdx).toBeGreaterThan(storeIdx);
  });

  it("bun-agent tsconfig.json includes bun-types", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "bun-app");
    scaffold(dir, { template: "bun-agent" });

    const tsconfig = readFileSync(join(dir, "tsconfig.json"), "utf8");
    expect(tsconfig).toContain("bun-types");
  });

  it("bun-agent .env.example contains the provider API key var", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "bun-app");
    scaffold(dir, { template: "bun-agent" });

    const env = readFileSync(join(dir, ".env.example"), "utf8");
    expect(env).toContain("ANTHROPIC_API_KEY");
  });

  it("bun-agent with openai provider injects correct import and model", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "bun-app");
    scaffold(dir, { template: "bun-agent", provider: "openai" });

    const server = readFileSync(join(dir, "src/server.ts"), "utf8");
    expect(server).toContain('from "@ai-sdk/openai"');
    expect(server).toContain("gpt-4o");

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.dependencies["@ai-sdk/openai"]).toBeDefined();
    expect(pkg.dependencies["@ai-sdk/anthropic"]).toBeUndefined();

    const env = readFileSync(join(dir, ".env.example"), "utf8");
    expect(env).toContain("OPENAI_API_KEY");
  });

  it("bun-agent template does NOT write nextjs files", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "bun-app");
    const files = scaffold(dir, { template: "bun-agent" });

    expect(files).not.toContain("next.config.ts");
    expect(files).not.toContain("app/api/chat/route.ts");
    expect(existsSync(join(dir, "next.config.ts"))).toBe(false);
  });

  it("default template is unaffected by the bun-agent template", () => {
    cleanup = mkdtempSync(join(tmpdir(), "eidentic-"));
    const dir = join(cleanup, "default-app");
    const files = scaffold(dir, {});

    expect(files).toContain("src/agent.ts");
    expect(files).not.toContain("src/server.ts");
    expect(files).not.toContain("bunfig.toml");
  });
});
