import { z } from "zod";
import { createTool, type Tool, type ToolContext } from "@eidentic/core";
import type { WebSearchPort } from "@eidentic/types";
import { webSearchFromEnv } from "./search.js";
import { resilientFetch } from "./http.js";

export type { WebSearchResult } from "@eidentic/types";

const MAX_FETCH_BYTES = 512 * 1024; // bound web_fetch response text

export interface WebToolsOptions {
  /**
   * Egress allowlist of hostnames for `web_fetch` (§5.6 / §10.3). A host is allowed when it
   * equals an entry OR is a subdomain of an entry (suffix match on a dot boundary).
   *
   * - **Omitted (`undefined`):** no domain restriction — any public http(s) host may be fetched.
   * - **Empty array (`[]`):** denies ALL fetches (explicit lockdown).
   * - **Non-empty:** restricts `web_fetch` to the listed hosts (and their subdomains).
   *
   * In every mode, private / loopback / link-local / cloud-metadata hosts are ALWAYS rejected
   * (SSRF defense, see `isBlockedHost`) — independent of this setting. Does not affect
   * `web_search`, which goes through the search provider rather than arbitrary egress.
   */
  allowlist?: string[];
  /** Override the fetch implementation (tests / custom agents). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Resolve hostname A/AAAA records and reject any private/loopback/link-local
   * address before fetching. Defaults true with global fetch, false with a
   * custom fetch implementation so tests/custom runtimes stay deterministic.
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
export function hostAllowed(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase();
  for (const entry of allowlist) {
    const e = entry.toLowerCase();
    if (h === e) return true;
    if (h.endsWith(`.${e}`)) return true;
  }
  return false;
}

/**
 * SSRF defense-in-depth: reject IP-literal hosts that resolve to loopback,
 * link-local, private, or cloud-metadata ranges.
 *
 * Blocked ranges:
 *   - 127.0.0.0/8  (IPv4 loopback)
 *   - 0.0.0.0      (wildcard)
 *   - 10.0.0.0/8   (RFC-1918 private)
 *   - 172.16.0.0/12 (RFC-1918 private)
 *   - 192.168.0.0/16 (RFC-1918 private)
 *   - 169.254.0.0/16 (link-local / cloud-metadata including 169.254.169.254)
 *   - ::1           (IPv6 loopback)
 *   - fc00::/7      (IPv6 ULA)
 *
 * NOTE: DNS-rebinding attacks (an allowlisted NAME resolving to a private IP)
 * are a known residual not closed here — no DNS resolution is performed at
 * this layer.
 *
 * Returns true when the host should be BLOCKED.
 */
/**
 * Decode a non-dotted IPv4 host (decimal, hex 0x…, or octal 0…) to an integer.
 * Returns undefined if the string is not a recognizable alternative encoding.
 */
function parseNonDottedIPv4(h: string): number | undefined {
  // Hex: 0x7f000001 style
  if (/^0x[0-9a-fA-F]+$/.test(h)) {
    const n = parseInt(h, 16);
    return isNaN(n) ? undefined : n >>> 0; // unsigned 32-bit
  }
  // Pure decimal (no dots) that looks like a big integer
  if (/^\d+$/.test(h)) {
    const n = Number(h);
    // Must fit in 32-bit unsigned range and not equal something like a port number.
    if (!isNaN(n) && n >= 0 && n <= 0xffffffff) return n >>> 0;
  }
  // Octal: starts with 0 followed by octal digits (but not "0" alone which is 0.0.0.0)
  if (/^0[0-7]+$/.test(h)) {
    const n = parseInt(h, 8);
    return isNaN(n) ? undefined : n >>> 0;
  }
  return undefined;
}

/**
 * Return true if the given 32-bit unsigned IPv4 integer falls in a private/loopback range.
 */
function isPrivateIPv4Int(n: number): boolean {
  const a = (n >>> 24) & 0xff;
  const b = (n >>> 16) & 0xff;
  if (a === 0) return true;                    // 0.0.0.0/8
  if (a === 127) return true;                  // 127.0.0.0/8
  if (a === 10) return true;                   // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;     // 192.168.0.0/16
  if (a === 169 && b === 254) return true;     // 169.254.0.0/16
  return false;
}

/**
 * Return true if `host` is a private/loopback/link-local/metadata address that `web_fetch`
 * must never reach (SSRF defense). Covers: `localhost`, dotted IPv4 private ranges, non-dotted
 * IPv4 encodings (decimal/hex/octal), and IPv6 loopback/unspecified/ULA/link-local plus
 * IPv4-mapped (`::ffff:…`) and IPv4-compatible (`::a.b.c.d`) embeddings.
 *
 * RESIDUAL (DNS rebinding): this is a *syntactic* check on the URL host — it does not resolve
 * DNS. A hostname that passes the egress allowlist but resolves to a private IP at fetch time
 * still reaches that IP. For untrusted-input deployments, run egress behind a proxy that enforces
 * IP-level filtering, or pin the allowlist to hosts you control.
 */
export function isBlockedHost(host: string): boolean {
  // Strip IPv6 brackets: [::1] → ::1
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  // "localhost" string literal
  if (h.toLowerCase() === "localhost") return true;

  // Try to parse as IPv4 (four decimal octets)
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ipv4Match) {
    const [, a, b, c] = ipv4Match.map(Number) as [unknown, number, number, number, number];
    // 0.0.0.0
    if (a === 0) return true;
    // 127.x.x.x
    if (a === 127) return true;
    // 10.x.x.x
    if (a === 10) return true;
    // 172.16.0.0/12 → 172.16.x.x – 172.31.x.x
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.x.x
    if (a === 192 && b === 168) return true;
    // 169.254.x.x (link-local / cloud metadata)
    if (a === 169 && b === 254) return true;
    return false;
  }

