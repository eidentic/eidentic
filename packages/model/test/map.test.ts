import { describe, it, expect } from "vitest";
import type { ModelMessage as KMsg } from "@eidentic/types";
import { encodeMultimodalInput } from "@eidentic/types";
import { mapMessages, buildTools, mapResult } from "../src/map.js";

describe("mapMessages", () => {
  it("extracts system messages into the instructions option and maps the rest", () => {
    const input: KMsg[] = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "tool_use", callId: "c0", name: "search", input: { query: "x" } },
        ],
      },
      { role: "tool", callId: "c0", toolName: "search", content: JSON.stringify({ ok: true }) },
    ];
    const { instructions, messages } = mapMessages(input);
    expect(instructions).toBe("you are helpful");
    expect(messages[0]).toEqual({ role: "user", content: "hi" });
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "let me check" },
        { type: "tool-call", toolCallId: "c0", toolName: "search", input: { query: "x" } },
      ],
    });
    expect(messages[2]).toEqual({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "c0", toolName: "search", output: { type: "text", value: JSON.stringify({ ok: true }) } }],
    });
  });

  it("concatenates multiple system messages and supports string user content", () => {
    const { instructions, messages } = mapMessages([
      { role: "system", content: "a" },
      { role: "system", content: "b" },
      { role: "user", content: "q" },
    ]);
    expect(instructions).toBe("a\n\nb");
    expect(messages).toEqual([{ role: "user", content: "q" }]);
  });

  it("drops thinking blocks from assistant content", () => {
    const { messages } = mapMessages([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "internal reasoning" },
          { type: "text", text: "visible answer" },
        ],
      },
    ]);
    expect(messages[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "visible answer" }] });
  });

  it("omits an assistant message that maps to empty content (thinking-only)", () => {
    const { messages } = mapMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "thinking", text: "internal" }] },
      { role: "user", content: "again" },
    ]);
    expect(messages).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "again" },
    ]);
  });

  it("round-trips an assistant message with multiple tool calls and their results", () => {
    const input: KMsg[] = [
      { role: "user", content: "do two things" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", callId: "a", name: "t1", input: { x: 1 } },
          { type: "tool_use", callId: "b", name: "t2", input: { y: 2 } },
        ],
      },
      { role: "tool", callId: "a", toolName: "t1", content: "r1" },
      { role: "tool", callId: "b", toolName: "t2", content: "r2" },
    ];
    const { messages } = mapMessages(input);
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "a", toolName: "t1", input: { x: 1 } },
        { type: "tool-call", toolCallId: "b", toolName: "t2", input: { y: 2 } },
      ],
    });
    expect(messages[2]).toEqual({ role: "tool", content: [{ type: "tool-result", toolCallId: "a", toolName: "t1", output: { type: "text", value: "r1" } }] });
    expect(messages[3]).toEqual({ role: "tool", content: [{ type: "tool-result", toolCallId: "b", toolName: "t2", output: { type: "text", value: "r2" } }] });
  });
});

describe("mapMessages — cacheControl", () => {
  const msgs: KMsg[] = [
    { role: "system", content: "be helpful" },
    { role: "user", content: "hi" },
  ];

  it("cacheControl: true → returns a SystemModelMessage with Anthropic ephemeral breakpoint", () => {
    const { instructions, messages } = mapMessages(msgs, { cacheControl: true });
    expect(typeof instructions).toBe("object");
    expect((instructions as any).role).toBe("system");
    expect((instructions as any).content).toBe("be helpful");
    expect((instructions as any).providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: "user", content: "hi" });
  });

  it("cacheControl: false → returns a plain string (back-compat)", () => {
    const { instructions } = mapMessages(msgs, { cacheControl: false });
    expect(instructions).toBe("be helpful");
  });

  it("no opts → returns a plain string (back-compat)", () => {
    const { instructions } = mapMessages(msgs);
    expect(instructions).toBe("be helpful");
  });

  it("cacheControl: true with no system messages → instructions is undefined (no marker injected)", () => {
    const { instructions } = mapMessages([{ role: "user", content: "hi" }], { cacheControl: true });
    expect(instructions).toBeUndefined();
  });

  it("cacheControl: true with multiple system messages → concatenated text in SystemModelMessage", () => {
    const { instructions } = mapMessages(
      [{ role: "system", content: "a" }, { role: "system", content: "b" }, { role: "user", content: "q" }],
      { cacheControl: true },
    );
    expect(typeof instructions).toBe("object");
    expect((instructions as any).content).toBe("a\n\nb");
    expect((instructions as any).providerOptions?.anthropic?.cacheControl?.type).toBe("ephemeral");
  });
});

