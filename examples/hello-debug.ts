/**
 * LoggerPort + DEBUG-gated logging demo.
 *
 * Two modes:
 *  1. Injected capture logger (always runs, no env needed):
 *       pnpm hello:debug
 *
 *  2. Built-in envLogger with DEBUG gating (prints to stderr):
 *       DEBUG=eidentic:* npx tsx examples/hello-debug.ts
 *
 * Shows: eidentic:loop model-call logs, eidentic:tool dispatch/result,
 *        eidentic:permission deny when a policy denies a tool.
 */
import { z } from "zod";
import { Agent, createTool } from "@eidentic/core";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock } from "@eidentic/types";
import type { LogLevel, LogFields, LoggerPort } from "@eidentic/core";

// ─── capture logger ───────────────────────────────────────────────────────────

type LogEntry = { level: LogLevel; ns: string; msg: string; fields?: LogFields };

function makeCaptureLogger(): LoggerPort & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    log(level: LogLevel, ns: string, msg: string, fields?: LogFields): void {
      entries.push({ level, ns, msg, fields });
    },
    enabled(_level: LogLevel, _ns: string): boolean {
      return true;
    },
  };
}

// ─── tools ────────────────────────────────────────────────────────────────────

const greetTool = createTool({
  id: "greet",
  description: "greets a person",
  inputSchema: z.object({ name: z.string() }),
  execute: async ({ input }) => ({ greeting: `Hello, ${input.name}!` }),
});

const dangerTool = createTool({
  id: "danger",
  description: "dangerous action",
  sideEffect: "destructive",
  inputSchema: z.object({}),
  execute: async () => ({ done: true }),
});

// ─── run ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const store = new InMemoryStore();
  await store.migrate();

  // Model scripted to: call greet, then try danger (will be denied), then finish.
  const model = new MockModel([
    { content: [toolUseBlock("c1", "greet", { name: "World" })], usage: { inputTokens: 10, outputTokens: 5 } },
    { content: [toolUseBlock("c2", "danger", {})], usage: { inputTokens: 8, outputTokens: 4 } },
    { content: [textBlock("All done!")], usage: { inputTokens: 6, outputTokens: 3 } },
  ]);

  const logger = makeCaptureLogger();

  const agent = new Agent({
    id: "debug-demo",
    instructions: "You are a demo agent.",
    model,
    store,
    tools: [greetTool, dangerTool],
    // onPreToolUse: deny danger at dispatch (keeps it in schema so model can try calling it,
    // triggering the permission gate + permission log — unlike schema-level deny which removes it).
    onPreToolUse: (toolId) => toolId === "danger" ? "deny" : undefined,
    logger,
    now: () => new Date().toISOString(),
    newId: ((n) => () => `e${n++}`)(0),
  });

  for await (const _ev of agent.query("say hello then do danger", { sessionId: "demo-1" })) {
    // consume
  }

  console.log("\n=== captured debug lines ===\n");
  for (const e of logger.entries) {
    const fieldStr = e.fields
      ? " " + Object.entries(e.fields).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")
      : "";
    console.log(`[${e.level}] ${e.ns} ${e.msg}${fieldStr}`);
  }

  const loopLogs = logger.entries.filter((e) => e.ns === "eidentic:loop");
  const toolLogs = logger.entries.filter((e) => e.ns === "eidentic:tool");
  const permLogs = logger.entries.filter((e) => e.ns === "eidentic:permission");

  console.log(`\nSummary:`);
  console.log(`  eidentic:loop     — ${loopLogs.length} log(s)`);
  console.log(`  eidentic:tool     — ${toolLogs.length} log(s)`);
  console.log(`  eidentic:permission — ${permLogs.length} log(s)`);

  const denyLog = permLogs.find((e) => e.fields?.["decision"] === "deny");
  if (denyLog) {
    console.log(`\n  Permission deny recorded for tool: ${denyLog.fields?.["tool"]}`);
  }

  // Verify assertions
  if (loopLogs.length === 0) throw new Error("expected eidentic:loop logs");
  if (toolLogs.length === 0) throw new Error("expected eidentic:tool logs");
  if (!denyLog) throw new Error("expected a eidentic:permission deny log");
  console.log("\n  All assertions passed.");
}

main().catch((err) => { console.error(err); process.exit(1); });
