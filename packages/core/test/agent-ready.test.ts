import { describe, it, expect } from "vitest";
import type { LoggerPort } from "@eidentic/types";
import { textBlock } from "@eidentic/types";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { Agent } from "../src/agent.js";

const reply = () => ({ content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } });

// Minimal memory stub: enough for the loop (ingest / getAlwaysInContext / retrieve) to run.
const fakeMemory = {
  getAlwaysInContext: async () => [],
  retrieve: async () => ({ snippets: [] }),
  ingest: async () => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe("Agent readiness (lazy migrate + memory userId warning)", () => {
  it("runs query() without an explicit store.migrate()", async () => {
    const store = new InMemoryStore(); // intentionally NOT migrated
    const agent = new Agent({ id: "a", instructions: "x", model: new MockModel([reply()]), store });
    let last: { subtype?: string } | undefined;
    for await (const ev of agent.query("hi", { sessionId: "s1" })) last = ev as { subtype?: string };
    expect(last?.subtype).toBe("success");
  });

  it("warns exactly once when memory is configured but userId is omitted", async () => {
    const warnings: string[] = [];
    const logger: LoggerPort = {
      log: (level, ns, msg) => {
        if (level === "warn" && ns === "eidentic:memory") warnings.push(msg);
      },
    };
    const agent = new Agent({
      id: "a",
      instructions: "x",
      model: new MockModel([reply(), reply()]),
      store: new InMemoryStore(),
      memory: fakeMemory,
      logger,
    });
    for await (const _ of agent.query("one", { sessionId: "s1" })) { /* no userId */ }
    for await (const _ of agent.query("two", { sessionId: "s2" })) { /* no userId */ }
    expect(warnings).toHaveLength(1); // once per agent, not per query
    expect(warnings[0]).toMatch(/userId/);
  });

  it("does NOT warn when userId is provided", async () => {
    const warnings: string[] = [];
    const logger: LoggerPort = {
      log: (level, ns) => {
        if (level === "warn" && ns === "eidentic:memory") warnings.push(ns);
      },
    };
    const agent = new Agent({
      id: "a",
      instructions: "x",
      model: new MockModel([reply()]),
      store: new InMemoryStore(),
      memory: fakeMemory,
      logger,
    });
    for await (const _ of agent.query("hi", { sessionId: "s1", userId: "u1" })) { /* with userId */ }
    expect(warnings).toHaveLength(0);
  });
});