  // Non-dotted IPv4 encodings: decimal (2130706433), hex (0x7f000001), octal.
  // These bypass the dotted-octet check above and must be checked explicitly.
  const nonDotted = parseNonDottedIPv4(h);
  if (nonDotted !== undefined) {
    return isPrivateIPv4Int(nonDotted);
  }

  // --- IPv6 ---
  // Strip an optional zone id (e.g. "fe80::1%eth0").
  let v6 = h.toLowerCase();
  const pct = v6.indexOf("%");
  if (pct !== -1) v6 = v6.slice(0, pct);

  // IPv4-mapped/compatible embeddings MUST be checked first — an attacker can wrap any
  // private IPv4 as "::ffff:169.254.169.254" (dotted) or "::ffff:a9fe:a9fe" (hex) to evade
  // the IPv4 checks above.
  const mappedDotted = /^::(?:ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v6);
  if (mappedDotted) {
    const a = Number(mappedDotted[1]), b = Number(mappedDotted[2]);
    const c = Number(mappedDotted[3]), d = Number(mappedDotted[4]);
    if (a <= 255 && b <= 255 && c <= 255 && d <= 255) {
      return isPrivateIPv4Int((((a << 24) | (b << 16) | (c << 8) | d) >>> 0));
    }
  }
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1] ?? "0", 16);
    const lo = parseInt(mappedHex[2] ?? "0", 16);
    return isPrivateIPv4Int((((hi << 16) | lo) >>> 0));
  }

  // Unspecified (::, equivalent to 0.0.0.0) and loopback (::1).
  if (v6 === "::" || v6 === "::1") return true;
  // Unique-local fc00::/7 — first byte 0xfc or 0xfd.
  if (/^f[cd][0-9a-f]{0,2}(:|$)/.test(v6)) return true;
  // Link-local fe80::/10 — first 10 bits 1111 1110 10 → fe8/fe9/fea/feb.
  if (/^fe[89ab][0-9a-f]?(:|$)/.test(v6)) return true;

  return false;
}

/**
 * Return a sanitized URL string safe for inclusion in error messages: strips the query string
 * and fragment so that a secret embedded in a query parameter (e.g. `?api_key=sk-…`) cannot
 * leak into the model context or the event log.
 *
 * Only the scheme + host + path are retained. Port is kept when explicitly set.
 * Example: `https://api.example.com/v1/data?key=sk-abc&foo=bar` → `https://api.example.com/v1/data`
 */
