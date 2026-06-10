import { describe, it, expect } from "vitest";
import { trajectoryFromEvents } from "../src/trajectory.js";
import type { StoredEvent } from "@eidentic/types";

const ev = (seq: number, kind: StoredEvent["kind"], payload: unknown, meta?: StoredEvent["meta"]): StoredEvent =>
  ({ id: `e${seq}`, sessionId: "s1", seq, kind, schemaVersion: 1, payload, createdAt: "t", ...(meta ? { meta } : {}) });

describe("trajectoryFromEvents", () => {
  it("extracts the leading user event as input", () => {
    const events: StoredEvent[] = [ev(0, "user", "hello")];
    const t = trajectoryFromEvents(events);
    expect(t.input).toBe("hello");
    expect(t.steps).toHaveLength(0);
  });

  it("only uses the FIRST user event for input", () => {
    const events: StoredEvent[] = [ev(0, "user", "first"), ev(1, "user", "second")];
    const t = trajectoryFromEvents(events);
    expect(t.input).toBe("first");
  });

  it("converts an assistant text block to a modelCall step", () => {
    const events: StoredEvent[] = [
      ev(0, "user", "hello"),
      ev(1, "assistant", { content: [{ type: "text", text: "I will help." }] }),
    ];
    const t = trajectoryFromEvents(events);
    expect(t.steps).toHaveLength(1);
    const step = t.steps[0]!;
    expect(step.kind).toBe("modelCall");
    if (step.kind === "modelCall") {
      expect(step.text).toBe("I will help.");
      expect(step.usage).toBeUndefined();
    }
  });

  it("attaches usage from meta.usage to a modelCall step", () => {
    const events: StoredEvent[] = [
      ev(0, "user", "hello"),
      ev(1, "assistant", { content: [{ type: "text", text: "ok" }] }, { usage: { inputTokens: 10, outputTokens: 5 } }),
    ];
    const t = trajectoryFromEvents(events);
    const step = t.steps[0]!;
    expect(step.kind).toBe("modelCall");
    if (step.kind === "modelCall") {
      expect(step.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    }
  });

  it("converts a tool_use block to a toolCall step", () => {
    const events: StoredEvent[] = [
      ev(0, "user", "search for cats"),
      ev(1, "assistant", { content: [
        { type: "tool_use", callId: "c1", name: "search", input: { q: "cats" } },
      ] }),
    ];
    const t = trajectoryFromEvents(events);
    expect(t.steps).toHaveLength(2); // modelCall (empty text) + toolCall
    const toolCallStep = t.steps.find((s) => s.kind === "toolCall");
    expect(toolCallStep).toBeDefined();
    if (toolCallStep?.kind === "toolCall") {
      expect(toolCallStep.callId).toBe("c1");
      expect(toolCallStep.name).toBe("search");
      expect(toolCallStep.input).toEqual({ q: "cats" });
    }
  });

  it("emits both a modelCall and multiple toolCall steps from a single assistant event", () => {
    const events: StoredEvent[] = [
      ev(0, "user", "do things"),
      ev(1, "assistant", { content: [
        { type: "text", text: "Let me do this." },
        { type: "tool_use", callId: "c1", name: "read", input: { path: "/a" } },
        { type: "tool_use", callId: "c2", name: "write", input: { path: "/b", content: "x" } },
      ] }),
    ];
    const t = trajectoryFromEvents(events);
    expect(t.steps).toHaveLength(3);
    expect(t.steps[0]!.kind).toBe("modelCall");
    expect(t.steps[1]!.kind).toBe("toolCall");
    expect(t.steps[2]!.kind).toBe("toolCall");
    if (t.steps[1]!.kind === "toolCall") expect(t.steps[1]!.name).toBe("read");
    if (t.steps[2]!.kind === "toolCall") expect(t.steps[2]!.name).toBe("write");
  });

  it("converts a tool_result event to a toolResult step (not an error)", () => {
    const events: StoredEvent[] = [
      ev(0, "user", "go"),
      ev(1, "assistant", { content: [{ type: "tool_use", callId: "c1", name: "search", input: {} }] }),
      ev(2, "tool_result", { callId: "c1", toolName: "search", output: { result: "Paris" } }),
    ];
    const t = trajectoryFromEvents(events);
    const trStep = t.steps.find((s) => s.kind === "toolResult");
    expect(trStep).toBeDefined();
    if (trStep?.kind === "toolResult") {
      expect(trStep.callId).toBe("c1");
      expect(trStep.name).toBe("search");
      expect(trStep.output).toEqual({ result: "Paris" });
      expect(trStep.isError).toBe(false);
    }
  });

  it("detects isError=true when output is the {error: ...} shape", () => {
    const events: StoredEvent[] = [
      ev(0, "user", "go"),
      ev(1, "assistant", { content: [{ type: "tool_use", callId: "c1", name: "bad_tool", input: {} }] }),
      ev(2, "tool_result", { callId: "c1", toolName: "bad_tool", output: { error: "not found" } }),
    ];
    const t = trajectoryFromEvents(events);
    const trStep = t.steps.find((s) => s.kind === "toolResult");
    expect(trStep?.kind === "toolResult" && trStep.isError).toBe(true);
  });

  it("ignores compaction and suspension events", () => {
    const events: StoredEvent[] = [
      ev(0, "user", "go"),
      ev(1, "compaction", { before: 100, after: 50, stages: ["fifo"] }),
      ev(2, "suspension", { callId: "c1", request: { reason: "approval" } }),
      ev(3, "assistant", { content: [{ type: "text", text: "done" }] }),
    ];
    const t = trajectoryFromEvents(events);
    expect(t.steps).toHaveLength(1);
    expect(t.steps[0]!.kind).toBe("modelCall");
  });

  it("ignores checkpoint and tool_call events", () => {
    const events: StoredEvent[] = [
      ev(0, "user", "go"),
      ev(1, "checkpoint", { seq: 0, hash: "abc" }),
      ev(2, "tool_call", { callId: "c1", name: "x", input: {} }),
    ];
    const t = trajectoryFromEvents(events);
    expect(t.steps).toHaveLength(0);
  });

  it("returns empty input and steps for empty events", () => {
    const t = trajectoryFromEvents([]);
    expect(t.input).toBe("");
    expect(t.steps).toHaveLength(0);
  });

  it("is pure: same events in => identical trajectory out", () => {
    const events: StoredEvent[] = [
      ev(0, "user", "q"),
      ev(1, "assistant", { content: [{ type: "tool_use", callId: "c1", name: "search", input: { q: "x" } }] }),
      ev(2, "tool_result", { callId: "c1", toolName: "search", output: { r: "y" } }),
    ];
    const a = JSON.stringify(trajectoryFromEvents(events));
    const b = JSON.stringify(trajectoryFromEvents(events));
    expect(a).toBe(b);
  });
});
