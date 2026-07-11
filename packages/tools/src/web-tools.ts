import { z } from "zod";
import { createTool, type Tool, type ToolContext } from "@eidentic/core";
import type { WebSearchPort } from "@eidentic/types";
import { webSearchFromEnv } from "./search.js";
import {
  parseSafeEgressUrl,
  safeFetchText,
} from "./safe-egress.js";

export { hostAllowed, isBlockedHost, safeUrlForError } from "./safe-egress.js";

export type { WebSearchResult } from "@eidentic/types";

const MAX_FETCH_BYTES = 512 * 1024; // bound web_fetch response text

export interface WebToolsOptions {
  /**
   * Egress allowlist of hostnames for `web_fetch` (§5.6 / §10.3). A host is allowed when it
   * equals an entry OR is a subdomain of an entry (suffix match on a dot boundary).
   *
   * - **Omitted/empty:** denies ALL fetches.
   * - **Non-empty:** restricts `web_fetch` to the listed hosts (and their subdomains).
   *
   * In every mode, private / loopback / link-local / cloud-metadata hosts are ALWAYS rejected
   * (SSRF defense, see `isBlockedHost`) — independent of this setting. Does not affect
   * `web_search`, which goes through the search provider rather than arbitrary egress.
   */
  allowlist?: string[];
  /** @deprecated Unsafe compatibility mode permitting every globally routed host. */
  unsafeAllowAnyPublicHost?: boolean;
  /** @deprecated Permit cleartext HTTP. Production default is HTTPS-only. */
  allowInsecureHttp?: boolean;
  /** Override the fetch implementation (tests / custom agents). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Resolve hostname A/AAAA records and reject any private/loopback/link-local
   * address before every fetch attempt. Defaults true, including with custom fetch
   * implementations. Set false only when an external egress proxy enforces the same policy.
   */
  resolveHosts?: boolean;
  /** Custom hostname resolver used when `resolveHosts` is enabled. */
  resolveHost?: (hostname: string) => Promise<string[]>;
  /**
   * BYO search provider (like the embedder — no default). When omitted, NO web_search tool
   * is returned. The provider reads any API key from `ctx.secrets` (§10.3) — NEVER a model
   * parameter.
   * @deprecated Prefer `searchProvider` (typed WebSearchPort). This legacy fn is still
   *   supported for backward compatibility.
   */
  search?: (query: string, ctx?: ToolContext) => Promise<import("@eidentic/types").WebSearchResult[]>;
  /**
   * Pluggable WebSearchPort (Tavily/Exa/Serper/SearXNG/custom). When set, preferred over
   * the legacy `search` fn and env auto-detect. Model never sees the API key (§10.3).
   */
  searchProvider?: WebSearchPort;
  /**
   * When false, excludes the web_search tool entirely. Default: include the tool (it returns
   * a helpful unconfigured message when no provider is resolvable, so the model understands
   * what it needs to do).
   */
  webSearch?: boolean;
}

/**
 * Test whether `host` is permitted by `allowlist`.
 *
 * Rules (§5.6 / §10.3):
 *  - Exact match: `example.com` allows `example.com`.
 *  - Dot-boundary suffix: `example.com` allows `api.example.com` but NOT `notexample.com`.
 *  - Empty allowlist denies ALL (§10.7 secure default).
 */
/**
 * Assert that `rawUrl` is safe to fetch — no SSRF hazards.
 *
 * Checks performed (in order):
 *  1. URL must be parseable.
 *  2. Scheme must be `http:` or `https:`.
 *  3. Host must NOT be a private/loopback/link-local/metadata address (`isBlockedHost`).
 *  4. When `opts.allowlist` is provided, host must pass `hostAllowed`.
 *
 * Returns the parsed `URL` on success; throws a descriptive `Error` on rejection.
 *
 * @example
 * // Basic usage — blocks all internal hosts
 * const url = assertFetchableUrl("https://example.com/data");
 *
 * @example
 * // With allowlist — additionally restricts to listed domains
 * const url = assertFetchableUrl(rawUrl, { allowlist: ["example.com"] });
 */
export function assertFetchableUrl(rawUrl: string, opts?: {
  allowlist?: string[];
  unsafeAllowAnyPublicHost?: boolean;
  allowInsecureHttp?: boolean;
}): URL {
  try {
    return parseSafeEgressUrl(rawUrl, {
      allowlist: opts?.allowlist,
      unsafeAllowAnyPublicHost: opts?.unsafeAllowAnyPublicHost,
      requireHttps: opts?.allowInsecureHttp !== true,
    });
  } catch (error) {
    // Preserve the legacy function name in the error while never echoing the raw URL.
    const message = error instanceof Error ? error.message : "URL rejected by safe egress policy";
    throw new Error(`assertFetchableUrl: ${message}`);
  }
}