describe("buildTools", () => {
  it("builds an AI SDK ToolSet keyed by tool name with the JSON schema", () => {
    const tools = buildTools([
      { name: "search", description: "Search", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
    ]);
    expect(Object.keys(tools)).toEqual(["search"]);
    expect(tools.search).toBeDefined();
  });
});

describe("mapResult", () => {
  it("maps text + tool calls + usage into a ModelResponse", () => {
    const r = mapResult({
      text: "hello",
      toolCalls: [{ type: "tool-call", toolCallId: "c1", toolName: "search", input: { q: "x" } }],
      usage: { inputTokens: 80, outputTokens: 30, totalTokens: 110 },
    } as any);
    expect(r).toEqual({
      content: [
        { type: "text", text: "hello" },
        { type: "tool_use", callId: "c1", name: "search", input: { q: "x" } },
      ],
      usage: { inputTokens: 80, outputTokens: 30 },
    });
  });

  it("defaults missing usage tokens to 0 and omits empty text", () => {
    const r = mapResult({ text: "", toolCalls: [], usage: {} } as any);
    expect(r.content).toEqual([]);
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("mapMessages — multimodal image input", () => {
  it("maps a user message with ContentBlock[] containing an image+text to AI SDK parts", () => {
    const blocks = [
      { type: "text" as const, text: "What is in this image?" },
      { type: "image" as const, image: { data: "aGVsbG8=", mediaType: "image/jpeg" } },
    ];
    const msg: KMsg = { role: "user", content: blocks };
    const { messages } = mapMessages([msg]);
    expect(messages).toHaveLength(1);
    const userMsg = messages[0];
    expect(userMsg?.role).toBe("user");
    expect(Array.isArray(userMsg?.content)).toBe(true);
    const parts = userMsg?.content as any[];
    const textPart = parts.find((p) => p.type === "text");
    const imagePart = parts.find((p) => p.type === "image");
    expect(textPart?.text).toBe("What is in this image?");
    expect(imagePart).toBeDefined();
    expect(imagePart?.image).toBe("aGVsbG8=");
    expect(imagePart?.mediaType).toBe("image/jpeg");
  });

  it("denies a URL image block by default", () => {
    const blocks = [
      { type: "text" as const, text: "Describe this." },
      { type: "image" as const, image: { url: "https://example.com/cat.jpg" } },
    ];
    const msg: KMsg = { role: "user", content: blocks };
    expect(() => mapMessages([msg])).toThrow(/remote image URLs are denied/);
  });

  it("retains an explicitly unsafe compatibility path for provider-side image fetching", () => {
    const blocks = [
      { type: "text" as const, text: "Describe this." },
      { type: "image" as const, image: { url: "https://example.com/cat.jpg" } },
    ];
    const msg: KMsg = { role: "user", content: blocks };
    const { messages } = mapMessages([msg], { unsafeAllowRemoteImageUrls: true });
    const parts = messages[0]?.content as any[];
    const imagePart = parts.find((p) => p.type === "image");
    expect(imagePart?.image).toBeInstanceOf(URL);
    expect((imagePart?.image as URL).href).toBe("https://example.com/cat.jpg");
  });

  it("decodes a multimodal-encoded user event string (from Agent.query) to image parts", () => {
    const blocks = [
      { type: "text" as const, text: "check this image" },
      { type: "image" as const, image: { data: "base64data==", mediaType: "image/png" } },
    ];
    const encoded = encodeMultimodalInput(blocks);
    // Simulate what appendEventToMessages does: user event payload → String(payload)
    const msg: KMsg = { role: "user", content: encoded };
    const { messages } = mapMessages([msg]);
    expect(messages).toHaveLength(1);
    const parts = messages[0]?.content as any[];
    expect(Array.isArray(parts)).toBe(true);
    const imagePart = parts.find((p: any) => p.type === "image");
    expect(imagePart).toBeDefined();
    expect(imagePart?.image).toBe("base64data==");
  });

  it("plain-text user message is unchanged (back-compat)", () => {
    const { messages } = mapMessages([{ role: "user", content: "hello" }]);
    expect(messages[0]).toEqual({ role: "user", content: "hello" });
  });

  it("text-only ContentBlock[] collapses to a plain string (back-compat)", () => {
    const blocks = [
      { type: "text" as const, text: "hello" },
      { type: "text" as const, text: " world" },
    ];
    const { messages } = mapMessages([{ role: "user", content: blocks }]);
    // No images → collapsed to string
    expect(messages[0]).toEqual({ role: "user", content: "hello world" });
  });
});
