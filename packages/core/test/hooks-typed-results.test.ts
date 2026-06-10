/**
 * Tests for:
 *  1. onPostToolUse hook (fires on success + error, awaited order, throwing hook doesn't kill run, resume path)
 *  2. Typed terminal result details (max_cost, max_turns, max_tokens carry correct numbers)
 *  3. onTurnStart per-turn context injection (visible to model, multi-turn, not persisted, async hook)
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import {
  textBlock,
  toolUseBlock,
  type StreamEvent,
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
} from "@eidentic/types";
import { Agent } from "../src/agent.js";
import { createTool } from "../src/tool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function terminal(events: StreamEvent[]): Extract<StreamEvent, { type: "result" }> {
  const t = events.at(-1);
  if (!t || t.type !== "result") throw new Error(`last event is not a result; got ${JSON.stringify(t)}`);
  return t as Extract<StreamEvent, { type: "result" }>;
}

async function freshStore(): Promise<InMemoryStore> {
  const s = new InMemoryStore();
  await s.migrate();
  return s;
}

const idFactory = (prefix = "e") => ((n: number) => () => `${prefix}${n++}`)(0);

const ping = createTool({
  id: "ping",
  description: "returns pong",
  inputSchema: z.object({}),
  execute: async () => ({ reply: "pong" }),
});

const boom = createTool({
  id: "boom",
  description: "throws",
  inputSchema: z.object({}),
  sideEffect: "idempotent",
  execute: async () => {
    throw new Error("kaboom");
  },
});

// ---------------------------------------------------------------------------
// 1. onPostToolUse
// ---------------------------------------------------------------------------

describe("onPostToolUse hook", () => {
  it("fires after a successful tool dispatch with correct info", async () => {
    const store = await freshStore();
    const model = new MockModel([
      { content: [toolUseBlock("c1", "ping", {})], usage: { inputTokens: 5, outputTokens: 2 } },
      { content: [textBlock("done")], usage: { inputTokens: 6, outputTokens: 3 } },
    ]);

    const calls: Array<{ toolId: string; isError: boolean; output: unknown; durationMs: number; sessionId: string }> = [];

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      tools: [ping],
      now: () => "t",
      newId: idFactory(),
      onPostToolUse: async (info) => {
        calls.push({ ...info });
      },
    });

    const events = await collect(agent.query("hi", { sessionId: "s1" }));
    expect(terminal(events).subtype).toBe("success");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolId).toBe("ping");
    expect(calls[0]!.isError).toBe(false);
    expect((calls[0]!.output as { reply: string }).reply).toBe("pong");
    expect(calls[0]!.sessionId).toBe("s1");
    expect(typeof calls[0]!.durationMs).toBe("number");
    expect(calls[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("fires after an error dispatch with isError=true", async () => {
    const store = await freshStore();
    const model = new MockModel([
      { content: [toolUseBlock("c1", "boom", {})], usage: { inputTokens: 5, outputTokens: 2 } },
      { content: [textBlock("recovered")], usage: { inputTokens: 6, outputTokens: 3 } },
    ]);

    const calls: Array<{ isError: boolean }> = [];

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      tools: [boom],
      now: () => "t",
      newId: idFactory(),
      onPostToolUse: async (info) => {
        calls.push({ isError: info.isError });
      },
    });

    const events = await collect(agent.query("hi", { sessionId: "s2" }));
    expect(terminal(events).subtype).toBe("success");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.isError).toBe(true);
  });

  it("is awaited before the result event is yielded", async () => {
    const store = await freshStore();
    const model = new MockModel([
      { content: [toolUseBlock("c1", "ping", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    const order: string[] = [];

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      tools: [ping],
      now: () => "t",
      newId: idFactory(),
      onPostToolUse: async () => {
        // Simulates an async side effect (e.g., writing to a DB)
        await Promise.resolve();
        order.push("hook");
      },
    });

    for await (const ev of agent.query("hi", { sessionId: "s3" })) {
      if (ev.type === "result") order.push("result");
    }

    // hook must be recorded before result
    const hookIdx = order.indexOf("hook");
    const resultIdx = order.indexOf("result");
    expect(hookIdx).toBeGreaterThanOrEqual(0);
    expect(resultIdx).toBeGreaterThan(hookIdx);
  });

  it("a throwing hook does not kill the run — run still succeeds", async () => {
    const store = await freshStore();
    const model = new MockModel([
      { content: [toolUseBlock("c1", "ping", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      tools: [ping],
      now: () => "t",
      newId: idFactory(),
      onPostToolUse: async () => {
        throw new Error("hook explosion");
      },
    });

    const events = await collect(agent.query("hi", { sessionId: "s4" }));
    // Run must succeed despite the throwing hook
    expect(terminal(events).subtype).toBe("success");
    expect(terminal(events).output).toBe("done");
  });

  it("fires on the resume re-dispatch path", async () => {
    const store = await freshStore();

    let resumeHookFired = false;

    const approveTool = createTool({
      id: "approve",
      description: "requires approval",
      sideEffect: "destructive",
      inputSchema: z.object({ action: z.string() }),
      idempotencyKey: (i) => `approve:${i.action}`,
      execute: async ({ input, ctx }) => {
        const decision = await ctx!.suspend!({ reason: "approve?" });
        if (!decision.approved) return { done: false };
        return { done: true, action: input.action };
      },
    });

    // Run 1: trigger suspension
    const m1 = new MockModel([
      { content: [toolUseBlock("tc1", "approve", { action: "deploy" })], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const a1 = new Agent({
      id: "ag",
      instructions: "",
      model: m1,
      store,
      tools: [approveTool],
      durable: true,
      now: () => "t",
      newId: idFactory("r"),
      onPostToolUse: async () => { /* no-op on first run */ },
    });
    const firstEvents: StreamEvent[] = [];
    for await (const e of a1.query("deploy it", { sessionId: "sess-resume" })) firstEvents.push(e);
    expect(terminal(firstEvents).subtype).toBe("suspended");

    // Run 2: resume with decision — hook should fire for the re-dispatched tool
    const m2 = new MockModel([
      { content: [textBlock("deployed")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const a2 = new Agent({
      id: "ag",
      instructions: "",
      model: m2,
      store,
      tools: [approveTool],
      durable: true,
      now: () => "t",
      newId: idFactory("r2"),
      onPostToolUse: async (info) => {
        if (info.toolId === "approve") resumeHookFired = true;
      },
    });
    const resumeEvents: StreamEvent[] = [];
    for await (const e of a2.resume("sess-resume", { decision: { approved: true } })) resumeEvents.push(e);
    expect(terminal(resumeEvents).subtype).toBe("success");
    expect(resumeHookFired).toBe(true);
  });

  it("fires for multiple tool calls in one turn, once per call", async () => {
    const store = await freshStore();
    const model = new MockModel([
      {
        content: [toolUseBlock("c1", "ping", {}), toolUseBlock("c2", "ping", {})],
        usage: { inputTokens: 2, outputTokens: 2 },
      },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    const calls: string[] = [];

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      tools: [ping],
      now: () => "t",
      newId: idFactory(),
      onPostToolUse: async (info) => {
        calls.push(info.toolId);
      },
    });

    const events = await collect(agent.query("hi", { sessionId: "s5" }));
    expect(terminal(events).subtype).toBe("success");
    expect(calls).toHaveLength(2);
    expect(calls.every((id) => id === "ping")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Typed terminal result details
// ---------------------------------------------------------------------------

describe("typed result details", () => {
  it("max_cost details carry usdSpent and usdLimit", async () => {
    const store = await freshStore();
    // 1M input tokens @ $1/MTok = $1.00; ceiling $0.50 → preflight aborts after first call
    const model = new MockModel([
      { content: [toolUseBlock("c1", "ping", {})], usage: { inputTokens: 1_000_000, outputTokens: 0 } },
      { content: [textBlock("never")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      tools: [ping],
      now: () => "t",
      newId: idFactory(),
      modelId: "haiku",
      policy: { maxCostUsd: 0.5 },
      prices: { haiku: { inputPerMTok: 1, outputPerMTok: 1 } },
    });

    const events = await collect(agent.query("hi", { sessionId: "s-mc" }));
    const r = terminal(events);
    expect(r.subtype).toBe("max_cost");
    expect(r.details).toBeDefined();
    expect(r.details!.subtype).toBe("max_cost");
    if (r.details!.subtype === "max_cost") {
      expect(r.details!.usdSpent).toBeCloseTo(1.0, 5);
      expect(r.details!.usdLimit).toBeCloseTo(0.5, 5);
    }
  });

  it("max_turns details carry turns and limit", async () => {
    const store = await freshStore();
    const model = new MockModel([
      { content: [toolUseBlock("c", "ping", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [toolUseBlock("c", "ping", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("never")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      tools: [ping],
      now: () => "t",
      newId: idFactory(),
      maxTurns: 1,
    });

    const events = await collect(agent.query("hi", { sessionId: "s-mt" }));
    const r = terminal(events);
    expect(r.subtype).toBe("max_turns");
    expect(r.details).toBeDefined();
    expect(r.details!.subtype).toBe("max_turns");
    if (r.details!.subtype === "max_turns") {
      expect(r.details!.turns).toBe(1);
      expect(r.details!.limit).toBe(1);
    }
  });

  it("max_tokens details carry tokensUsed and tokenLimit", async () => {
    const store = await freshStore();
    // 60 input tokens → over the 50 ceiling; preflight aborts before 2nd call
    const model = new MockModel([
      { content: [toolUseBlock("c1", "ping", {})], usage: { inputTokens: 60, outputTokens: 0 } },
      { content: [textBlock("never")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      tools: [ping],
      now: () => "t",
      newId: idFactory(),
      policy: { maxTokens: 50 },
    });

    const events = await collect(agent.query("hi", { sessionId: "s-mtok" }));
    const r = terminal(events);
    expect(r.subtype).toBe("max_tokens");
    expect(r.details).toBeDefined();
    expect(r.details!.subtype).toBe("max_tokens");
    if (r.details!.subtype === "max_tokens") {
      expect(r.details!.tokensUsed).toBe(60);
      expect(r.details!.tokenLimit).toBe(50);
    }
  });

  it("success result carries a details object with subtype success", async () => {
    const store = await freshStore();
    const model = new MockModel([
      { content: [textBlock("hello")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: idFactory(),
    });

    const events = await collect(agent.query("hi", { sessionId: "s-succ" }));
    const r = terminal(events);
    expect(r.subtype).toBe("success");
    expect(r.details).toBeDefined();
    expect(r.details!.subtype).toBe("success");
  });

  it("error result carries a details object with subtype error", async () => {
    const store = await freshStore();
    // Model that immediately throws
    const badModel: ModelPort = {
      async complete(): Promise<ModelResponse> {
        throw new TypeError("bad model");
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model: badModel,
      store,
      now: () => "t",
      newId: idFactory(),
    });

    const events = await collect(agent.query("hi", { sessionId: "s-err" }));
    const r = terminal(events);
    expect(r.subtype).toBe("error");
    expect(r.details).toBeDefined();
    expect(r.details!.subtype).toBe("error");
    if (r.details!.subtype === "error") {
      expect(r.details!.errorName).toBe("TypeError");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. onTurnStart per-turn context injection
// ---------------------------------------------------------------------------

describe("onTurnStart hook", () => {
  it("injected text is visible in the model request messages", async () => {
    const store = await freshStore();

    // Deep-clone messages at capture time so later mutations don't affect the snapshot.
    const capturedMessages: Array<import("@eidentic/types").ModelMessage[]> = [];
    const model: ModelPort = {
      async complete(req: ModelRequest): Promise<ModelResponse> {
        capturedMessages.push(JSON.parse(JSON.stringify(req.messages)));
        return { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "be helpful",
      model,
      store,
      now: () => "t",
      newId: idFactory(),
      onTurnStart: () => "INJECTED_REMINDER",
    });

    const events = await collect(agent.query("hello", { sessionId: "s-ts1" }));
    expect(terminal(events).subtype).toBe("success");

    expect(capturedMessages).toHaveLength(1);
    const msgs = capturedMessages[0]!;
    // Find a user message containing the injected content
    const reminderMsg = msgs.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("INJECTED_REMINDER"),
    );
    expect(reminderMsg).toBeDefined();
    expect(reminderMsg!.content).toContain("<system-reminder>");
    expect(reminderMsg!.content).toContain("INJECTED_REMINDER");
    expect(reminderMsg!.content).toContain("</system-reminder>");
  });

  it("array of strings is joined into a single system-reminder block", async () => {
    const store = await freshStore();

    const capturedMessages: Array<import("@eidentic/types").ModelMessage[]> = [];
    const model: ModelPort = {
      async complete(req: ModelRequest): Promise<ModelResponse> {
        capturedMessages.push(JSON.parse(JSON.stringify(req.messages)));
        return { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: idFactory(),
      onTurnStart: () => ["line one", "line two"],
    });

    await collect(agent.query("hello", { sessionId: "s-ts-arr" }));
    const msgs = capturedMessages[0]!;
    const reminderMsg = msgs.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("line one"),
    );
    expect(reminderMsg).toBeDefined();
    expect(reminderMsg!.content).toContain("line one");
    expect(reminderMsg!.content).toContain("line two");
  });

  it("each turn gets a fresh injection — multi-turn", async () => {
    const store = await freshStore();

    let callCount = 0;
    const capturedMessages: Array<import("@eidentic/types").ModelMessage[]> = [];
    const model: ModelPort = {
      async complete(req: ModelRequest): Promise<ModelResponse> {
        capturedMessages.push(JSON.parse(JSON.stringify(req.messages)));
        const turn = callCount++;
        // Turn 0: return a tool use to trigger another turn; turn 1: return text
        if (turn === 0) {
          return { content: [toolUseBlock("c1", "ping", {})], usage: { inputTokens: 1, outputTokens: 1 } };
        }
        return { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      tools: [ping],
      now: () => "t",
      newId: idFactory(),
      onTurnStart: ({ turn }) => `reminder_turn_${turn}`,
    });

    const events = await collect(agent.query("hello", { sessionId: "s-ts-multi" }));
    expect(terminal(events).subtype).toBe("success");

    // Two model calls → hook was called for turn 0 and turn 1
    expect(capturedMessages).toHaveLength(2);

    // Turn 0 request: should contain reminder_turn_0
    const msgs0 = capturedMessages[0]!;
    const reminder0 = msgs0.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("reminder_turn_0"),
    );
    expect(reminder0).toBeDefined();

    // Turn 1 request: should contain reminder_turn_1 (not reminder_turn_0)
    const msgs1 = capturedMessages[1]!;
    const reminder1 = msgs1.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("reminder_turn_1"),
    );
    expect(reminder1).toBeDefined();
    const staleReminder = msgs1.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("reminder_turn_0"),
    );
    expect(staleReminder).toBeUndefined();
  });

  it("injected message is NOT persisted to the store events", async () => {
    const store = await freshStore();

    const model: ModelPort = {
      async complete(): Promise<ModelResponse> {
        return { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: idFactory(),
      onTurnStart: () => "THIS_MUST_NOT_BE_PERSISTED",
    });

    await collect(agent.query("hello", { sessionId: "s-ts-nopersist" }));

    const storedEvents = await store.readEvents("s-ts-nopersist");
    // No stored event should contain the injected text
    for (const ev of storedEvents) {
      const payload = JSON.stringify(ev.payload);
      expect(payload).not.toContain("THIS_MUST_NOT_BE_PERSISTED");
    }
  });

  it("async hook works — awaited before model call", async () => {
    const store = await freshStore();

    const capturedMessages: Array<import("@eidentic/types").ModelMessage[]> = [];
    const model: ModelPort = {
      async complete(req: ModelRequest): Promise<ModelResponse> {
        capturedMessages.push(JSON.parse(JSON.stringify(req.messages)));
        return { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: idFactory(),
      onTurnStart: async () => {
        // Simulate an async DB fetch
        await Promise.resolve();
        return "ASYNC_INJECTED";
      },
    });

    await collect(agent.query("hello", { sessionId: "s-ts-async" }));
    const msgs = capturedMessages[0]!;
    const reminderMsg = msgs.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("ASYNC_INJECTED"),
    );
    expect(reminderMsg).toBeDefined();
  });

  it("a void/undefined return from onTurnStart suppresses injection", async () => {
    const store = await freshStore();

    const capturedMessages: Array<import("@eidentic/types").ModelMessage[]> = [];
    const model: ModelPort = {
      async complete(req: ModelRequest): Promise<ModelResponse> {
        capturedMessages.push(JSON.parse(JSON.stringify(req.messages)));
        return { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: idFactory(),
      onTurnStart: () => undefined,
    });

    await collect(agent.query("hello", { sessionId: "s-ts-void" }));
    const msgs = capturedMessages[0]!;
    // No user message should contain a system-reminder
    const reminderMsg = msgs.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("<system-reminder>"),
    );
    expect(reminderMsg).toBeUndefined();
  });

  it("a throwing onTurnStart hook does not kill the run", async () => {
    const store = await freshStore();

    const model: ModelPort = {
      async complete(): Promise<ModelResponse> {
        return { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: idFactory(),
      onTurnStart: () => {
        throw new Error("hook failure");
      },
    });

    const events = await collect(agent.query("hello", { sessionId: "s-ts-throw" }));
    expect(terminal(events).subtype).toBe("success");
  });
});