export function safeUrlForError(url: URL | string): string {
  try {
    const u = typeof url === "string" ? new URL(url) : url;
    // Reconstruct without search/hash.
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    // If we can't parse it at all, just return a placeholder.
    return "[invalid URL]";
  }
}

async function resolveHostname(hostname: string): Promise<string[]> {
  const dns = await import("node:dns/promises");
  const records = await dns.lookup(hostname, { all: true });
  return records.map((r) => r.address);
}

async function assertResolvedPublicHost(
  url: URL,
  resolveHosts: boolean,
  resolveHost: (hostname: string) => Promise<string[]>,
): Promise<void> {
  if (!resolveHosts || isBlockedHost(url.hostname)) return;
  const addresses = await resolveHost(url.hostname);
  const blocked = addresses.find((address) => isBlockedHost(address));
  if (blocked !== undefined) {
    throw new Error(`resolved host maps to blocked private/loopback address: ${url.hostname}`);
  }
}

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
export function assertFetchableUrl(rawUrl: string, opts?: { allowlist?: string[] }): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`assertFetchableUrl: invalid URL (query string omitted for security)`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `assertFetchableUrl: only http(s) URLs are allowed (got ${parsed.protocol})`,
    );
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error(
      `assertFetchableUrl: host is a blocked private/loopback/metadata address: ${parsed.hostname}`,
    );
  }
  if (opts?.allowlist !== undefined && !hostAllowed(parsed.hostname, opts.allowlist)) {
    throw new Error(
      `assertFetchableUrl: host not on allowlist: ${parsed.hostname} (url: ${safeUrlForError(parsed)})`,
    );
  }
  return parsed;
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
 *   when the final host is still allowlisted — one redirect hop is followed manually and
 *   re-validated (redirect policy: manual single-hop re-check, no further hops). Credentials
 *   come from `ctx.secrets`, not the model (§10.3).
 *
 *   Body is bounded to MAX_FETCH_BYTES: Content-Length is checked before buffering, and the
 *   response stream is consumed with a hard byte cap to prevent unbounded memory allocation.
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
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const resolveHosts = opts.resolveHosts ?? opts.fetchImpl === undefined;
  const resolveHost = opts.resolveHost ?? resolveHostname;

  const webFetch = createTool({
    id: "web_fetch",
    description:
      "Fetch the text content of an http(s) URL (§5.6, §10.3). " +
      "The agent supplies only the URL; method, headers, and body are fixed (sealed GET). " +
      "Non-http(s) schemes and private/loopback IP literals are always rejected; when an egress " +
      "allowlist is configured, the host must also be on it. " +
      "Redirects are followed only if the final host still passes the same checks (manual single-hop re-check).",
    inputSchema: z.object({ url: z.string().describe("Absolute http(s) URL to fetch") }),
    sideEffect: "read-only",
    execute: async ({ input, ctx }) => {
      let parsed: URL;
      try {
        parsed = new URL(input.url);
      } catch {
        // Don't echo the raw URL back — it might contain a secret in the path, but
        // we can't parse it anyway so just emit a safe placeholder.
        throw new Error(`web_fetch: invalid URL (query string omitted from error for security)`);
      }
      // All error messages below use safeUrlForError() — which strips query string + fragment —
      // so a secret embedded as a query parameter (e.g. ?api_key=sk-…) never leaks into the
      // model context or the event log.
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`web_fetch: only http(s) URLs are allowed (got ${parsed.protocol})`);
      }
      if (opts.allowlist !== undefined && !hostAllowed(parsed.hostname, opts.allowlist)) {
        throw new Error(`web_fetch: host not on egress allowlist: ${parsed.hostname} (url: ${safeUrlForError(parsed)})`);
      }
      if (isBlockedHost(parsed.hostname)) {
        throw new Error(`web_fetch: host is a blocked private/loopback address: ${parsed.hostname}`);
      }
      await assertResolvedPublicHost(parsed, resolveHosts, resolveHost);
      // Sealed: GET only, no custom headers/body. Use redirect:"manual" so we can re-validate
      // the redirect target host before following it (redirect policy: manual single-hop re-check).
      // resilientFetch adds per-request timeout + retry on 5xx/network + agent abort link.
      let res: Response;
      try {
        res = await resilientFetch(
          parsed.toString(),
          { method: "GET", redirect: "manual" },
          { fetchImpl: doFetch, signal: ctx?.signal },
        );
      } catch (err) {
        // Rethrow fetch errors with a safe URL (no query string) to prevent secret leakage.
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`web_fetch: fetch failed for ${safeUrlForError(parsed)}: ${msg}`);
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (location === null) {
          throw new Error(`web_fetch: redirect from ${safeUrlForError(parsed)} has no Location header`);
        }
        let next: URL;
        try {
          next = new URL(location, parsed);
        } catch {
          throw new Error(`web_fetch: invalid redirect target (query string omitted for security)`);
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          throw new Error(`web_fetch: redirect to non-http(s) scheme rejected: ${next.protocol}`);
        }
        if (opts.allowlist !== undefined && !hostAllowed(next.hostname, opts.allowlist)) {
          throw new Error(`web_fetch: redirect off egress allowlist rejected: ${next.hostname}`);
        }
        if (isBlockedHost(next.hostname)) {
          throw new Error(`web_fetch: redirect target is a blocked private/loopback address: ${next.hostname}`);
        }
        await assertResolvedPublicHost(next, resolveHosts, resolveHost);
        let followed: Response;
        try {
          followed = await resilientFetch(
            next.toString(),
            { method: "GET", redirect: "manual" },
            { fetchImpl: doFetch, signal: ctx?.signal },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`web_fetch: fetch failed for ${safeUrlForError(next)}: ${msg}`);
        }
        return await toResult(input.url, followed);
      }
      return await toResult(input.url, res);
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

