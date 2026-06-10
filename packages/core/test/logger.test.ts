import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type StreamEvent } from "@eidentic/types";
import { createTool } from "../src/tool.js";
import { Agent } from "../src/agent.js";
import { envLogger, redactFields, NoopLogger } from "../src/logger.js";
import type { LogLevel, LogFields, LoggerPort } from "../src/logger.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

async function run(agent: Agent, input: string, sessionId: string): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of agent.query(input, { sessionId })) out.push(e);
  return out;
}

function captureLogger(): LoggerPort & { calls: { level: LogLevel; ns: string; msg: string; fields?: LogFields }[] } {
  const calls: { level: LogLevel; ns: string; msg: string; fields?: LogFields }[] = [];
  return {
    calls,
    log(level: LogLevel, ns: string, msg: string, fields?: LogFields): void {
      calls.push({ level, ns, msg, fields });
    },
    enabled(_level: LogLevel, _ns: string): boolean {
      return true; // capture everything
    },
  };
}

// ─── envLogger: DEBUG parsing ─────────────────────────────────────────────────

describe("envLogger DEBUG parsing", () => {
  const savedDebug = process.env["DEBUG"];
  afterEach(() => {
    if (savedDebug === undefined) delete process.env["DEBUG"];
    else process.env["DEBUG"] = savedDebug;
  });

  it("exact namespace: enabled for the exact match, not others", () => {
    process.env["DEBUG"] = "eidentic:loop";
    const logger = envLogger();
    expect(logger.enabled!("debug", "eidentic:loop")).toBe(true);
    expect(logger.enabled!("debug", "eidentic:tool")).toBe(false);
    expect(logger.enabled!("info", "eidentic:loop")).toBe(true);
  });

  it("glob eidentic:* enables all eidentic: namespaces", () => {
    process.env["DEBUG"] = "eidentic:*";
    const logger = envLogger();
    expect(logger.enabled!("debug", "eidentic:loop")).toBe(true);
    expect(logger.enabled!("debug", "eidentic:tool")).toBe(true);
    expect(logger.enabled!("debug", "eidentic:permission")).toBe(true);
    expect(logger.enabled!("debug", "other:namespace")).toBe(false);
  });

  it("* glob enables everything", () => {
    process.env["DEBUG"] = "*";
    const logger = envLogger();
    expect(logger.enabled!("debug", "eidentic:loop")).toBe(true);
    expect(logger.enabled!("debug", "anything")).toBe(true);
  });

  it("warn and error are always enabled regardless of DEBUG", () => {
    process.env["DEBUG"] = "";
    const logger = envLogger();
    expect(logger.enabled!("warn", "eidentic:loop")).toBe(true);
    expect(logger.enabled!("error", "eidentic:loop")).toBe(true);
    expect(logger.enabled!("debug", "eidentic:loop")).toBe(false);
  });

  it("DEBUG unset: debug/info disabled, warn/error enabled", () => {
    delete process.env["DEBUG"];
    const logger = envLogger();
    expect(logger.enabled!("debug", "eidentic:loop")).toBe(false);
    expect(logger.enabled!("info", "eidentic:loop")).toBe(false);
    expect(logger.enabled!("warn", "eidentic:loop")).toBe(true);
    expect(logger.enabled!("error", "eidentic:anything")).toBe(true);
  });

  it("comma-separated list: each namespace matched independently", () => {
    process.env["DEBUG"] = "eidentic:loop,eidentic:tool";
    const logger = envLogger();
    expect(logger.enabled!("debug", "eidentic:loop")).toBe(true);
    expect(logger.enabled!("debug", "eidentic:tool")).toBe(true);
    expect(logger.enabled!("debug", "eidentic:permission")).toBe(false);
  });
});

// ─── redactFields ──────────────────────────────────────────────────────────────

