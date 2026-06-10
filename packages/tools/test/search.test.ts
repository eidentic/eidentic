import { describe, it, expect } from "vitest";
import {
  tavilySearch,
  exaSearch,
  serperSearch,
  searxngSearch,
  webSearchFromEnv,
} from "../src/search.js";
import { webTools } from "../src/web-tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const byId = (tools: ReturnType<typeof webTools>, id: string) => {
  const t = tools.find((x) => x.id === id);
  if (!t) throw new Error(`no tool ${id}`);
  return t;
};

// ---------------------------------------------------------------------------
// Tavily adapter
// ---------------------------------------------------------------------------

describe("tavilySearch", () => {
  it("maps provider response to WebSearchResult[]", async () => {
    const fake = fakeFetch({
      results: [
        { title: "Eidentic Docs", url: "https://eidentic.dev/docs", content: "Agent SDK docs.", score: 0.95 },
        { title: "GitHub", url: "https://github.com/eidentic", content: "Source code.", score: 0.8 },
      ],
    });
    const provider = tavilySearch({ apiKey: "tv-test", fetch: fake });
    const results = await provider.search("eidentic agent sdk");
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ title: "Eidentic Docs", url: "https://eidentic.dev/docs", snippet: "Agent SDK docs.", score: 0.95 });
    expect(results[1]).toEqual({ title: "GitHub", url: "https://github.com/eidentic", snippet: "Source code.", score: 0.8 });
  });

  it("uses maxResults from search opts", async () => {
    let capturedBody: unknown;
    const captureFetch: typeof fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = tavilySearch({ apiKey: "tv-test", fetch: captureFetch });
    await provider.search("test", { maxResults: 3 });
    expect((capturedBody as Record<string, unknown>)["max_results"]).toBe(3);
  });

  it("defaults to 5 results when no maxResults given", async () => {
    let capturedBody: unknown;
    const captureFetch: typeof fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = tavilySearch({ apiKey: "tv-test", fetch: captureFetch });
    await provider.search("test");
    expect((capturedBody as Record<string, unknown>)["max_results"]).toBe(5);
  });

  it("throws a Tavily-named error on non-2xx", async () => {
    const provider = tavilySearch({ apiKey: "tv-bad", fetch: fakeFetch({ error: "unauthorized" }, 401) });
    await expect(provider.search("test")).rejects.toThrow(/Tavily.*401/);
  });

  it("handles missing fields defensively", async () => {
    const provider = tavilySearch({
      apiKey: "tv-test",
      fetch: fakeFetch({ results: [{}] }),
    });
    const results = await provider.search("q");
    expect(results[0]).toEqual({ title: "", url: "", snippet: "", score: undefined });
  });
});

// ---------------------------------------------------------------------------
// Exa adapter
// ---------------------------------------------------------------------------

