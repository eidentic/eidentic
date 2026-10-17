import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "@eidentic/core";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock } from "@eidentic/types";
import { webTools } from "../src/web-tools.js";
import { parallelSearch } from "../src/parallel-search.js";

const envKeys = ["TAVILY_API_KEY", "EXA_API_KEY", "SERPER_API_KEY", "SEARXNG_URL"];
function emptyEnv() {
  for (const key of envKeys) vi.stubEnv(key, undefined);
}
afterEach(() => vi.unstubAllEnvs());

const result = {
  results: [{ title: "Eidentic", url: "https://eidentic.dev/docs", excerpts: ["Agent SDK documentation.", "Supports tools."] }],
  session_id: "server-session",
};

function mcpFixture(payload: unknown = result, isError = false) {
  const requests: Array<{ url: string; headers: Headers; body?: any }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ url: String(url), headers: new Headers(init?.headers), body });
    if (!body) return new Response(null, { status: 405 });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const response = body.method === "initialize"
      ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : body.method === "tools/list"
        ? { tools: [{ name: "web_search", inputSchema: { type: "object", properties: {} } }] }
        : { content: [], structuredContent: payload, isError };
    return Response.json({ jsonrpc: "2.0", id: body.id, result: response });
  };
  return { fetchImpl, requests };
}

