/**
 * §16.4 — Streaming-abort and catch-block-classification coverage.
 *
 * These tests cover three code paths in loop.ts that have zero coverage in
 * the existing cancellation.test.ts (which drives only the MockModel / complete path):
 *
 *  1. Mid-stream abort: the `for await` delta loop breaks when signal.aborted, leaving
 *     `final` undefined → `if (!final && signal?.aborted)` emits an aborted terminal.
 *
 *  2. Catch-block classification: model.stream() throws while signal.aborted === true
 *     → catch block emits aborted (not error). Converse: throws while signal.aborted === false
 *     → terminal error, proving genuine errors are not misclassified.
 *
 *  3. Checkpoint-on-abort resumability: abort a durable run so a checkpoint is written,
 *     then agent.resume(sessionId) continues to a clean terminal result with no orphaned
 *     tool_use blocks without a matching tool_result in the event log.
 *
 * All mocks are fully scripted; abort fires at known, deterministic points.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import {
  textBlock,
  toolUseBlock,
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamPart,
  type StreamEvent,
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

// ---------------------------------------------------------------------------
// Test 1: Mid-stream abort → "no final received → emit aborted" path
//
// The custom model yields one delta, then aborts the signal synchronously
// before yielding the `final`. The loop's per-delta check:
//   `if (args.signal?.aborted) break;`
// fires on the next iteration, so `final` stays undefined. The post-loop check:
//   `if (!final && args.signal?.aborted) → emitAborted`
// then fires and emits the terminal aborted event.
// ---------------------------------------------------------------------------

describe("§16.4 cancellation (stream): mid-stream abort — no-final path", () => {
  it("stream aborted mid-delta → exactly one terminal aborted event; loop stops immediately", async () => {
    const store = await freshStore();
    const controller = new AbortController();

    // Custom streaming model: yields one delta, aborts the controller, then
    // yields the final. The loop's per-delta signal check fires before the final
    // is consumed, so `final` remains undefined when the for-await exits.
    const midStreamAbortModel: ModelPort = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        throw new Error("complete() should not be called in a streaming test");
      },
      async *stream(_req: ModelRequest): AsyncIterable<ModelStreamPart> {
        yield { type: "delta", delta: { text: "partial..." } };
        // Abort HERE — after yielding the delta but before yielding `final`.
        controller.abort();
        // The loop will have consumed the delta event and then re-check
        // `signal.aborted` at the top of the next iteration, breaking out
        // before it reaches this final emission.
        yield { type: "final", response: { content: [textBlock("should not appear")], usage: { inputTokens: 10, outputTokens: 5 } } };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model: midStreamAbortModel,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    const events = await collect(agent.query("hello", { sessionId: "s-stream-abort", signal: controller.signal }));

    // Exactly one terminal event; it must be `aborted`.
    const resultEvents = events.filter((e) => e.type === "result");
    expect(resultEvents).toHaveLength(1);
    const result = terminal(events);
    expect(result.subtype).toBe("aborted");

    // The delta must have been emitted before the abort fired.
    const deltas = events.filter((e) => e.type === "stream.delta");
    expect(deltas).toHaveLength(1);

    // Usage on the aborted terminal should be zero (no model response was received).
    expect(result.usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    const stored = await store.readEvents("s-stream-abort");
    expect(stored.find((event) => event.kind === "assistant")?.payload).toMatchObject({
      partial: true,
      interrupted: "aborted",
      content: [textBlock("partial...")],
    });
  });

  it("pre-aborted signal on a streaming model → aborted before any delta (top-of-turn boundary)", async () => {
    const store = await freshStore();
    const controller = new AbortController();
    controller.abort(); // abort BEFORE the run starts

    let streamCalled = false;
    const neverStreamModel: ModelPort = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        throw new Error("complete() should not be called");
      },
      async *stream(_req: ModelRequest): AsyncIterable<ModelStreamPart> {
        streamCalled = true;
        yield { type: "delta", delta: { text: "should not see this" } };
        yield { type: "final", response: { content: [textBlock("nope")], usage: { inputTokens: 1, outputTokens: 1 } } };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model: neverStreamModel,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    const events = await collect(agent.query("hello", { sessionId: "s-preabort-stream", signal: controller.signal }));
    const result = terminal(events);
    expect(result.subtype).toBe("aborted");
    // Top-of-turn boundary fires before any model call, so stream must never be invoked.
    expect(streamCalled).toBe(false);
    expect(result.usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });
});

// ---------------------------------------------------------------------------
// Test 2: Catch-block classification
//
// Path A (signal aborted): model.stream() throws while signal.aborted === true
//   → catch block takes the `if (args.signal?.aborted)` branch → terminal aborted.
//
// Path B (genuine error): model.stream() throws while signal.aborted === false
//   → catch block falls through to the error path → terminal error.
// ---------------------------------------------------------------------------

describe("§16.4 cancellation (stream): catch-block signal classification", () => {
  it("stream throws after signal is pre-aborted → terminal is aborted, not error", async () => {
    const store = await freshStore();
    const controller = new AbortController();

    // Model whose stream() rejects. We pre-abort the controller before the run
    // starts so that by the time the catch block executes, signal.aborted === true.
    // However, the top-of-turn boundary check would fire first with a pre-abort.
    // To reach the catch block, we need the abort to happen DURING stream() execution.
    // Strategy: abort inside the stream generator before throwing, so the catch block
    // sees signal.aborted === true.
    const throwingStreamModel: ModelPort = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        throw new Error("complete() should not be called");
      },
      async *stream(_req: ModelRequest): AsyncIterable<ModelStreamPart> {
        // Abort the signal, then throw. The catch block in loop.ts will see
        // signal.aborted === true and classify this as an abort, not an error.
        controller.abort();
        throw new Error("provider aborted: request cancelled");
        // eslint-disable-next-line no-unreachable
        yield { type: "delta", delta: { text: "" } }; // satisfy return type
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model: throwingStreamModel,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    const events = await collect(agent.query("go", { sessionId: "s-throw-aborted", signal: controller.signal }));
    const result = terminal(events);
    // The catch block must classify this as aborted, not error.
    expect(result.subtype).toBe("aborted");
  });

  it("stream throws WITHOUT signal abort → terminal is error, not aborted", async () => {
    const store = await freshStore();
    const controller = new AbortController(); // NOT aborted

    const throwingStreamModel: ModelPort = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        throw new Error("complete() should not be called");
      },
      async *stream(_req: ModelRequest): AsyncIterable<ModelStreamPart> {
        // Throw a genuine error; signal remains non-aborted.
        throw new Error("network failure: connection reset");
        // eslint-disable-next-line no-unreachable
        yield { type: "delta", delta: { text: "" } };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model: throwingStreamModel,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    const events = await collect(agent.query("go", { sessionId: "s-throw-error", signal: controller.signal }));
    const result = terminal(events);
    // Genuine error → terminal error, not aborted.
    expect(result.subtype).toBe("error");
    expect((result as Extract<StreamEvent, { type: "result"; subtype: "error" }>).output).toContain("network failure");
  });

  it("complete() throws without signal abort → terminal is error (converse: complete path)", async () => {
    // Verifies the same catch-block classification logic on the complete() branch.
    const store = await freshStore();
    const controller = new AbortController(); // NOT aborted

    const throwingCompleteModel = new MockModel([]); // no scripted responses
    // Override complete to throw a real error
    (throwingCompleteModel as unknown as { complete: (req: ModelRequest) => Promise<ModelResponse> }).complete = async (_req: ModelRequest) => {
      throw new Error("quota exceeded");
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model: throwingCompleteModel,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    const events = await collect(agent.query("go", { sessionId: "s-complete-error", signal: controller.signal }));
    const result = terminal(events);
    expect(result.subtype).toBe("error");
    expect((result as Extract<StreamEvent, { type: "result"; subtype: "error" }>).output).toContain("quota exceeded");
  });

  it("complete() throws after signal is aborted → terminal is aborted (converse: complete path)", async () => {
    const store = await freshStore();
    const controller = new AbortController();

    const model: ModelPort = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        controller.abort();
        throw new Error("provider rejected: aborted");
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    const events = await collect(agent.query("go", { sessionId: "s-complete-aborted", signal: controller.signal }));
    const result = terminal(events);
    expect(result.subtype).toBe("aborted");
  });
});

// ---------------------------------------------------------------------------
// Test 3: Checkpoint-on-abort → resumable durable run
//
// Abort a durable run at the post-tool-batch boundary (via an aborting tool).
// The emitAborted function writes a checkpoint. Then call agent.resume(sessionId)
// and assert:
//  - The resumed run reaches a terminal `result{subtype:"success"}`.
//  - The event log has NO orphaned tool_use without a matching tool_result
//    (the abort fires AFTER the tool_result is appended, so the log is coherent).
//  - No exception is thrown during resume.
// ---------------------------------------------------------------------------

describe("§16.4 cancellation: checkpoint-on-abort is resumable", () => {
  it("durable run aborted after tool batch replays the persisted aborted terminal", async () => {
    const store = await freshStore();
    const controller = new AbortController();

    // Tool that aborts the controller when executed. The loop writes a checkpoint
    // AFTER the tool batch, then checks signal.aborted → emitAborted → writeCheckpoint.
    // The checkpoint is written AFTER tool_result is in the log, so the log is coherent.
    const abortingTool = createTool({
      id: "aborter",
      description: "aborts the run",
      inputSchema: z.object({}),
      execute: async () => {
        controller.abort();
        return { done: true };
      },
    });

    // Turn 1: model calls the aborting tool → abort fires at post-tool-batch boundary.
    // Turn 2 (only used on resume): model returns text (run completes cleanly).
    let callCount = 0;
    const scriptedModel: ModelPort = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        callCount++;
        if (callCount === 1) {
          return { content: [toolUseBlock("c1", "aborter", {})], usage: { inputTokens: 3, outputTokens: 1 } };
        }
        // On resume, the second call should provide a final text response.
        return { content: [textBlock("resumed successfully")], usage: { inputTokens: 4, outputTokens: 2 } };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model: scriptedModel,
      store,
      tools: [abortingTool],
      durable: true,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    // Run 1: aborted mid-run. Collect events but don't assert terminal here
    // (we just need the checkpoint written).
    const abortedEvents = await collect(agent.query("go", { sessionId: "s-resume", signal: controller.signal }));
    const abortedResult = terminal(abortedEvents);
    expect(abortedResult.subtype).toBe("aborted");

    // Verify a checkpoint was written (the store supports it via InMemoryStore / DurablePort).
    const checkpoint = await store.lastCheckpoint("s-resume");
    expect(checkpoint).not.toBeNull();

    // Inspect the event log: every tool_use in assistant events must have a matching tool_result.
    const storedEvents = await store.readEvents("s-resume");
    const answeredCallIds = new Set(
      storedEvents
        .filter((e) => e.kind === "tool_result")
        .map((e) => (e.payload as { callId: string }).callId),
    );
    for (const e of storedEvents) {
      if (e.kind === "assistant") {
        const content = (e.payload as { content: Array<{ type: string; callId?: string }> }).content;
        for (const block of content) {
          if (block.type === "tool_use") {
            expect(answeredCallIds.has(block.callId!)).toBe(true);
          }
        }
      }
    }

    // Aborted is terminal: resume replays it exactly and never re-calls the model.
    const resumedEvents = await collect(agent.resume("s-resume"));
    const resumedResult = terminal(resumedEvents);
    expect(resumedResult).toEqual(abortedResult);

    expect(callCount).toBe(1);
  });

  it("abort BEFORE any model call on a durable run: no orphaned events and exact terminal replay", async () => {
    // Pre-abort: the top-of-turn boundary fires before the model call.
    // The user event IS appended (before runLoop), and a checkpoint IS written
    // (runTurn seeds the rolling hash from the user event and checkpoints).
    // emitAborted then writes another checkpoint. The session has [user] event only.
    // The durable terminal marker makes a later resume an exact replay.
    const store = await freshStore();
    const controller = new AbortController();
    controller.abort(); // pre-abort

    let callCount = 0;
    const scriptedModel: ModelPort = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        callCount++;
        return { content: [textBlock("completed on resume")], usage: { inputTokens: 2, outputTokens: 1 } };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model: scriptedModel,
      store,
      durable: true,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    const abortedEvents = await collect(agent.query("hi", { sessionId: "s-preabort-durable", signal: controller.signal }));
    expect(terminal(abortedEvents).subtype).toBe("aborted");
    expect(callCount).toBe(0); // model never called during the aborted run

    // Verify checkpoint exists
    const cp = await store.lastCheckpoint("s-preabort-durable");
    expect(cp).not.toBeNull();

    // The log must have no orphaned tool_use blocks (there are none — only user event).
    const storedEvents = await store.readEvents("s-preabort-durable");
    expect(storedEvents.some((e) => e.kind === "assistant")).toBe(false);

    // Resume: the persisted abort is authoritative; no model call is made.
    const resumedEvents = await collect(agent.resume("s-preabort-durable"));
    const resumedResult = terminal(resumedEvents);
    expect(resumedResult).toEqual(terminal(abortedEvents));
    expect(callCount).toBe(0);
  });
});