describe("redactFields", () => {
  it("masks fields whose key matches the secret pattern", () => {
    const result = redactFields({
      apiKey: "sk-123",
      authorization: "Bearer x",
      city: "Istanbul",
      token: "abc",
      password: "hunter2",
      api_key: "somekey",
    });
    expect(result["apiKey"]).toBe("***");
    expect(result["authorization"]).toBe("***");
    expect(result["city"]).toBe("Istanbul");
    expect(result["token"]).toBe("***");
    expect(result["password"]).toBe("***");
    expect(result["api_key"]).toBe("***");
  });

  it("masks string values that start with sk-", () => {
    const result = redactFields({ model: "sk-proj-abc123", name: "myagent" });
    expect(result["model"]).toBe("***");
    expect(result["name"]).toBe("myagent");
  });

  it("masks string values that start with 'Bearer '", () => {
    const result = redactFields({ auth: "Bearer eyJhbGc...", host: "example.com" });
    expect(result["auth"]).toBe("***");
    expect(result["host"]).toBe("example.com");
  });

  it("does not mutate the original object", () => {
    const original = { apiKey: "secret", city: "Berlin" };
    redactFields(original);
    expect(original["apiKey"]).toBe("secret");
  });

  it("passes through non-string values on safe keys unchanged", () => {
    const result = redactFields({ count: 42, enabled: true, data: { x: 1 } });
    expect(result["count"]).toBe(42);
    expect(result["enabled"]).toBe(true);
    expect(result["data"]).toEqual({ x: 1 });
  });
});

// ─── Finding #9: cycle guard + broader VALUE_SECRET_RE patterns ───────────────

describe("redactFields — cycle guard (Finding #9)", () => {
  it("does not hang or throw on a cyclic object reference", () => {
    // Build a deliberately cyclic structure: a.self = a
    type Cyclic = { self?: Cyclic; note: string };
    const a: Cyclic = { note: "hello" };
    a.self = a;

    // Must complete in finite time without throwing.
    expect(() => redactFields(a as unknown as LogFields)).not.toThrow();
  });

  it("does not hang on a cyclic array reference", () => {
    // Build an array that references itself.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const arr: any[] = ["safe"];
    arr.push(arr); // arr[1] = arr
    expect(() => redactFields({ items: arr as unknown as LogFields[string] })).not.toThrow();
  });

  it("returns a sentinel (not the original cycle) for the cyclic node", () => {
    type Cyclic = { self?: Cyclic; note: string };
    const a: Cyclic = { note: "hello" };
    a.self = a;
    const result = redactFields(a as unknown as LogFields);
    // The top-level 'note' key should pass through
    expect(result["note"]).toBe("hello");
    // The cyclic 'self' key should be replaced with a sentinel string, not the original object
    expect(typeof result["self"]).toBe("string");
  });
});

