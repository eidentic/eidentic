import { describe, expect, it } from "vitest";
import { formatDevEvent } from "../src/dev-console.js";
import { textBlock, toolUseBlock, type StreamEvent } from "@eidentic/types";

describe("formatDevEvent", () => {
  it("shows the selected model and available tools at session start", () => {
    const event: StreamEvent = {
      type: "session.init", sessionId: "s1", agentId: "assistant", model: "gpt-test", tools: ["clock"],
    };
    expect(formatDevEvent(event)).toEqual(["● model  gpt-test", "● tools  clock"]);
  });

  it("renders tool calls without exposing their potentially sensitive input", () => {
    const event: StreamEvent = {
      type: "assistant",
      content: [toolUseBlock("c1", "send_email", { token: "secret", body: "private" })],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    expect(formatDevEvent(event)).toEqual(["● tool   send_email"]);
    expect(formatDevEvent(event).join(" ")).not.toContain("secret");
  });

  it("renders tool completion without printing raw tool output", () => {
    const event: StreamEvent = {
      type: "tool.result", callId: "c1", toolName: "lookup", output: { apiKey: "secret" }, isError: false,
    };
    expect(formatDevEvent(event)).toEqual(["✓ tool   lookup"]);
  });

  it("renders terminal results with cost and strips terminal control sequences", () => {
    const event: StreamEvent = {
      type: "result", subtype: "success", output: "hello\u001b[2J\u0007world",
      usage: { inputTokens: 3, outputTokens: 2 }, numTurns: 1, sessionId: "s1",
      cost: {
        foreground: { inputTokens: 3, outputTokens: 2 },
        background: { inputTokens: 0, outputTokens: 0 },
        cachedInputTokens: 0,
        usd: 0.012,
      },
    };
    expect(formatDevEvent(event)).toEqual(["hello world", "✓ done   1 turn · $0.012000"]);
  });

  it("renders final assistant text when no stream delta was consumed", () => {
    const event: StreamEvent = {
      type: "assistant", content: [textBlock("final answer")], usage: { inputTokens: 1, outputTokens: 1 },
    };
    expect(formatDevEvent(event)).toEqual(["final answer"]);
  });
});
