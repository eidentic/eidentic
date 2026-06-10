/**
 * Schema evolution tests (§19.1 / §19.4):
 *
 * 1. upcastEvents is wired into the Session read path — a durable run that resumes
 *    through Session.open sees upcasted events (no-op at v1, but the seam is tested).
 * 2. A synthetic v0→v1 upcaster registry transforms a v0 payload on resume correctly.
 * 3. instructionsVersion is emitted in session.init when configured.
 * 4. instructionsVersion is absent from session.init when not configured (byte-identical).
 */
import { describe, it, expect } from "vitest";
import {
  InMemoryStore,
  MockModel,
} from "@eidentic/types/testing";
import {
  textBlock,
  EVENT_SCHEMA_VERSION,
  type StoredEvent,
  type Upcaster,
  type StreamEvent,
} from "@eidentic/types";
import { Session } from "../src/session.js";
import { runTurn, resumeTurn } from "../src/loop.js";
import { ToolRegistry } from "../src/tool.js";
import { upcastEvents } from "@eidentic/types";
import { Agent } from "../src/agent.js";

function deps(prefix = "id") {
  let i = 0;
  return { now: () => "2026-01-01T00:00:00.000Z", newId: () => `${prefix}_${i++}` };
}

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

// ---------------------------------------------------------------------------
// Part 1: upcastEvents no-op identity on v1 events (the seam is in place)
// ---------------------------------------------------------------------------