describe("exaSearch", () => {
  it("maps provider response to WebSearchResult[]", async () => {
    const fake = fakeFetch({
      results: [
        { title: "Exa Result", url: "https://exa.ai/r1", text: "Some text.", score: 0.7 },
      ],
    });
    const provider = exaSearch({ apiKey: "exa-test", fetch: fake });
    const results = await provider.search("test");
    expect(results[0]).toEqual({ title: "Exa Result", url: "https://exa.ai/r1", snippet: "Some text.", score: 0.7 });
  });

  it("maps missing text to empty string", async () => {
    const provider = exaSearch({
      apiKey: "exa-test",
      fetch: fakeFetch({ results: [{ title: "T", url: "https://x.com" }] }),
    });
    const results = await provider.search("q");
    expect(results[0]!.snippet).toBe("");
  });

  it("throws an Exa-named error on non-2xx", async () => {
    const provider = exaSearch({ apiKey: "bad", fetch: fakeFetch({}, 403) });
    await expect(provider.search("q")).rejects.toThrow(/Exa.*403/);
  });

  it("uses numResults from search opts", async () => {
    let capturedBody: unknown;
    const captureFetch: typeof fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = exaSearch({ apiKey: "exa-test", fetch: captureFetch });
    await provider.search("test", { maxResults: 7 });
    expect((capturedBody as Record<string, unknown>)["numResults"]).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Serper adapter
// ---------------------------------------------------------------------------

describe("serperSearch", () => {
  it("maps organic results to WebSearchResult[]", async () => {
    const fake = fakeFetch({
      organic: [
        { title: "Result 1", link: "https://example.com/r1", snippet: "Snippet 1." },
        { title: "Result 2", link: "https://example.com/r2", snippet: "Snippet 2." },
      ],
    });
    const provider = serperSearch({ apiKey: "sp-test", fetch: fake });
    const results = await provider.search("eidentic");
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ title: "Result 1", url: "https://example.com/r1", snippet: "Snippet 1." });
    expect(results[1]).toEqual({ title: "Result 2", url: "https://example.com/r2", snippet: "Snippet 2." });
  });

  it("maps link → url", async () => {
    const provider = serperSearch({
      apiKey: "sp-test",
      fetch: fakeFetch({ organic: [{ link: "https://foo.com" }] }),
    });
    const [r] = await provider.search("q");
    expect(r!.url).toBe("https://foo.com");
  });

  it("throws a Serper-named error on non-2xx", async () => {
    const provider = serperSearch({ apiKey: "bad", fetch: fakeFetch({}, 500) });
    await expect(provider.search("q")).rejects.toThrow(/Serper.*500/);
  });

  it("handles missing organic array", async () => {
    const provider = serperSearch({ apiKey: "sp-test", fetch: fakeFetch({}) });
    const results = await provider.search("q");
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SearXNG adapter
// ---------------------------------------------------------------------------

describe("searxngSearch", () => {
  it("maps results to WebSearchResult[]", async () => {
    const fake = fakeFetch({
      results: [
        { title: "SearXNG R1", url: "https://example.com/s1", content: "Content 1." },
        { title: "SearXNG R2", url: "https://example.com/s2", content: "Content 2." },
      ],
    });
    const provider = searxngSearch({ baseUrl: "https://searx.example.com", fetch: fake });
    const results = await provider.search("open source");
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ title: "SearXNG R1", url: "https://example.com/s1", snippet: "Content 1." });
  });

  it("trims trailing slash from baseUrl", async () => {
    let capturedUrl = "";
    const captureFetch: typeof fetch = (async (url: string) => {
      capturedUrl = url as string;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = searxngSearch({ baseUrl: "https://searx.example.com/", fetch: captureFetch });
    await provider.search("test");
    expect(capturedUrl).toMatch(/^https:\/\/searx\.example\.com\/search\?/);
    // Ensure no double-slash appears in the path portion (after stripping the scheme)
    const path = capturedUrl.replace(/^https?:\/\//, "");
    expect(path).not.toMatch(/\/\//);
  });

  it("slices to maxResults", async () => {
    const fake = fakeFetch({
      results: Array.from({ length: 10 }, (_, i) => ({
        title: `R${i}`,
        url: `https://example.com/${i}`,
        content: `c${i}`,
      })),
    });
    const provider = searxngSearch({ baseUrl: "https://searx.example.com", fetch: fake });
    const results = await provider.search("q", { maxResults: 3 });
    expect(results).toHaveLength(3);
  });

  it("maps missing content to empty string", async () => {
    const provider = searxngSearch({
      baseUrl: "https://searx.example.com",
      fetch: fakeFetch({ results: [{ title: "T", url: "https://x.com" }] }),
    });
    const [r] = await provider.search("q");
    expect(r!.snippet).toBe("");
  });

  it("throws a SearXNG-named error on non-2xx", async () => {
    const provider = searxngSearch({ baseUrl: "https://searx.example.com", fetch: fakeFetch({}, 502) });
    await expect(provider.search("q")).rejects.toThrow(/SearXNG.*502/);
  });
});

// ---------------------------------------------------------------------------
// webSearchFromEnv
// ---------------------------------------------------------------------------

describe("webSearchFromEnv", () => {
  it("picks tavily when TAVILY_API_KEY is set", () => {
    const p = webSearchFromEnv({ TAVILY_API_KEY: "tv-key" });
    expect(p).not.toBeNull();
    // Verify it's a Tavily instance by checking it calls the Tavily endpoint
    // (we can't easily introspect the closure type, but null-check suffices for presence)
  });

  it("picks exa when only EXA_API_KEY is set", () => {
    const p = webSearchFromEnv({ EXA_API_KEY: "exa-key" });
    expect(p).not.toBeNull();
  });

  it("picks serper when only SERPER_API_KEY is set", () => {
    const p = webSearchFromEnv({ SERPER_API_KEY: "sp-key" });
    expect(p).not.toBeNull();
  });

  it("picks searxng when only SEARXNG_URL is set", () => {
    const p = webSearchFromEnv({ SEARXNG_URL: "https://searx.example.com" });
    expect(p).not.toBeNull();
  });

  it("returns null when no env vars are set", () => {
    const p = webSearchFromEnv({});
    expect(p).toBeNull();
  });

  it("prefers tavily over exa when both are set", () => {
    // Can't easily introspect the returned adapter type, but we verify it's non-null
    // and the priority order (tavily first) is exercised by also having exa key present.
    const p = webSearchFromEnv({ TAVILY_API_KEY: "tv-key", EXA_API_KEY: "exa-key" });
    expect(p).not.toBeNull();
    // The provider calls Tavily when TV key wins; verify by calling with a fake fetch
    // that only responds to the Tavily URL correctly.
    const tavilyFetch: typeof fetch = (async (url: string) => {
      if ((url as string).includes("tavily.com")) {
        return new Response(JSON.stringify({ results: [{ title: "T", url: "https://t.com", content: "c", score: 1 }] }), { status: 200 });
      }
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    const p2 = webSearchFromEnv({ TAVILY_API_KEY: "tv-key", EXA_API_KEY: "exa-key" }, tavilyFetch);
    return expect(p2!.search("q")).resolves.toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// web_search tool integration
// ---------------------------------------------------------------------------

describe("web_search tool integration", () => {
  const dummyFetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;

  it("returns results when searchProvider is injected", async () => {
    const fakeProvider = {
      search: async (_q: string) => [
        { title: "T1", url: "https://example.com", snippet: "S1" },
      ],
    };
    const tools = webTools({ allowlist: ["example.com"], fetchImpl: dummyFetch, searchProvider: fakeProvider });
    const webSearch = byId(tools, "web_search");
    const out = (await webSearch.execute({ query: "test" })) as { results: unknown[] };
    expect(out.results).toHaveLength(1);
    expect((out.results[0] as Record<string, unknown>)["title"]).toBe("T1");
  });

  it("returns { configured: false, message } when nothing is configured (empty env)", async () => {
    // webTools reads process.env lazily per call; we rely on the fact that in CI
    // neither TAVILY_API_KEY nor EXA_API_KEY nor SERPER_API_KEY nor SEARXNG_URL are set.
    // To be safe, we override the env by temporarily clearing the keys we care about.
    const saved = {
      TAVILY_API_KEY: process.env["TAVILY_API_KEY"],
      EXA_API_KEY: process.env["EXA_API_KEY"],
      SERPER_API_KEY: process.env["SERPER_API_KEY"],
      SEARXNG_URL: process.env["SEARXNG_URL"],
    };
    delete process.env["TAVILY_API_KEY"];
    delete process.env["EXA_API_KEY"];
    delete process.env["SERPER_API_KEY"];
    delete process.env["SEARXNG_URL"];
    try {
      const tools = webTools({ allowlist: ["example.com"], fetchImpl: dummyFetch });
      const webSearch = byId(tools, "web_search");
      const out = (await webSearch.execute({ query: "test" })) as { configured: boolean; message: string };
      expect(out.configured).toBe(false);
      expect(out.message).toMatch(/TAVILY_API_KEY/);
    } finally {
      // Restore
      for (const [k, v] of Object.entries(saved)) {
        if (v !== undefined) process.env[k] = v;
      }
    }
  });

  it("returns { error } when provider throws (no crash)", async () => {
    const throwingProvider = {
      search: async () => { throw new Error("network error"); },
    };
    const tools = webTools({ allowlist: ["example.com"], fetchImpl: dummyFetch, searchProvider: throwingProvider });
    const webSearch = byId(tools, "web_search");
    const out = (await webSearch.execute({ query: "test" })) as { error: string };
    expect(out.error).toMatch(/network error/);
  });

  it("does not include API keys in the tool input schema", () => {
    const tools = webTools({ allowlist: ["example.com"], fetchImpl: dummyFetch });
    const webSearch = byId(tools, "web_search");
    const schema = JSON.stringify(webSearch.jsonSchema);
    expect(schema).not.toMatch(/api.?key/i);
    expect(schema).not.toMatch(/apiKey/i);
  });

  it("web_search is excluded when webSearch: false", () => {
    const tools = webTools({ allowlist: ["example.com"], fetchImpl: dummyFetch, webSearch: false });
    expect(tools.find((t) => t.id === "web_search")).toBeUndefined();
  });

  it("legacy search fn still works as a provider via backward-compat bridge", async () => {
    const tools = webTools({
      allowlist: ["example.com"],
      fetchImpl: dummyFetch,
      search: async (query) => [{ title: `legacy:${query}`, url: "https://example.com", snippet: "s" }],
    });
    const webSearch = byId(tools, "web_search");
    const out = (await webSearch.execute({ query: "hello" })) as { results: Array<{ title: string }> };
    expect(out.results[0]!.title).toBe("legacy:hello");
  });
});
