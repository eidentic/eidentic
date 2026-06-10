import type { WebSearchPort, WebSearchResult, WebSearchOptions } from "@eidentic/types";
import { fetchJson } from "./http.js";

export type { WebSearchPort, WebSearchResult, WebSearchOptions };

export interface AdapterOptions {
  fetch?: typeof fetch;
  maxResults?: number;
  /** Per-attempt fetch timeout in ms. Default: 10_000. */
  timeoutMs?: number;
  /** Retries on 5xx or network error. Default: 1. */
  retries?: number;
}

// --- Tavily ---

export function tavilySearch(opts: { apiKey: string } & AdapterOptions): WebSearchPort {
  return {
    async search(query: string, searchOpts?: WebSearchOptions): Promise<WebSearchResult[]> {
      const maxResults = searchOpts?.maxResults ?? opts.maxResults ?? 5;
      const data = await fetchJson<{ results?: Array<{ title?: string; url?: string; content?: string; score?: number }> }>(
        "https://api.tavily.com/search",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Authorization": `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify({ query, max_results: maxResults, search_depth: "basic" }),
        },
        {
          fetchImpl: opts.fetch,
          timeoutMs: opts.timeoutMs,
          retries: opts.retries,
          signal: searchOpts?.signal,
        },
      ).catch((err: unknown) => {
        // Preserve adapter-specific error messages for compatibility.
        if (err instanceof Error && /→ HTTP (\d+)/.test(err.message)) {
          const m = /→ HTTP (\d+)/.exec(err.message);
          throw new Error(`Tavily search failed: HTTP ${m![1]}`);
        }
        throw err;
      });
      return (data.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.content ?? "",
        score: r.score,
      }));
    },
  };
}

// --- Exa ---

export function exaSearch(opts: { apiKey: string } & AdapterOptions): WebSearchPort {
  return {
    async search(query: string, searchOpts?: WebSearchOptions): Promise<WebSearchResult[]> {
      const numResults = searchOpts?.maxResults ?? opts.maxResults ?? 5;
      const data = await fetchJson<{ results?: Array<{ title?: string; url?: string; text?: string; score?: number }> }>(
        "https://api.exa.ai/search",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": opts.apiKey,
          },
          body: JSON.stringify({ query, numResults, contents: { text: { maxCharacters: 500 } } }),
        },
        {
          fetchImpl: opts.fetch,
          timeoutMs: opts.timeoutMs,
          retries: opts.retries,
          signal: searchOpts?.signal,
        },
      ).catch((err: unknown) => {
        if (err instanceof Error && /→ HTTP (\d+)/.test(err.message)) {
          const m = /→ HTTP (\d+)/.exec(err.message);
          throw new Error(`Exa search failed: HTTP ${m![1]}`);
        }
        throw err;
      });
      return (data.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.text ?? "",
        score: r.score,
      }));
    },
  };
}

// --- Serper ---

export function serperSearch(opts: { apiKey: string } & AdapterOptions): WebSearchPort {
  return {
    async search(query: string, searchOpts?: WebSearchOptions): Promise<WebSearchResult[]> {
      const num = searchOpts?.maxResults ?? opts.maxResults ?? 5;
      const data = await fetchJson<{ organic?: Array<{ title?: string; link?: string; snippet?: string }> }>(
        "https://google.serper.dev/search",
        {
          method: "POST",
          headers: {
            "X-API-KEY": opts.apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({ q: query, num }),
        },
        {
          fetchImpl: opts.fetch,
          timeoutMs: opts.timeoutMs,
          retries: opts.retries,
          signal: searchOpts?.signal,
        },
      ).catch((err: unknown) => {
        if (err instanceof Error && /→ HTTP (\d+)/.test(err.message)) {
          const m = /→ HTTP (\d+)/.exec(err.message);
          throw new Error(`Serper search failed: HTTP ${m![1]}`);
        }
        throw err;
      });
      return (data.organic ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.link ?? "",
        snippet: r.snippet ?? "",
      }));
    },
  };
}

// --- SearXNG ---

export function searxngSearch(opts: { baseUrl: string } & AdapterOptions): WebSearchPort {
  const base = opts.baseUrl.replace(/\/+$/, "");
  return {
    async search(query: string, searchOpts?: WebSearchOptions): Promise<WebSearchResult[]> {
      const maxResults = searchOpts?.maxResults ?? opts.maxResults ?? 5;
      const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
      const data = await fetchJson<{ results?: Array<{ title?: string; url?: string; content?: string }> }>(
        url,
        undefined,
        {
          fetchImpl: opts.fetch,
          timeoutMs: opts.timeoutMs,
          retries: opts.retries,
          signal: searchOpts?.signal,
        },
      ).catch((err: unknown) => {
        if (err instanceof Error && /→ HTTP (\d+)/.test(err.message)) {
          const m = /→ HTTP (\d+)/.exec(err.message);
          throw new Error(`SearXNG search failed: HTTP ${m![1]}`);
        }
        throw err;
      });
      return (data.results ?? []).slice(0, maxResults).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.content ?? "",
      }));
    },
  };
}

// --- env auto-detect ---

export function webSearchFromEnv(
  env: Record<string, string | undefined> = (typeof process !== "undefined" ? process.env : {}),
  fetchImpl?: typeof fetch,
): WebSearchPort | null {
  if (env["TAVILY_API_KEY"]) {
    return tavilySearch({ apiKey: env["TAVILY_API_KEY"], fetch: fetchImpl });
  }
  if (env["EXA_API_KEY"]) {
    return exaSearch({ apiKey: env["EXA_API_KEY"], fetch: fetchImpl });
  }
  if (env["SERPER_API_KEY"]) {
    return serperSearch({ apiKey: env["SERPER_API_KEY"], fetch: fetchImpl });
  }
  if (env["SEARXNG_URL"]) {
    return searxngSearch({ baseUrl: env["SEARXNG_URL"], fetch: fetchImpl });
  }
  return null;
}
