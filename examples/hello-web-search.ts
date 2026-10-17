/**
 * Pluggable web-search system demonstration.
 *
 * Shows:
 *   1. A fake WebSearchPort (canned results) wired into a MockModel agent — web_search
 *      tool call flows end-to-end through dispatch and produces results.
 *   2. Explicit search disable; webSearchFromEnv still returns null for an empty env.
 *   3. The env auto-detect priority: TAVILY_API_KEY > EXA_API_KEY > SERPER_API_KEY > SEARXNG_URL.
 *
 * Infra-free — no real API keys required. Run:  pnpm hello:web-search
 */
import { Agent } from "@eidentic/core";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock } from "@eidentic/types";
import { webTools, webSearchFromEnv } from "@eidentic/tools";
import type { WebSearchPort } from "@eidentic/tools";

// ---------------------------------------------------------------------------
// PART 1 — Fake provider wired into an agent; model calls web_search
// ---------------------------------------------------------------------------

const fakeProvider: WebSearchPort = {
  async search(query) {
    // Canned results — no real network call.
    return [
      { title: "Eidentic — open-source TS agentic AI SDK", url: "https://eidentic.dev", snippet: `Top result for: ${query}`, score: 0.99 },
      { title: "Eidentic GitHub", url: "https://github.com/eidentic/eidentic", snippet: "Source code and issues.", score: 0.92 },
    ];
  },
};

const dummyFetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;

const tools = webTools({
  allowlist: ["eidentic.dev", "github.com"],
  fetchImpl: dummyFetch,
  searchProvider: fakeProvider,
});

const model = new MockModel([
  // Turn 1: model calls web_search
  {
    content: [toolUseBlock("c1", "web_search", { query: "eidentic agent sdk" })],
    usage: { inputTokens: 5, outputTokens: 3 },
  },
  // Turn 2: model reads the results and answers
  {
    content: [textBlock("Based on the search results, Eidentic is an open-source TypeScript agentic AI SDK.")],
    usage: { inputTokens: 12, outputTokens: 8 },
  },
]);

const store = new InMemoryStore();
await store.migrate();

const agent = new Agent({
  id: "web-search-demo",
  instructions: "You are a research assistant. Use web_search to answer questions.",
  model,
  store,
  tools,
});

console.log("=== PART 1: web_search with fake provider (canned results) ===");
for await (const ev of agent.query("What is Eidentic?", { sessionId: "s1" })) {
  if (ev.type === "tool.result") {
    const out = ev.output as { results?: unknown[]; configured?: boolean; error?: string };
    if (out.results) {
      console.log(`tool.result  web_search  →  ${(out.results as unknown[]).length} results`);
      for (const r of out.results as Array<{ title: string; url: string; snippet: string; score?: number }>) {
        console.log(`  [${r.score?.toFixed(2) ?? "—"}]  ${r.title}`);
        console.log(`         ${r.url}`);
        console.log(`         ${r.snippet}`);
      }
    }
  }
  if (ev.type === "result") {
    console.log("\nagent answer:", ev.subtype === "success" ? ev.output : ev.subtype);
  }
}

// ---------------------------------------------------------------------------
// PART 2 — explicit search disable (the no-key default is now Parallel MCP)
// ---------------------------------------------------------------------------

console.log("\n=== PART 2: explicit search disable ===");
console.log("webSearchFromEnv({}) →", webSearchFromEnv({})); // null: no configured env provider
const disabledTools = webTools({ allowlist: [], webSearch: false });
console.log("web_search tool present:", disabledTools.some((tool) => tool.id === "web_search")); // false

// ---------------------------------------------------------------------------
// PART 3 — env auto-detect priority demonstration
// ---------------------------------------------------------------------------

console.log("\n=== PART 3: env auto-detect priority order ===");

const priorities: Array<[string, Record<string, string>]> = [
  ["TAVILY_API_KEY", { TAVILY_API_KEY: "tv-xxx", EXA_API_KEY: "exa-xxx" }],
  ["EXA_API_KEY", { EXA_API_KEY: "exa-xxx", SERPER_API_KEY: "sp-xxx" }],
  ["SERPER_API_KEY", { SERPER_API_KEY: "sp-xxx", SEARXNG_URL: "https://searx.example.com" }],
  ["SEARXNG_URL", { SEARXNG_URL: "https://searx.example.com" }],
  ["(none)", {}],
];

for (const [label, env] of priorities) {
  const p = webSearchFromEnv(env);
  console.log(`  env=${label.padEnd(16)} → provider: ${p ? "resolved" : "null"}`);
}
