import { describe, it, expect } from "vitest";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, imageBlock, encodeMultimodalInput, decodeMultimodalInput, MULTIMODAL_INPUT_PREFIX } from "@eidentic/types";
import type { StreamEvent, ModelRequest } from "@eidentic/types";
import { Agent } from "../src/agent.js";

/**
 * Tests that Agent.query() correctly encodes multimodal image input so it is preserved
 * in the event log and can be decoded by mapMessages into AI SDK ImageParts.
 *
 * We use MockModel (the Eidentic ModelPort mock) and inspect `MockModel.calls[0].messages`
 * to verify that the encoded user message reaches the model layer correctly.
 * The actual AI SDK ImagePart mapping is tested in packages/model/test/map.test.ts.
 */

async function runQuery(agent: Agent, input: string | any[], sessionId: string): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of agent.query(input, { sessionId })) out.push(ev);
  return out;
}

function makeAgent(model: MockModel) {
  const store = new InMemoryStore();
  return { store, agent: new Agent({
    id: "a", instructions: "be helpful",
    model, store,
    now: () => "t",
    newId: ((n) => () => `e${n++}`)(0),
  })};
}

describe("Agent.query — multimodal image input (MockModel)", () => {
  it("plain string input is unchanged (back-compat)", async () => {
    const model = new MockModel([{ content: [textBlock("hi")], usage: { inputTokens: 1, outputTokens: 1 } }]);
    const { store, agent } = makeAgent(model);
    await store.migrate();
    const events = await runQuery(agent, "hello", "s1");
    expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success" });
    // Plain string → user message content is the plain string
    const req: ModelRequest = model.calls[0]!;
    const userMsg = req.messages.find((m) => m.role === "user");
    expect(typeof userMsg?.content).toBe("string");
    expect(userMsg?.content).toBe("hello");
  });

  it("ContentBlock[] with image block encodes as a multimodal sentinel string in the model request", async () => {
    const model = new MockModel([{ content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } }]);
    const { store, agent } = makeAgent(model);
    await store.migrate();

    const input = [
      textBlock("What is in this image?"),
      imageBlock({ data: "aGVsbG8=", mediaType: "image/jpeg" }),
    ];
    const events = await runQuery(agent, input, "s2");
    expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success" });

    // The user message in the model request should be the encoded multimodal string.
    const req: ModelRequest = model.calls[0]!;
    const userMsg = req.messages.find((m) => m.role === "user");
    expect(typeof userMsg?.content).toBe("string");
    const encoded = userMsg?.content as string;
    // Starts with the multimodal sentinel
    expect(encoded.startsWith(MULTIMODAL_INPUT_PREFIX)).toBe(true);

    // Decode the sentinel and verify the original blocks are preserved.
    const decoded = decodeMultimodalInput(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded).toHaveLength(2);
    expect(decoded![0]).toEqual({ type: "text", text: "What is in this image?" });
    expect(decoded![1]).toEqual({ type: "image", image: { data: "aGVsbG8=", mediaType: "image/jpeg" } });
  });

  it("ContentBlock[] with URL image block encodes the URL in the sentinel string", async () => {
    const model = new MockModel([{ content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } }]);
    const { store, agent } = makeAgent(model);
    await store.migrate();

    const input = [
      textBlock("Describe this picture."),
      imageBlock({ url: "https://example.com/pic.jpg" }),
    ];
    await runQuery(agent, input, "s3");
    const req: ModelRequest = model.calls[0]!;
    const userMsg = req.messages.find((m) => m.role === "user");
    const decoded = decodeMultimodalInput(userMsg?.content as string);
    expect(decoded).not.toBeNull();
    const imageBlockDecoded = decoded!.find((b) => b.type === "image");
    expect((imageBlockDecoded as any)?.image?.url).toBe("https://example.com/pic.jpg");
  });

  it("text-only ContentBlock[] is collapsed to a plain string (no sentinel encoding)", async () => {
    const model = new MockModel([{ content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } }]);
    const { store, agent } = makeAgent(model);
    await store.migrate();

    const input = [textBlock("just text"), textBlock(" and more text")];
    await runQuery(agent, input, "s4");
    const req: ModelRequest = model.calls[0]!;
    const userMsg = req.messages.find((m) => m.role === "user");
    // Text-only → collapsed to plain string, no sentinel prefix
    expect(typeof userMsg?.content).toBe("string");
    expect((userMsg?.content as string).startsWith(MULTIMODAL_INPUT_PREFIX)).toBe(false);
    expect(userMsg?.content).toContain("just text");
  });
});

describe("encodeMultimodalInput / decodeMultimodalInput round-trip", () => {
  it("encodes and decodes ContentBlock[] faithfully", () => {
    const blocks = [textBlock("hi"), imageBlock({ data: "abc123" })];
    const encoded = encodeMultimodalInput(blocks);
    expect(typeof encoded).toBe("string");
    expect(encoded.startsWith(MULTIMODAL_INPUT_PREFIX)).toBe(true);
    const decoded = decodeMultimodalInput(encoded);
    expect(decoded).toEqual(blocks);
  });

  it("decodeMultimodalInput returns null for plain text", () => {
    expect(decodeMultimodalInput("hello world")).toBeNull();
    expect(decodeMultimodalInput("")).toBeNull();
  });

  it("decodeMultimodalInput returns null for malformed JSON after prefix", () => {
    expect(decodeMultimodalInput(MULTIMODAL_INPUT_PREFIX + "{broken")).toBeNull();
  });
});