describe("upcastEvents — no-op at v1 (identity seam)", () => {
  it("Session.open applies upcastEvents; at v1 with no upcasters the events are identical", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    // Run a turn to populate the store with v1 events.
    const model = new MockModel([
      { content: [textBlock("done")], usage: { inputTokens: 5, outputTokens: 3 } },
    ]);
    const session1 = await Session.open(store, { sessionId: "s_noop", agentId: "a1", ...deps() });
    await collect(
      runTurn({
        agentId: "a1",
        instructions: "be helpful",
        input: "hi",
        model,
        registry: new ToolRegistry([]),
        session: session1,
        scope: { kind: "agent", agentId: "a1" },
        store,
        maxTurns: 4,
      }),
    );

    // Re-open: Session.open reads the stored events through upcastEvents.
    // All events are at schemaVersion v1 so the same array reference comes back.
    const raw = await store.readEvents("s_noop");
    const upcasted = upcastEvents(raw);
    expect(upcasted).toBe(raw); // same reference = identity pass

    // Open the session and assert events match.
    const session2 = await Session.open(store, { sessionId: "s_noop", agentId: "a1", ...deps("r") });
    const events = session2.events();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.schemaVersion === EVENT_SCHEMA_VERSION)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Part 2: synthetic v0→v1 upcaster applied to a fake-old log
// ---------------------------------------------------------------------------

describe("upcastEvents — synthetic v0→v1 upcaster replay", () => {
  it("transforms v0 events in a stored log to v1 shape via the custom upcaster", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    // Manually seed the store with a synthetic 'old' (schemaVersion=0) user event
    // whose payload is in the legacy format ({ legacyText: string }).
    await store.createSession({ id: "s_upcast", agentId: "a_upcast", createdAt: "t" });
    const legacyEvent: StoredEvent = {
      id: "legacy_evt_0",
      sessionId: "s_upcast",
      seq: 0,
      kind: "user",
      schemaVersion: 0,
      payload: { legacyText: "hello from v0" },
      createdAt: "t",
    };
    await store.appendEvents([legacyEvent]);

    // Define a v0→v1 upcaster that upgrades the payload shape.
    const upcasters: Record<number, Upcaster> = {
      0: (e) => ({
        ...e,
        schemaVersion: 1,
        payload: typeof e.payload === "string"
          ? e.payload
          : (e.payload as { legacyText: string }).legacyText,
      }),
    };

    // Open the session with the upcasters — Session.open applies them on read.
    const session = await Session.open(store, {
      sessionId: "s_upcast",
      agentId: "a_upcast",
      ...deps("up"),
      upcasters,
    });

    const events = session.events();
    expect(events).toHaveLength(1);
    expect(events[0]!.schemaVersion).toBe(EVENT_SCHEMA_VERSION); // upcasted to v1
    expect(events[0]!.payload).toBe("hello from v0"); // transformed by the upcaster
  });

  it("throws EventUnupcastableError when reading a log with a version gap and no upcaster registered", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    await store.createSession({ id: "s_gap", agentId: "a_gap", createdAt: "t" });
    const oldEvent: StoredEvent = {
      id: "gap_evt",
      sessionId: "s_gap",
      seq: 0,
      kind: "user",
      schemaVersion: 0, // too old — no upcaster registered
      payload: "whatever",
      createdAt: "t",
    };
    await store.appendEvents([oldEvent]);

    // No upcasters registered → must throw EventUnupcastableError; message names the version gap
    await expect(
      Session.open(store, { sessionId: "s_gap", agentId: "a_gap", ...deps("gap") }),
    ).rejects.toThrow(/schemaVersion 0/);
  });

  it("no-op upcast path does not regress a normal durable/resume run", async () => {
    // This asserts the existing resume test path stays green: a v1 log read through
    // Session.open with no upcasters → identical events → resumeTurn works correctly.
    const store = new InMemoryStore();
    await store.migrate();

    const model = new MockModel([
      { content: [textBlock("reply from resume")], usage: { inputTokens: 4, outputTokens: 2 } },
    ]);

    // Open + run a first turn (creates the log).
    const session1 = await Session.open(store, {
      sessionId: "s_resume_noop",
      agentId: "a_resume",
      ...deps("f"),
    });
    await collect(
      runTurn({
        agentId: "a_resume",
        instructions: "be helpful",
        input: "continue me",
        model,
        registry: new ToolRegistry([]),
        session: session1,
        scope: { kind: "agent", agentId: "a_resume" },
        store,
        maxTurns: 4,
      }),
    );

    // Re-open (simulates resume): no upcasters, v1 log → identity pass.
    const model2 = new MockModel([
      { content: [textBlock("resumed correctly")], usage: { inputTokens: 4, outputTokens: 2 } },
    ]);
    const session2 = await Session.open(store, {
      sessionId: "s_resume_noop",
      agentId: "a_resume",
      ...deps("r"),
      // upcasters: undefined → identity pass
    });

    const events2 = await collect(
      resumeTurn({
        agentId: "a_resume",
        instructions: "be helpful",
        input: "",
        model: model2,
        registry: new ToolRegistry([]),
        session: session2,
        scope: { kind: "agent", agentId: "a_resume" },
        store,
        maxTurns: 4,
      }),
    );

    // Terminal success; the run already completed (last event was a tool-less assistant) so
    // resumeTurn takes the fast-path and re-emits the result without calling the model.
    const result = events2.at(-1)!;
    expect(result.type).toBe("result");
    expect((result as Extract<StreamEvent, { type: "result" }>).subtype).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// Part 3: instructionsVersion in session.init
// ---------------------------------------------------------------------------

describe("instructionsVersion in session.init (§19.4)", () => {
  it("includes instructionsVersion in session.init when configured", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([
      { content: [textBlock("done")], usage: { inputTokens: 2, outputTokens: 1 } },
    ]);
    const session = await Session.open(store, { sessionId: "s_iv", agentId: "a_iv", ...deps() });

    const events = await collect(
      runTurn({
        agentId: "a_iv",
        instructions: "be helpful",
        input: "hello",
        model,
        registry: new ToolRegistry([]),
        session,
        scope: { kind: "agent", agentId: "a_iv" },
        store,
        maxTurns: 4,
        instructionsVersion: "v2",
      }),
    );

    const init = events.find((e) => e.type === "session.init")!;
    expect(init).toBeDefined();
    expect((init as Extract<StreamEvent, { type: "session.init" }>).instructionsVersion).toBe("v2");
  });

  it("does NOT include instructionsVersion in session.init when not configured (byte-identical)", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([
      { content: [textBlock("done")], usage: { inputTokens: 2, outputTokens: 1 } },
    ]);
    const session = await Session.open(store, { sessionId: "s_no_iv", agentId: "a_no_iv", ...deps() });

    const events = await collect(
      runTurn({
        agentId: "a_no_iv",
        instructions: "be helpful",
        input: "hello",
        model,
        registry: new ToolRegistry([]),
        session,
        scope: { kind: "agent", agentId: "a_no_iv" },
        store,
        maxTurns: 4,
        // instructionsVersion: undefined (not set)
      }),
    );

    const init = events.find((e) => e.type === "session.init")!;
    expect(init).toBeDefined();
    expect("instructionsVersion" in init).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Part 4: model.modelId flows into session.init via Agent (no config.modelId needed)
// ---------------------------------------------------------------------------

describe("Agent: model.modelId flows into session.init.model", () => {
  it("session.init.model reflects model.modelId when config.modelId is not configured", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    // Attach modelId to the MockModel to simulate AIModel wrapping a named LanguageModel
    const model = Object.assign(
      new MockModel([{ content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } }]),
      { modelId: "claude-sonnet-4-5" },
    );
    const agent = new Agent({
      id: "agnt_mid",
      instructions: "be helpful",
      model,
      store,
      now: () => "2026-01-01T00:00:00.000Z",
      newId: ((n) => () => `amidid${n++}`)(0),
      // NOTE: no modelId in config — must be inferred from model.modelId
    });
    const out: StreamEvent[] = [];
    for await (const e of agent.query("hello", { sessionId: "sess_amid" })) out.push(e);
    const init = out.find((e) => e.type === "session.init") as Extract<StreamEvent, { type: "session.init" }> | undefined;
    expect(init).toBeDefined();
    expect(init!.model).toBe("claude-sonnet-4-5");
  });

  it("config.modelId overrides model.modelId", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = Object.assign(
      new MockModel([{ content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } }]),
      { modelId: "claude-sonnet-4-5" },
    );
    const agent = new Agent({
      id: "agnt_mid2",
      instructions: "be helpful",
      model,
      store,
      now: () => "2026-01-01T00:00:00.000Z",
      newId: ((n) => () => `amid2id${n++}`)(0),
      modelId: "my-custom-model-override",
    });
    const out: StreamEvent[] = [];
    for await (const e of agent.query("hello", { sessionId: "sess_amid2" })) out.push(e);
    const init = out.find((e) => e.type === "session.init") as Extract<StreamEvent, { type: "session.init" }> | undefined;
    expect(init).toBeDefined();
    expect(init!.model).toBe("my-custom-model-override");
  });
});
