import { describe, it, expect } from "vitest";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, imageBlock, encodeMultimodalInput, decodeMultimodalInput, MULTIMODAL_INPUT_PREFIX } from "@eidentic/types";
import type {
  GuardrailPort,
  MemoryBlock,
  MemoryEvent,
  MemoryPort,
  ModelRequest,
  RetrievalQuery,
  RetrievedMemory,
  Scope,
  StreamEvent,
} from "@eidentic/types";
import { Agent } from "../src/agent.js";

const TEST_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS0AAAAASUVORK5CYII=";

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
      imageBlock({ data: TEST_PNG, mediaType: "image/png" }),
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
    expect(decoded![1]).toEqual({ type: "image", image: { data: TEST_PNG, mediaType: "image/png" } });
  });

  it("resolves a remote URL through the trusted boundary before persistence", async () => {
    const model = new MockModel([{ content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } }]);
    const store = new InMemoryStore();
    const agent = new Agent({
      id: "a", instructions: "be helpful", model, store,
      multimodal: {
        resolveRemoteImage: async (url) => {
          expect(url.href).toBe("https://example.com/pic.jpg");
          return { data: TEST_PNG, mediaType: "image/png" };
        },
      },
    });
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
    expect((imageBlockDecoded as any)?.image).toEqual({ data: TEST_PNG, mediaType: "image/png" });
    expect(JSON.stringify(await store.readEvents("s3"))).not.toContain("example.com");
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

  it("redacts multimodal text before persistence while preserving image blocks", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([
      { content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const guardrail: GuardrailPort = {
      checkInput: (text) => ({ action: "redact", text: text.replace("secret", "[REDACTED]") }),
    };
    const agent = new Agent({
      id: "a",
      instructions: "be helpful",
      model,
      store,
      guardrails: guardrail,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });
    const image = imageBlock({ data: TEST_PNG, mediaType: "image/png" });

    await runQuery(agent, [textBlock("my secret"), textBlock("stays private"), image], "mm-redact");

    const modelInput = model.calls[0]!.messages.find((message) => message.role === "user")?.content;
    expect(typeof modelInput).toBe("string");
    const modelBlocks = decodeMultimodalInput(modelInput as string);
    expect(modelBlocks).toEqual([
      textBlock("my [REDACTED] stays private"),
      textBlock(""),
      image,
    ]);

    const stored = await store.readEvents("mm-redact");
    const storedInput = stored.find((event) => event.kind === "user")?.payload;
    expect(typeof storedInput).toBe("string");
    expect(decodeMultimodalInput(storedInput as string)).toEqual(modelBlocks);
    expect(JSON.stringify(stored)).not.toContain("my secret");
  });

  it("sends only extracted text to memory, never the multimodal envelope or image bytes", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([
      { content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const retrieved: RetrievalQuery[] = [];
    const ingested: MemoryEvent[] = [];
    const memory: MemoryPort = {
      async getAlwaysInContext(_scope: Scope): Promise<MemoryBlock[]> { return []; },
      async retrieve(query: RetrievalQuery): Promise<RetrievedMemory> {
        retrieved.push(query);
        return { snippets: [] };
      },
      async ingest(events: MemoryEvent[]): Promise<void> { ingested.push(...events); },
    };
    const agent = new Agent({
      id: "a",
      instructions: "be helpful",
      model,
      store,
      memory,
      multimodal: { allowWithTools: true },
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    await runQuery(agent, [
      textBlock("describe this"),
      imageBlock({ data: TEST_PNG, mediaType: "image/png" }),
    ], "mm-memory");

    expect(retrieved.map((query) => query.text)).toEqual(["describe this"]);
    expect(ingested[0]?.text).toBe("describe this");
    expect(JSON.stringify({ retrieved, ingested })).not.toContain(MULTIMODAL_INPUT_PREFIX);
    expect(JSON.stringify({ retrieved, ingested })).not.toContain(TEST_PNG);
  });

  it("fails closed for raw remote URLs, invalid bytes, and tool-enabled vision", async () => {
    const remote = makeAgent(new MockModel([{ content: [textBlock("unused")], usage: { inputTokens: 1, outputTokens: 1 } }])).agent;
    await expect(runQuery(remote, [imageBlock({ url: "https://example.com/a.png" })], "remote-denied"))
      .rejects.toThrow(/resolveRemoteImage/);

    const invalid = makeAgent(new MockModel([{ content: [textBlock("unused")], usage: { inputTokens: 1, outputTokens: 1 } }])).agent;
    await expect(runQuery(invalid, [imageBlock({ data: "aGVsbG8=", mediaType: "image/png" })], "invalid-image"))
      .rejects.toThrow(/PNG header/);

    const store = new InMemoryStore();
    const toolAgent = new Agent({
      id: "tool-agent",
      instructions: "",
      model: new MockModel([{ content: [textBlock("unused")], usage: { inputTokens: 1, outputTokens: 1 } }]),
      store,
      tools: [{
        id: "read",
        description: "read",
        sideEffect: "read-only",
        requiredSecrets: [],
        jsonSchema: {},
        parse: (input) => ({ ok: true as const, value: input }),
        execute: async () => null,
      }],
    });
    await expect(runQuery(toolAgent, [imageBlock({ data: TEST_PNG, mediaType: "image/png" })], "tool-denied"))
      .rejects.toThrow(/allowWithTools/);
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