describe("redactFields — broader VALUE_SECRET_RE patterns (Finding #9)", () => {
  it("redacts JWT-like values (eyJ prefix)", () => {
    const result = redactFields({ debug: "eyJhbGciOiJSUzI1NiJ9.payload.sig" });
    expect(result["debug"]).toBe("***");
  });

  it("redacts AWS access key IDs (AKIA prefix)", () => {
    const result = redactFields({ info: "key is AKIAIOSFODNN7EXAMPLE" });
    expect(result["info"]).toBe("***");
  });

  it("redacts Slack bot tokens (xoxb-)", () => {
    const result = redactFields({ slackToken: "xoxb-abc123-xyz" });
    // 'slackToken' key hits KEY_SECRET_RE too — both paths should redact
    expect(result["slackToken"]).toBe("***");
  });

  it("redacts Slack tokens via value match on a safe-named key", () => {
    const result = redactFields({ metadata: "xoxp-abcdef-123456" });
    expect(result["metadata"]).toBe("***");
  });

  it("redacts GitHub personal access tokens (ghp_)", () => {
    const result = redactFields({ info: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
    expect(result["info"]).toBe("***");
  });

  it("redacts GitHub OAuth tokens (gho_)", () => {
    const result = redactFields({ token: "gho_abcdefghijklmnopqrstuvwxyz" });
    // 'token' key hits KEY_SECRET_RE — still should be "***"
    expect(result["token"]).toBe("***");
  });

  it("does NOT redact short safe strings that happen to start with similar letters", () => {
    // 'eye' does not match eyJ{8+}
    const result = redactFields({ note: "eye candy" });
    expect(result["note"]).toBe("eye candy");
  });
});

// ─── NoopLogger ────────────────────────────────────────────────────────────────

describe("NoopLogger", () => {
  it("enabled() always returns false", () => {
    expect(NoopLogger.enabled!("debug", "eidentic:loop")).toBe(false);
    expect(NoopLogger.enabled!("warn", "eidentic:cost")).toBe(false);
  });

  it("log() does nothing (no throw)", () => {
    expect(() => NoopLogger.log("warn", "eidentic:tool", "msg", { x: 1 })).not.toThrow();
  });
});

// ─── Integration: capture logger receives expected namespaces ─────────────────

const pingTool = createTool({
  id: "ping",
  description: "returns pong",
  inputSchema: z.object({}),
  execute: async () => ({ reply: "pong" }),
});

describe("Agent integration: capture logger", () => {
  it("emits eidentic:loop and eidentic:tool logs on a tool-using run", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([
      { content: [toolUseBlock("c1", "ping", {})], usage: { inputTokens: 5, outputTokens: 2 } },
      { content: [textBlock("done")], usage: { inputTokens: 3, outputTokens: 1 } },
    ]);
    const logger = captureLogger();
    const agent = new Agent({
      id: "a",
      instructions: "be helpful",
      model,
      store,
      tools: [pingTool],
      logger,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    await run(agent, "hi", "s1");

    const nss = logger.calls.map((c) => c.ns);
    expect(nss).toContain("eidentic:loop");
    expect(nss).toContain("eidentic:tool");
  });

  it("emits eidentic:permission deny when onPreToolUse denies a tool", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    // Model tries to call ping but onPreToolUse denies it, then succeeds with text
    const model = new MockModel([
      { content: [toolUseBlock("c1", "ping", {})], usage: { inputTokens: 5, outputTokens: 2 } },
      { content: [textBlock("denied but ok")], usage: { inputTokens: 3, outputTokens: 1 } },
    ]);
    const logger = captureLogger();
    const agent = new Agent({
      id: "a",
      instructions: "be helpful",
      model,
      store,
      tools: [pingTool],
      // onPreToolUse explicitly denies ping — triggers resolvePermission + permission log
      onPreToolUse: (toolId) => toolId === "ping" ? "deny" : undefined,
      logger,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    await run(agent, "hi", "s2");

    const permCalls = logger.calls.filter((c) => c.ns === "eidentic:permission");
    expect(permCalls.length).toBeGreaterThan(0);
    const denyCall = permCalls.find((c) => c.fields?.["decision"] === "deny");
    expect(denyCall).toBeDefined();
  });
});

// ─── No-op path: no stdout noise, identical result ────────────────────────────

describe("No-op path (DEBUG unset, no logger)", () => {
  const savedDebug = process.env["DEBUG"];
  afterEach(() => {
    if (savedDebug === undefined) delete process.env["DEBUG"];
    else process.env["DEBUG"] = savedDebug;
  });

  it("produces identical result events with no injected logger and DEBUG unset", async () => {
    delete process.env["DEBUG"];
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([
      { content: [textBlock("hello")], usage: { inputTokens: 3, outputTokens: 2 } },
    ]);
    const agent = new Agent({
      id: "a",
      instructions: "be helpful",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    const events = await run(agent, "hi", "s3");
    const result = events.find((e) => e.type === "result");
    expect(result).toBeDefined();
    expect((result as { subtype: string }).subtype).toBe("success");
    expect((result as { output: string }).output).toBe("hello");
  });
});