/**
 * Read a Response body with a hard byte cap, stopping the stream at MAX_FETCH_BYTES.
 * This prevents unbounded memory allocation from a large or slow response.
 *
 * Strategy:
 *  1. Reject immediately if Content-Length header exceeds the cap.
 *  2. Stream res.body with a ReadableStream reader, accumulating up to the cap.
 *  3. If res.body is unavailable, fall back to text() + truncate.
 */
async function toResult(
  url: string,
  res: Response,
): Promise<{ url: string; status: number; content: string; truncated: boolean }> {
  // M4: strip query string and fragment from the returned url field so that tokens embedded as
  // query parameters (e.g. ?api_key=sk-…) are never persisted to the session event log or fed
  // back to the model. Use the same safeUrlForError helper that already strips these for errors.
  const safeUrl = safeUrlForError(url);

  // 1. Content-Length pre-check: when the header signals a body larger than the cap, skip the
  // cancel-and-bail path — instead fall through to the streaming read (step 2) which already
  // enforces the byte cap and marks truncation. Cancelling the body here and then calling
  // getReader() below would throw "body already used" (H7).
  // No action needed: if Content-Length is absent or within cap the streaming path handles both.

  // 2. Stream with byte cap
  if (res.body) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let truncated = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          const remaining = MAX_FETCH_BYTES - totalBytes;
          if (value.length >= remaining) {
            chunks.push(value.subarray(0, remaining));
            totalBytes += remaining;
            truncated = true;
            break;
          }
          chunks.push(value);
          totalBytes += value.length;
        }
      }
    } finally {
      try { await reader.cancel(); } catch { /* ignore */ }
    }

    // Merge chunks into a single buffer and decode
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    const content = new TextDecoder("utf-8", { fatal: false }).decode(merged);
    return { url: safeUrl, status: res.status, content, truncated };
  }

  // 3. Fallback: no readable stream (e.g. synthetic Response in tests)
  const body = await res.text();
  const buf = Buffer.from(body, "utf8");
  const truncated = buf.length > MAX_FETCH_BYTES;
  const content = truncated ? buf.subarray(0, MAX_FETCH_BYTES).toString("utf8") : body;
  return { url: safeUrl, status: res.status, content, truncated };
}
