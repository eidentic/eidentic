import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { WebSearchPort, WebSearchResult } from "@eidentic/types";
import type { AdapterOptions } from "./search.js";

const ENDPOINT = "https://search.parallel.ai/mcp";
const USER_AGENT = "eidentic (https://github.com/eidentic/eidentic)";

function textContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

/** Anonymous MCP search. The deadline covers connection, discovery and search together. */
export type ParallelSearchOptions = Pick<AdapterOptions, "fetch" | "maxResults" | "timeoutMs">;

function searchResults(data: unknown, limit: number): WebSearchResult[] {
  if (typeof data !== "object" || data === null || !("results" in data) || !Array.isArray(data.results)) {
    throw new Error("Parallel search: invalid response (expected results array)");
  }
  const results: WebSearchResult[] = [];
  for (const item of data.results) {
    if (typeof item !== "object" || item === null || typeof item.url !== "string" ||
        !Array.isArray(item.excerpts) || !item.excerpts.every((excerpt: unknown) => typeof excerpt === "string")) {
      throw new Error("Parallel search: invalid response result");
    }
    // These URLs are returned as sources, never fetched by this adapter.
    let url: URL;
    try { url = new URL(item.url); } catch { continue; }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) continue;
    results.push({
      title: typeof item.title === "string" ? item.title : "",
      url: item.url,
      snippet: item.excerpts.join("\n\n"),
    });
    if (results.length >= limit) break;
  }
  return results;
}

/**
 * Free, keyless Parallel Search MCP (anonymous Fast mode) as a WebSearchPort.
 * Uses the same SDK Streamable HTTP transport as @eidentic/mcp. No credentials are
 * read, no alternate provider is tried, and every search closes its connection.
 */
export function parallelSearch(opts: ParallelSearchOptions = {}): WebSearchPort {
  return {
    async search(query, searchOpts) {
      const limit = searchOpts?.maxResults ?? opts.maxResults ?? 5;
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
        throw new Error("Parallel search: maxResults must be an integer from 1 to 20");
      }
      const timeoutMs = opts.timeoutMs ?? 10_000;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
        throw new Error("Parallel search: timeoutMs must be a positive integer");
      }
      const deadline = AbortSignal.timeout(timeoutMs);
      const signal = searchOpts?.signal ? AbortSignal.any([searchOpts.signal, deadline]) : deadline;
      signal.throwIfAborted();
      const fetchImpl = opts.fetch ?? globalThis.fetch;
      const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
        fetch: (url, init) => {
          signal.throwIfAborted();
          const headers = new Headers(init?.headers);
          headers.set("User-Agent", USER_AGENT);
          return fetchImpl(url, {
            ...init,
            headers,
            redirect: "error",
            signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
          });
        },
        reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
      });
      const client = new Client({ name: "eidentic", version: "0.0.0" });
      const requestOptions = { signal, timeout: timeoutMs };
      try {
        await client.connect(transport, requestOptions);
        const { tools } = await client.listTools(undefined, requestOptions);
        if (!tools.some((tool) => tool.name === "web_search")) {
          throw new Error("Parallel search: server does not advertise web_search");
        }
        const response = await client.callTool({
          name: "web_search",
          arguments: { objective: query, search_queries: [query] },
        }, undefined, requestOptions);
        if (response.isError) {
          const message = textContent(response.content);
          throw new Error(`Parallel search failed: ${message || "MCP tool error"}`);
        }
        let data: unknown = response.structuredContent;
        if (data === undefined) {
          const text = textContent(response.content);
          try { data = JSON.parse(text); } catch { throw new Error("Parallel search: invalid response JSON"); }
        }
        return searchResults(data, limit);
      } finally {
        await client.close();
      }
    },
  };
}