describe("Parallel Search MCP default", () => {
  it("resolves without keys and feeds source excerpts through the agent loop", async () => {
    emptyEnv();
    const fixture = mcpFixture();
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([
      { content: [toolUseBlock("search-1", "web_search", { query: "Eidentic agent SDK docs" })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("Found the documentation.")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent = new Agent({ id: "research", instructions: "Research documentation.", model, store, tools: webTools({ fetchImpl: fixture.fetchImpl }) });
    const events = [];
    for await (const event of agent.query("Find Eidentic documentation", { sessionId: "research-session" })) events.push(event);
    expect(events.find((event) => event.type === "tool.result")).toMatchObject({
      output: { results: [{ title: "Eidentic", url: "https://eidentic.dev/docs", snippet: "Agent SDK documentation.\n\nSupports tools." }] },
    });
    const consumed = model.calls[1]!.messages.find((message) => message.role === "tool");
    expect(consumed).toMatchObject({ toolName: "web_search" });
    expect(JSON.parse(consumed!.content as string).results[0].url).toBe("https://eidentic.dev/docs");
    expect(consumed!.content).toContain("Agent SDK documentation.");
    expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success" });
    expect(fixture.requests.map((request) => request.body?.method)).toContain("tools/list");
    expect(fixture.requests.find((request) => request.body?.method === "tools/call")?.body.params).toMatchObject({ name: "web_search", arguments: { objective: "Eidentic agent SDK docs", search_queries: ["Eidentic agent SDK docs"] } });
    for (const request of fixture.requests) {
      expect(request.url).toBe("https://search.parallel.ai/mcp");
      expect(request.headers.get("user-agent")).toContain("eidentic");
      expect(request.headers.has("authorization")).toBe(false);
    }
  });
});


describe("Parallel adapter boundaries", () => {
  it("limits results and omits unsafe result URLs", async () => {
    const fixture = mcpFixture({ results: [
      { url: "javascript:alert(1)", excerpts: ["bad"] },
      { url: "https://user:pass@example.com", excerpts: ["credentials"] },
      { url: "https://example.com/a", title: null, excerpts: ["one", "two"] },
      { url: "https://example.com/b", excerpts: [] },
    ] });
    const provider = parallelSearch({ fetch: fixture.fetchImpl, maxResults: 2 });
    expect(await provider.search("query", { maxResults: 1 })).toEqual([{ title: "", url: "https://example.com/a", snippet: "one\n\ntwo" }]);
  });

  it("rejects malformed provider data instead of reporting an empty success", async () => {
    await expect(parallelSearch({ fetch: mcpFixture({ unrelated: [] }).fetchImpl }).search("query")).rejects.toThrow(/Parallel.*response/i);
  });

  it("surfaces MCP tool errors", async () => {
    await expect(parallelSearch({ fetch: mcpFixture(result, true).fetchImpl }).search("query")).rejects.toThrow(/Parallel/i);
  });

  it.each([401, 429, 500])("surfaces HTTP %s without retrying or changing providers", async (status) => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => { calls++; return new Response("request rejected", { status }); };
    await expect(parallelSearch({ fetch: fetchImpl }).search("query")).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it.each(["initialize", "tools/list", "tools/call"])("cancels an in-flight %s", async (method) => {
    const fixture = mcpFixture();
    const controller = new AbortController();
    const fetchImpl: typeof fetch = async (url, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (body?.method !== method) return fixture.fetchImpl(url, init);
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
        controller.abort();
      });
    };
    await expect(parallelSearch({ fetch: fetchImpl }).search("query", { signal: controller.signal })).rejects.toThrow();
  });

  it("does not send requests after pre-cancellation", async () => {
    const fixture = mcpFixture();
    const controller = new AbortController();
    controller.abort();
    await expect(parallelSearch({ fetch: fixture.fetchImpl }).search("query", { signal: controller.signal })).rejects.toThrow();
    expect(fixture.requests).toHaveLength(0);
  });

  it("times out a stalled transport", async () => {
    const fetchImpl: typeof fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
    await expect(parallelSearch({ fetch: fetchImpl, timeoutMs: 20 }).search("query")).rejects.toThrow(/timeout|abort/i);
  });
});

describe("webTools preserves provider choices and controls", () => {
  it("prefers injected providers to legacy callbacks and environment credentials", async () => {
    vi.stubEnv("TAVILY_API_KEY", "fixture-key");
    const fixture = mcpFixture();
    const legacy = vi.fn(async () => []);
    const tools = webTools({ fetchImpl: fixture.fetchImpl, search: legacy, searchProvider: { search: async () => [{ title: "chosen", url: "https://example.com", snippet: "saved" }] } });
    expect(await tools.find((tool) => tool.id === "web_search")!.execute({ query: "query" })).toMatchObject({ results: [{ title: "chosen" }] });
    expect(legacy).not.toHaveBeenCalled();
    expect(fixture.requests).toHaveLength(0);
  });

  it("prefers the legacy callback to environment credentials", async () => {
    vi.stubEnv("TAVILY_API_KEY", "fixture-key");
    const fixture = mcpFixture();
    const tools = webTools({ fetchImpl: fixture.fetchImpl, search: async () => [{ title: "legacy", url: "https://example.com", snippet: "saved" }] });
    expect(await tools.find((tool) => tool.id === "web_search")!.execute({ query: "query" })).toMatchObject({ results: [{ title: "legacy" }] });
    expect(fixture.requests).toHaveLength(0);
  });

  it.each([
    ["TAVILY_API_KEY", "fixture-key", "https://api.tavily.com/search"],
    ["EXA_API_KEY", "fixture-key", "https://api.exa.ai/search"],
    ["SERPER_API_KEY", "fixture-key", "https://google.serper.dev/search"],
    ["SEARXNG_URL", "https://searx.example.com", "https://searx.example.com/search?q=query&format=json"],
  ])("preserves configured %s", async (key, value, endpoint) => {
    emptyEnv(); vi.stubEnv(key, value);
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => { urls.push(String(url)); return Response.json({ results: [], organic: [] }); };
    const tools = webTools({ fetchImpl });
    expect(await tools.find((tool) => tool.id === "web_search")!.execute({ query: "query" })).toEqual({ results: [] });
    expect(urls).toEqual([endpoint]);
  });

  it("returns an explicit provider's error without falling back", async () => {
    emptyEnv();
    const fixture = mcpFixture();
    const tools = webTools({ fetchImpl: fixture.fetchImpl, searchProvider: { search: async () => { throw new Error("chosen provider failed"); } } });
    expect(await tools.find((tool) => tool.id === "web_search")!.execute({ query: "query" })).toEqual({ error: "chosen provider failed" });
    expect(fixture.requests).toHaveLength(0);
  });

  it("does not enable disabled search", () => {
    const fixture = mcpFixture();
    expect(webTools({ webSearch: false, fetchImpl: fixture.fetchImpl }).some((tool) => tool.id === "web_search")).toBe(false);
    expect(fixture.requests).toHaveLength(0);
  });

  it("never contacts search when the agent denies the tool", async () => {
    emptyEnv();
    const fixture = mcpFixture();
    const store = new InMemoryStore(); await store.migrate();
    const model = new MockModel([
      { content: [toolUseBlock("denied", "web_search", { query: "query" })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("Denied.")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent = new Agent({ id: "denied-search", instructions: "", model, store, permissions: { default: "deny" }, tools: webTools({ fetchImpl: fixture.fetchImpl }) });
    const events = [];
    for await (const event of agent.query("query", { sessionId: "denied-session" })) events.push(event);
    expect(events.find((event) => event.type === "tool.result")).toMatchObject({ isError: true });
    expect(fixture.requests).toHaveLength(0);
  });
});

it("accepts text-only JSON MCP results", async () => {
  const fixture = mcpFixture();
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (body?.method === "tools/call") {
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
    }
    return fixture.fetchImpl(url, init);
  };
  expect(await parallelSearch({ fetch: fetchImpl }).search("query")).toHaveLength(1);
});

it.runIf(process.env["EIDENTIC_PARALLEL_LIVE"] === "1")("live anonymous search through Agent.query (scripted model)", async () => {
  emptyEnv();
  const observed: Array<{ url: string; userAgent: string | null; authorized: boolean }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    observed.push({ url: String(url), userAgent: headers.get("user-agent"), authorized: headers.has("authorization") });
    return globalThis.fetch(url, init);
  };
  const store = new InMemoryStore(); await store.migrate();
  const model = new MockModel([
    { content: [toolUseBlock("live-search", "web_search", { query: "Eidentic TypeScript agent SDK documentation", maxResults: 2 })], usage: { inputTokens: 1, outputTokens: 1 } },
    { content: [textBlock("Sources received.")], usage: { inputTokens: 1, outputTokens: 1 } },
  ]);
  const agent = new Agent({ id: "live-research", instructions: "Find documentation.", model, store, tools: webTools({ fetchImpl }) });
  for await (const _event of agent.query("Find Eidentic documentation", { sessionId: "live-research" })) { /* consume */ }
  const message = model.calls[1]!.messages.find((message) => message.role === "tool")!;
  const output = JSON.parse(message.content as string);
  expect(output.error, JSON.stringify(output)).toBeUndefined();
  expect(output.results.length).toBeGreaterThan(0);
  expect(output.results[0].snippet.length).toBeGreaterThan(0);
  expect(output.results[0].url).toMatch(/^https?:\/\//);
  expect(observed.length).toBeGreaterThanOrEqual(3);
  expect(observed.every((request) => request.url === "https://search.parallel.ai/mcp" && request.userAgent?.includes("eidentic") && !request.authorized)).toBe(true);
});


it("forwards the tool context cancellation signal to the default provider", async () => {
  emptyEnv();
  const fixture = mcpFixture();
  const controller = new AbortController();
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (body?.method !== "tools/call") return fixture.fetchImpl(url, init);
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      controller.abort();
    });
  };
  const tool = webTools({ fetchImpl }).find((tool) => tool.id === "web_search")!;
  const output = await tool.execute({ query: "query" }, { signal: controller.signal });
  expect(output).toMatchObject({ error: expect.stringMatching(/abort/i) });
});
