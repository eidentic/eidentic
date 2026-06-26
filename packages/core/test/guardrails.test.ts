/**
 * Tests for GuardrailPort wiring (D7):
 *  - Input block terminates run before model is called
 *  - Input redact modifies text seen by model
 *  - Output block emits guardrail terminal
 *  - Output redact modifies final result output
 *  - Multiple guardrails run in order; first block wins
 *  - No guardrails: byte-identical behavior
 */
import { describe, it, expect } from "vitest";
import { Agent } from "../src/agent.js";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, type GuardrailPort, type StreamEvent } from "@eidentic/types";

async function run(agent: Agent, input: string, sessionId: string): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of agent.query(input, { sessionId })) out.push(e);
  return out;
}

function makeAgent(model: MockModel, store: InMemoryStore, guardrails?: GuardrailPort | GuardrailPort[]) {
  return new Agent({
    id: "guardrail-test",
    instructions: "You are a test agent.",
    model,
    store,
    guardrails,
    now: () => "t",
    newId: ((n) => () => `e${n++}`)(0),
  });
}

describe("GuardrailPort wiring", () => {
  describe("input guardrails", () => {
    it("block: terminates immediately without calling the model", async () => {
      const store = new InMemoryStore();
      await store.migrate();
      const model = new MockModel([
        { content: [textBlock("should not be returned")], usage: { inputTokens: 1, outputTokens: 1 } },
      ]);

      const blockGuardrail: GuardrailPort = {
        checkInput: () => ({ action: "block", reason: "test block" }),
      };

      const agent = makeAgent(model, store, blockGuardrail);
      const events = await run(agent, "this input is blocked", "s1");

      const result = events.find((e) => e.type === "result");
      expect(result).toBeDefined();
      expect((result as Extract<StreamEvent, { type: "result" }>).subtype).toBe("guardrail");
      expect((result as Extract<StreamEvent, { type: "result" }>).output).toMatch(/blocked.*guardrail/i);
      // Model must NOT have been called
      expect(model.calls).toHaveLength(0);
    });

    it("redact: model receives the redacted text, not the original", async () => {
      const store = new InMemoryStore();
      await store.migrate();
      const model = new MockModel([
        { content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } },
      ]);

      const redactGuardrail: GuardrailPort = {
        checkInput: (text) => ({
          action: "redact",
          text: text.replace(/secret/gi, "[REDACTED]"),
        }),
      };

      const agent = makeAgent(model, store, redactGuardrail);
      await run(agent, "my secret is 123", "s2");

      expect(model.calls).toHaveLength(1);
      const userMsg = model.calls[0]!.messages.find((m) => m.role === "user");
      expect(typeof userMsg?.content).toBe("string");
      expect(userMsg?.content as string).toContain("[REDACTED]");
      expect(userMsg?.content as string).not.toContain("secret");
    });

    it("allow: model receives the original text unchanged", async () => {
      const store = new InMemoryStore();
      await store.migrate();
      const model = new MockModel([
        { content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } },
      ]);

      const allowGuardrail: GuardrailPort = {
        checkInput: () => ({ action: "allow" }),
      };

      const agent = makeAgent(model, store, allowGuardrail);
      await run(agent, "hello world", "s3");

      const userMsg = model.calls[0]!.messages.find((m) => m.role === "user");
      expect(userMsg?.content).toBe("hello world");
    });
  });

  describe("output guardrails", () => {
    it("block: emits guardrail subtype on final output", async () => {
      const store = new InMemoryStore();
      await store.migrate();
      const model = new MockModel([
        { content: [textBlock("sensitive output"), ], usage: { inputTokens: 1, outputTokens: 1 } },
      ]);

      const blockGuardrail: GuardrailPort = {
        checkOutput: () => ({ action: "block", reason: "output policy violation" }),
      };

      const agent = makeAgent(model, store, blockGuardrail);
      const events = await run(agent, "hello", "s4");

      const result = events.find((e) => e.type === "result") as Extract<StreamEvent, { type: "result" }> | undefined;
      expect(result).toBeDefined();
      expect(result!.subtype).toBe("guardrail");
      expect(String(result!.output)).toMatch(/output.*blocked.*guardrail/i);
      const stored = await store.readEvents("s4");
      expect(stored.some((e) => e.kind === "assistant")).toBe(false);
      expect(JSON.stringify(stored)).not.toContain("sensitive output");
    });

    it("redact: final result carries the redacted text", async () => {
      const store = new InMemoryStore();
      await store.migrate();
      const model = new MockModel([
        { content: [textBlock("call me at 555-867-5309")], usage: { inputTokens: 1, outputTokens: 1 } },
      ]);

      const redactGuardrail: GuardrailPort = {
        checkOutput: (text) => ({
          action: "redact",
          text: text.replace(/\d{3}-\d{3}-\d{4}/g, "[PHONE]"),
        }),
      };

      const agent = makeAgent(model, store, redactGuardrail);
      const events = await run(agent, "give me your number", "s5");

      const result = events.find((e) => e.type === "result") as Extract<StreamEvent, { type: "result" }> | undefined;
      expect(result?.subtype).toBe("success");
      expect(String(result?.output)).toContain("[PHONE]");
      expect(String(result?.output)).not.toContain("555-867-5309");
      const stored = await store.readEvents("s5");
      expect(JSON.stringify(stored)).toContain("[PHONE]");
      expect(JSON.stringify(stored)).not.toContain("555-867-5309");
    });
  });

  describe("multiple guardrails", () => {
    it("multiple input guardrails run in order; first block wins", async () => {
      const store = new InMemoryStore();
      await store.migrate();
      const model = new MockModel([
        { content: [textBlock("never")], usage: { inputTokens: 1, outputTokens: 1 } },
      ]);

      const callOrder: string[] = [];

      const g1: GuardrailPort = {
        checkInput: () => { callOrder.push("g1"); return { action: "allow" }; },
      };
      const g2: GuardrailPort = {
        checkInput: () => { callOrder.push("g2"); return { action: "block", reason: "blocked by g2" }; },
      };
      const g3: GuardrailPort = {
        checkInput: () => { callOrder.push("g3"); return { action: "allow" }; },
      };

      const agent = makeAgent(model, store, [g1, g2, g3]);
      const events = await run(agent, "test", "s6");

      expect(callOrder).toEqual(["g1", "g2"]); // g3 never runs after g2 blocks
      expect(model.calls).toHaveLength(0);
      const result = events.find((e) => e.type === "result") as Extract<StreamEvent, { type: "result" }> | undefined;
      expect(result?.subtype).toBe("guardrail");
    });

    it("redact chains: each guardrail sees the text from the previous redaction", async () => {
      const store = new InMemoryStore();
      await store.migrate();
      const model = new MockModel([
        { content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } },
      ]);

      const g1: GuardrailPort = {
        checkInput: (text) => ({ action: "redact", text: text + " [g1]" }),
      };
      const g2: GuardrailPort = {
        checkInput: (text) => ({ action: "redact", text: text + " [g2]" }),
      };

      const agent = makeAgent(model, store, [g1, g2]);
      await run(agent, "hello", "s7");

      const userMsg = model.calls[0]!.messages.find((m) => m.role === "user");
      // g2 receives the g1-redacted text, so both markers should appear
      expect(userMsg?.content as string).toContain("[g1]");
      expect(userMsg?.content as string).toContain("[g2]");
    });

    it("no guardrails: behavior is byte-identical (model called, success returned)", async () => {
      const store = new InMemoryStore();
      await store.migrate();
      const model = new MockModel([
        { content: [textBlock("hello back")], usage: { inputTokens: 1, outputTokens: 1 } },
      ]);

      const agent = makeAgent(model, store, undefined); // no guardrails
      const events = await run(agent, "hello", "s8");

      expect(model.calls).toHaveLength(1);
      const result = events.find((e) => e.type === "result") as Extract<StreamEvent, { type: "result" }> | undefined;
      expect(result?.subtype).toBe("success");
      expect(result?.output).toBe("hello back");
    });

    it("guardrail as single port (not array) works correctly", async () => {
      const store = new InMemoryStore();
      await store.migrate();
      const model = new MockModel([
        { content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } },
      ]);

      const singleGuardrail: GuardrailPort = {
        checkInput: () => ({ action: "block", reason: "single port block" }),
      };

      // Pass as single port, not array
      const agent = makeAgent(model, store, singleGuardrail);
      const events = await run(agent, "test", "s9");

      const result = events.find((e) => e.type === "result") as Extract<StreamEvent, { type: "result" }> | undefined;
      expect(result?.subtype).toBe("guardrail");
      expect(model.calls).toHaveLength(0);
    });

    it("guardrail context includes agentId and sessionId", async () => {
      const store = new InMemoryStore();
      await store.migrate();
      const model = new MockModel([
        { content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } },
      ]);

      let capturedCtx: { agentId?: string; sessionId?: string } | undefined;

      const ctxGuardrail: GuardrailPort = {
        checkInput: (_text, ctx) => {
          capturedCtx = ctx;
          return { action: "allow" };
        },
      };

      const agent = makeAgent(model, store, ctxGuardrail);
      await run(agent, "hello", "ctx-session");

      expect(capturedCtx?.agentId).toBe("guardrail-test");
      expect(capturedCtx?.sessionId).toBe("ctx-session");
    });

    it("guardrailInput lets input guardrails inspect user text instead of the whole prompt", async () => {
      const store = new InMemoryStore();
      await store.migrate();
      const model = new MockModel([
        { content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } },
      ]);

      let checkedText = "";
      let capturedCtx: { source?: string; channel?: string; metadata?: Record<string, unknown> } | undefined;
      const refundGuardrail: GuardrailPort = {
        checkInput: (text, ctx) => {
          checkedText = text;
          capturedCtx = ctx;
          return /refund/i.test(text)
            ? { action: "block", reason: "refund policy", code: "refunds_legal", severity: "high" }
            : { action: "allow" };
        },
      };

      const agent = makeAgent(model, store, refundGuardrail);
      const events: StreamEvent[] = [];
      for await (const e of agent.query("Operator policy: mention refund rules. Customer says hello.", {
        sessionId: "guardrail-segment",
        guardrailInput: {
          userText: "hello",
          channel: "email",
          metadata: { conversationId: "c1" },
        },
      })) events.push(e);

      expect(checkedText).toBe("hello");
      expect(capturedCtx?.source).toBe("input");
      expect(capturedCtx?.channel).toBe("email");
      expect(capturedCtx?.metadata).toEqual({ conversationId: "c1" });
      expect(model.calls).toHaveLength(1);
      expect((events.at(-1) as Extract<StreamEvent, { type: "result" }>).subtype).toBe("success");
    });

    it("guardrail block details carry machine-readable code and severity", async () => {
      const store = new InMemoryStore();
      await store.migrate();
      const model = new MockModel([
        { content: [textBlock("never")], usage: { inputTokens: 1, outputTokens: 1 } },
      ]);
      const guardrail: GuardrailPort = {
        checkInput: () => ({ action: "block", reason: "refund policy", code: "refunds_legal", severity: "high" }),
      };
      const agent = makeAgent(model, store, guardrail);
      const events = await run(agent, "refund please", "guardrail-code");
      const result = events.find((e) => e.type === "result") as Extract<StreamEvent, { type: "result" }>;
      expect(result.subtype).toBe("guardrail");
      expect(result.details).toEqual({
        subtype: "guardrail",
        reason: "refund policy",
        code: "refunds_legal",
        severity: "high",
      });
    });

    it("guardrailInput redaction patches the full prompt when the checked segment is embedded", async () => {
      const store = new InMemoryStore();
      await store.migrate();
      const model = new MockModel([
        { content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } },
      ]);
      const guardrail: GuardrailPort = {
        checkInput: (text) => ({ action: "redact", text: text.replace("secret", "[REDACTED]"), code: "secret" }),
      };
      const agent = makeAgent(model, store, guardrail);
      for await (const _ of agent.query("Operator context.\nCustomer: my secret", {
        sessionId: "guardrail-redact-segment",
        guardrailInput: { userText: "my secret" },
      })) { /* drain */ }
      const userMsg = model.calls[0]!.messages.find((m) => m.role === "user");
      expect(String(userMsg?.content)).toContain("my [REDACTED]");
      expect(String(userMsg?.content)).not.toContain("my secret");
    });
  });
});