/**
 * Wrap a legacy search fn as a WebSearchPort so both code paths share one resolution path.
 */
function legacyAsPort(
  fn: ((query: string, ctx?: ToolContext) => Promise<import("@eidentic/types").WebSearchResult[]>) | undefined,
  ctx: ToolContext | undefined,
): WebSearchPort | null {
  if (!fn) return null;
  return {
    search: (query) => fn(query, ctx),
  };
}

/**
 * Sealed web tools (§5.6, §5.8).
 *
 * - `web_fetch` is READ-ONLY and SEALED: the agent supplies only the URL; method, headers,
 *   and body are fixed (GET, no custom headers). Non-http(s) schemes are rejected. The host
 *   MUST be on `opts.allowlist`; private/loopback IP literals are rejected even when their
 *   hostname would match the allowlist (SSRF defense-in-depth); redirects are followed ONLY
 *   when every hop remains safe and allowlisted. DNS is revalidated on every retry/hop. Credentials
 *   come from `ctx.secrets`, not the model (§10.3).
 *
 *   Body consumption has a decompressed-byte cap and timeout.
 *
 * - `web_search` is included by default (when `opts.webSearch !== false`). When no provider
 *   is resolvable (no searchProvider, no legacy search fn, no env key/URL), the tool returns
 *   a helpful unconfigured message — it never throws. Resolution order per call:
 *     1. opts.searchProvider  (typed WebSearchPort)
 *     2. opts.search          (legacy fn, backward compat)
 *     3. webSearchFromEnv()   (TAVILY_API_KEY → EXA_API_KEY → SERPER_API_KEY → SEARXNG_URL)
 *   Model never sees API keys (§10.3 invariant preserved).
 */
export function webTools(opts: WebToolsOptions): Tool[] {
  const resolveHosts = opts.resolveHosts ?? true;

  const webFetch = createTool({
    id: "web_fetch",
    description:
      "Fetch the text content of an http(s) URL (§5.6, §10.3). " +
      "The agent supplies only the URL; method, headers, and body are fixed (sealed GET). " +
      "Non-http(s) schemes and private/loopback IP literals are always rejected; when an egress " +
      "allowlist is configured, the host must also be on it. " +
      "Redirects are followed only when every hop passes the same checks.",
    inputSchema: z.object({ url: z.string().describe("Absolute http(s) URL to fetch") }),
    sideEffect: "read-only",
    execute: async ({ input, ctx }) => {
      try {
        return await safeFetchText(input.url, { method: "GET" }, {
          allowlist: opts.allowlist,
          unsafeAllowAnyPublicHost: opts.unsafeAllowAnyPublicHost,
          requireHttps: opts.allowInsecureHttp !== true,
          fetchImpl: opts.fetchImpl,
          resolveHosts,
          resolveHost: opts.resolveHost,
          signal: ctx?.signal,
          maxRedirects: 5,
          maxResponseBytes: MAX_FETCH_BYTES,
          truncate: true,
          allowedContentTypes: [
            "text/",
            "application/json",
            "application/xml",
            "application/xhtml+xml",
          ],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "request rejected";
        throw new Error(`web_fetch: ${message}`);
      }
    },
  });

  const tools: Tool[] = [webFetch];

  if (opts.webSearch !== false) {
    tools.push(
      createTool({
        id: "web_search",
        description:
          "Search the web for a query and return ranked results (title, url, snippet). " +
          "Credentials are read from environment variables or the injected provider (§10.3) — the model never sees any API key.",
        inputSchema: z.object({
          query: z.string().describe("Search query"),
          maxResults: z.number().int().min(1).max(20).optional().describe("Max results to return (default 5)"),
        }),
        sideEffect: "read-only",
        execute: async ({ input, ctx }) => {
          // Resolution order: searchProvider > legacy search fn > env auto-detect.
          // Keys come from env/provider — never a model param (§10.3).
          const provider =
            opts.searchProvider ??
            legacyAsPort(opts.search, ctx) ??
            webSearchFromEnv();

          if (!provider) {
            return {
              configured: false,
              message:
                "web_search is not configured. Set TAVILY_API_KEY (free 1k/mo at tavily.com), " +
                "EXA_API_KEY, or SERPER_API_KEY in the environment, or run a SearXNG instance " +
                "and set SEARXNG_URL. Or pass searchProvider to webTools().",
            };
          }

          try {
            const results = await provider.search(input.query, {
              maxResults: input.maxResults,
              signal: ctx?.signal,
            });
            return { results };
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) };
          }
        },
      }),
    );
  }

  return tools;
}
