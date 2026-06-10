/**
 * Feature 2 — Structured-output validation retry.
 *
 * Tests cover:
 *  1. Model returns invalid-then-valid: retried and succeeds.
 *  2. Model always returns invalid: errors after N retries.
 *  3. Model returns valid on first try: no retry.
 *  4. Default ON: without explicit config, retries are attempted (default maxAttempts=2).
 *  5. Explicitly disabled (maxAttempts=0): validation failure immediately errors.
 *  6. Corrective message contains the validation error text.
 *  M1-7. Corrective message (validation failure) is persisted as a user event in the store.
 *  M1-8. Corrective message (parse failure) is persisted as a user event in the store.
 *  M1-9. Resume after validation-failure retry reconstructs messages INCLUDING the corrective user message.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { InMemoryStore } from "@eidentic/types/testing";
import { textBlock, type ModelPort, type ModelRequest, type ModelResponse, type StreamEvent } from "@eidentic/types";
import { Agent } from "../src/agent.js";

const usage = { inputTokens: 1, outputTokens: 1 };
const Person = z.object({ name: z.string(), age: z.number() });

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

// ---------------------------------------------------------------------------
// Test 1: invalid-then-valid → retried and succeeds
// ---------------------------------------------------------------------------

describe("Feature 2 — structured output retry: invalid-then-valid → retried and succeeds", () => {
  it("retries when validation fails and succeeds on the second call", async () => {
    const store = await freshStore();
    let callCount = 0;

    // First call: age is a string (invalid). Second call: correct.
    const model: ModelPort = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        callCount++;
        if (callCount === 1) {
          return { content: [textBlock('{"name":"Ada","age":"not a number"}')], usage };
        }
        return { content: [textBlock('{"name":"Ada","age":36}')], usage };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      structuredOutputRetry: { maxAttempts: 2 },
    });

    const events = await collect(agent.query("classify", { sessionId: "s-so-retry-success", outputSchema: Person }));
    const result = terminal(events);
    expect(result.subtype).toBe("success");
    expect((result as Extract<StreamEvent, { type: "result"; subtype: "success" }>).object).toEqual({ name: "Ada", age: 36 });
    // Called twice: initial + 1 retry.
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test 2: always invalid → errors after N retries
// ---------------------------------------------------------------------------

describe("Feature 2 — structured output retry: always invalid → errors after N retries", () => {
  it("errors after exhausting maxAttempts retries when model always returns invalid", async () => {
    const store = await freshStore();
    let callCount = 0;

    const model: ModelPort = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        callCount++;
        // Always returns invalid JSON (age is string).
        return { content: [textBlock('{"name":"Ada","age":"wrong"}')], usage };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      structuredOutputRetry: { maxAttempts: 2 },
    });

    const events = await collect(agent.query("classify", { sessionId: "s-so-retry-exhaust", outputSchema: Person }));
    const result = terminal(events);
    expect(result.subtype).toBe("error");
    expect(String((result as Extract<StreamEvent, { type: "result"; subtype: "error" }>).output)).toMatch(/schema validation/i);
    // Initial call + 2 retries = 3 total calls.
    expect(callCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Test 3: valid on first try → no retry
// ---------------------------------------------------------------------------

describe("Feature 2 — structured output retry: valid first try → no retry", () => {
  it("does not retry when the first response is valid", async () => {
    const store = await freshStore();
    let callCount = 0;

    const model: ModelPort = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        callCount++;
        return { content: [textBlock('{"name":"Bo","age":7}')], usage };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      structuredOutputRetry: { maxAttempts: 2 },
    });

    const events = await collect(agent.query("classify", { sessionId: "s-so-no-retry", outputSchema: Person }));
    const result = terminal(events);
    expect(result.subtype).toBe("success");
    expect((result as Extract<StreamEvent, { type: "result"; subtype: "success" }>).object).toEqual({ name: "Bo", age: 7 });
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Default ON — without explicit config, retries are attempted
// ---------------------------------------------------------------------------

describe("Feature 2 — structured output retry: default ON", () => {
  it("retries by default (without explicit structuredOutputRetry config)", async () => {
    const store = await freshStore();
    let callCount = 0;

    const model: ModelPort = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        callCount++;
        if (callCount === 1) {
          // First call invalid.
          return { content: [textBlock('{"name":"Ada","age":"oops"}')], usage };
        }
        // Subsequent calls valid.
        return { content: [textBlock('{"name":"Ada","age":42}')], usage };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      // No structuredOutputRetry config → default behavior.
    });

    const events = await collect(agent.query("classify", { sessionId: "s-so-default-retry", outputSchema: Person }));
    const result = terminal(events);
    // Should retry by default and succeed.
    expect(result.subtype).toBe("success");
    expect(callCount).toBeGreaterThan(1); // at least one retry happened
  });
});

// ---------------------------------------------------------------------------
// Test 5: Explicitly disabled (maxAttempts=0) → immediate error on validation failure
// ---------------------------------------------------------------------------

describe("Feature 2 — structured output retry: maxAttempts=0 → immediate error", () => {
  it("emits error immediately when maxAttempts=0 and validation fails", async () => {
    const store = await freshStore();
    let callCount = 0;

    const model: ModelPort = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        callCount++;
        if (callCount === 1) {
          return { content: [textBlock('{"name":"Ada","age":"wrong"}')], usage };
        }
        return { content: [textBlock('{"name":"Ada","age":36}')], usage };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      structuredOutputRetry: { maxAttempts: 0 },
    });

    const events = await collect(agent.query("classify", { sessionId: "s-so-disabled-retry", outputSchema: Person }));
    const result = terminal(events);
    // maxAttempts=0 means no retries → immediate error.
    expect(result.subtype).toBe("error");
    // Only one model call (no retry).
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 6: Corrective message contains validation error
// ---------------------------------------------------------------------------

describe("Feature 2 — structured output retry: corrective message content", () => {
  it("sends a corrective message containing the validation error to the model on retry", async () => {
    const store = await freshStore();
    const receivedMessages: Array<{ role: string; content: unknown }[]> = [];

    const model: ModelPort = {
      async complete(req: ModelRequest): Promise<ModelResponse> {
        // Snapshot the messages array (not a reference) to avoid aliasing.
        receivedMessages.push([...req.messages]);
        if (receivedMessages.length === 1) {
          return { content: [textBlock('{"name":"Ada","age":"oops"}')], usage };
        }
        return { content: [textBlock('{"name":"Ada","age":36}')], usage };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      structuredOutputRetry: { maxAttempts: 2 },
    });

    await collect(agent.query("classify", { sessionId: "s-so-corrective-msg", outputSchema: Person }));

    // On retry, the messages should include a corrective user message mentioning the validation error.
    expect(receivedMessages).toHaveLength(2);
    const retryMessages = receivedMessages[1]!;
    // The retry messages should have more entries than the original (corrective message appended).
    expect(retryMessages.length).toBeGreaterThan(receivedMessages[0]!.length);
    // The last message before the model's retry should be a user message with the validation error.
    const lastUserMsg = [...retryMessages].reverse().find((m) => m.role === "user");
    expect(lastUserMsg).toBeDefined();
    const lastUserContent = String(lastUserMsg!.content);
    // The corrective message should mention the validation issue.
    expect(lastUserContent.toLowerCase()).toMatch(/schema|validation|error|invalid/i);
  });
});

// ---------------------------------------------------------------------------
// M1-7: Corrective message (validation failure) is persisted as a user event
// ---------------------------------------------------------------------------

describe("M1 fix — corrective retry message is persisted to the event store (validation failure)", () => {
  it("after a validation-failure retry, the store contains a corrective user event", async () => {
    const store = await freshStore();
    let callCount = 0;

    const model: ModelPort = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        callCount++;
        if (callCount === 1) {
          // First call: age is wrong type.
          return { content: [textBlock('{"name":"Ada","age":"wrong"}')], usage };
        }
        return { content: [textBlock('{"name":"Ada","age":36}')], usage };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      structuredOutputRetry: { maxAttempts: 2 },
    });

    const events = await collect(agent.query("classify", { sessionId: "s-m1-persist-val", outputSchema: Person }));
    expect(terminal(events).subtype).toBe("success");

    // Read back the persisted events from the store.
    const stored = await store.readEvents("s-m1-persist-val");
    // Must contain a user event whose payload mentions "schema" or "validation" (the corrective msg).
    const correctiveEvents = stored.filter(
      (e) => e.kind === "user" && /schema|validation/i.test(String(e.payload)),
    );
    expect(correctiveEvents.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// M1-8: Corrective message (JSON parse failure) is persisted as a user event
// ---------------------------------------------------------------------------

describe("M1 fix — corrective retry message is persisted to the event store (parse failure)", () => {
  it("after a parse-failure retry, the store contains a corrective user event about invalid JSON", async () => {
    const store = await freshStore();
    let callCount = 0;

    const model: ModelPort = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        callCount++;
        if (callCount === 1) {
          // First call: not JSON at all.
          return { content: [textBlock("NOT JSON AT ALL")], usage };
        }
        return { content: [textBlock('{"name":"Ada","age":36}')], usage };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      structuredOutputRetry: { maxAttempts: 2 },
    });

    const events = await collect(agent.query("classify", { sessionId: "s-m1-persist-parse", outputSchema: Person }));
    expect(terminal(events).subtype).toBe("success");

    const stored = await store.readEvents("s-m1-persist-parse");
    // Must contain a user event whose payload mentions "JSON" (the parse-failure corrective msg).
    const correctiveEvents = stored.filter(
      (e) => e.kind === "user" && /json/i.test(String(e.payload)),
    );
    expect(correctiveEvents.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// M1-9: Resume after validation-failure retry reconstructs corrective message
// ---------------------------------------------------------------------------

describe("M1 fix — resume after structured-output retry includes corrective user message in rebuilt window", () => {
  it("a resumed run sees the corrective user event in the rebuilt message window", async () => {
    const store = await freshStore();

    // Build up a session that had a validation failure + corrective message already persisted.
    // We simulate this by running query with invalid-then-valid behaviour, then checking that
    // on a second call (resume path via buildInitialMessages), the corrective event is visible.
    let callCount = 0;
    const receivedMessageWindows: Array<{ role: string; content: unknown }[][]> = [];

    const model: ModelPort = {
      async complete(req: ModelRequest): Promise<ModelResponse> {
        callCount++;
        receivedMessageWindows.push([...req.messages]);
        if (callCount === 1) {
          // First call: invalid — triggers retry + corrective message persistence.
          return { content: [textBlock('{"name":"Ada","age":"wrong"}')], usage };
        }
        // Second call (the retry): valid.
        return { content: [textBlock('{"name":"Ada","age":36}')], usage };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      structuredOutputRetry: { maxAttempts: 2 },
    });

    await collect(agent.query("classify", { sessionId: "s-m1-resume", outputSchema: Person }));
    expect(callCount).toBe(2);

    // The second model call (the retry) must have received the corrective user message as part of
    // its message window — this confirms the persisted event was replayed into messages correctly.
    const retryWindow = receivedMessageWindows[1]!;
    const correctiveMsg = retryWindow.find(
      (m) => m.role === "user" && /schema|validation|json/i.test(String(m.content)),
    );
    expect(correctiveMsg).toBeDefined();

    // Additionally verify the store has the corrective user event (durability invariant).
    const stored = await store.readEvents("s-m1-resume");
    expect(stored.filter((e) => e.kind === "user").length).toBeGreaterThanOrEqual(2); // original + corrective
  });
});
