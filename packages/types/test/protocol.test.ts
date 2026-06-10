import { describe, it, expect } from "vitest";
import { textBlock, toolUseBlock, isToolUse } from "../src/protocol.js";

describe("protocol content blocks", () => {
  it("builds a text block", () => {
    expect(textBlock("hi")).toEqual({ type: "text", text: "hi" });
  });

  it("builds and detects a tool_use block", () => {
    const b = toolUseBlock("c1", "lookup", { id: 7 });
    expect(b).toEqual({ type: "tool_use", callId: "c1", name: "lookup", input: { id: 7 } });
    expect(isToolUse(b)).toBe(true);
    expect(isToolUse(textBlock("x"))).toBe(false);
  });
});
