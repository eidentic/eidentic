import { z } from "zod";
import { createTool, type Tool } from "@eidentic/core";
import { hostAllowed, isBlockedHost } from "@eidentic/tools";

export { hostAllowed, isBlockedHost } from "@eidentic/tools";

// ---------------------------------------------------------------------------
// PageLike — minimal injected surface for browser automation tools.
//
// Structurally compatible with Playwright's `Page` type (all methods are a
// subset of Playwright's `Page` interface), so you can pass a real
// `playwright-core` Page directly without an adapter.
// ---------------------------------------------------------------------------

/**
 * Minimal structural interface for a browser page that `browserTools` can operate on.
 *
 * Designed as a strict subset of Playwright's `Page` type — a real `playwright-core`
 * `Page` instance satisfies this interface without any adapter. You can also pass a
 * faithful in-memory fake for tests (see `FakePage` in the test suite).
 *
 * `screenshot` is intentionally optional: it is NOT surfaced as a tool in v1 (binary
 * results don't compose cleanly with text tool results). Roadmap: a future `browser_screenshot`
 * tool returning a base64-encoded image string.
 */
export interface PageLike {
  /** Navigate to `url`. Returns when navigation is complete. */
  goto(url: string): Promise<unknown>;
  /** Return the full HTML content of the current page. */
  content(): Promise<string>;
  /** Return the innerText of the element matching `selector`. Throws if not found. */
  innerText(selector: string): Promise<string>;
  /** Click the element matching `selector`. */
  click(selector: string): Promise<void>;
  /** Fill an input element matching `selector` with `value`. */
  fill(selector: string, value: string): Promise<void>;
  /** Return the current page URL string. */
  url(): string;
  /** Return the page title. */
  title(): Promise<string>;
  /** Optional: capture a screenshot as raw bytes (not exposed as a tool in v1). Roadmap item. */
  screenshot?(): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Default limit for read results — 512 KB expressed in UTF-8 code units. */
const DEFAULT_MAX_CONTENT_BYTES = 512 * 1024;

/** Tool-result truncation marker appended when content is cut. */
const TRUNCATION_MARKER = "\n…[content truncated]";

export interface BrowserToolsOptions {
  /**
   * Egress allowlist of hostnames for browser navigation (§5.6 / §10.3). A host is allowed when
   * it equals an entry OR is a subdomain of an entry (suffix match on a dot boundary).
   *
   * - **Omitted (`undefined`):** no domain restriction — any public http(s) host may be navigated to.
   * - **Empty array (`[]`):** denies ALL navigation (explicit lockdown).
   * - **Non-empty:** restricts navigation to the listed hosts (and their subdomains).
   *
   * In every mode, private / loopback / link-local / cloud-metadata hosts are ALWAYS rejected
   * (SSRF defense, see `isBlockedHost` from `@eidentic/tools`).
   *
   * Every navigation, including model-driven `browser_navigate` calls, is re-validated:
   * the tool validates the target URL before `goto()`, and then re-validates the URL reported
   * by `page.url()` AFTER navigation completes — so redirect-based escapes are detected and
   * surfaced as tool errors.
   */
  allowlist?: string[];
  /**
   * When true (default), private/loopback/link-local/cloud-metadata IP literals are always
   * rejected regardless of the allowlist (SSRF defense-in-depth).
   * Set to false only in controlled test environments.
   */
  blockPrivateHosts?: boolean;
  /**
   * Maximum number of UTF-8 bytes to include in `browser_read` results.
   * Defaults to 512 KB. Content exceeding this limit is truncated with a marker.
   */
  maxContentBytes?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Assert that `rawUrl` is safe to navigate to.
 *
 * Checks:
 *  1. URL must be parseable.
 *  2. Scheme must be `http:` or `https:`.
 *  3. Host must NOT be a private/loopback/link-local/metadata address (when blockPrivateHosts is true).
 *  4. When `allowlist` is provided, host must pass `hostAllowed`.
 *
 * Returns the parsed `URL` on success; throws a descriptive `Error` on rejection.
 */
function assertNavigableUrl(
  rawUrl: string,
  opts: { allowlist?: string[]; blockPrivateHosts: boolean },
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`browser: invalid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`browser: only http(s) URLs are allowed (got ${parsed.protocol})`);
  }
  if (opts.blockPrivateHosts && isBlockedHost(parsed.hostname)) {
    throw new Error(
      `browser: host is a blocked private/loopback/metadata address: ${parsed.hostname}`,
    );
  }
  if (opts.allowlist !== undefined && !hostAllowed(parsed.hostname, opts.allowlist)) {
    throw new Error(
      `browser: host not on allowlist: ${parsed.hostname}`,
    );
  }
  return parsed;
}

/**
 * Truncate a string to `maxBytes` UTF-8 bytes, appending the truncation marker when cut.
 */
function truncateContent(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const markerBuf = Buffer.from(TRUNCATION_MARKER, "utf8");
  const cutBytes = maxBytes - markerBuf.length;
  return buf.subarray(0, cutBytes > 0 ? cutBytes : 0).toString("utf8") + TRUNCATION_MARKER;
}

// ---------------------------------------------------------------------------
// browserTools
// ---------------------------------------------------------------------------

/**
 * Sealed browser-automation tools over an injected `PageLike` page.
 *
 * Returns an array of Eidentic `Tool` definitions:
 *  - `browser_navigate` (destructive): validates URL + allowlist + private-host guard, then navigates.
 *    After navigation, re-validates `page.url()` to detect redirect-based escapes.
 *  - `browser_read` (read-only): returns page title + URL + innerText of a selector (or `body`),
 *    truncated to `opts.maxContentBytes`.
 *  - `browser_click` (destructive): clicks a CSS selector; selector errors are surfaced as tool errors.
 *  - `browser_fill` (destructive): fills an input by CSS selector; selector errors are tool errors.
 *
 * Every tool receives the page at call time via the closure — no singleton page state is held.
 *
 * @example
 * ```ts
 * import { chromium } from "playwright-core";
 * import { browserTools } from "@eidentic/browser";
 * import { Agent } from "eidentic";
 *
 * const browser = await chromium.launch();
 * const page = await browser.newPage();
 *
 * const agent = new Agent({
 *   id: "web-agent",
 *   model,
 *   store,
 *   tools: browserTools(page, { allowlist: ["example.com"] }),
 * });
 * ```
 *
 * @note No `browser_screenshot` tool in v1 — binary results don't compose with text tool results.
 *   Roadmap: a future release will return a base64-encoded image string.
 */
export function browserTools(page: PageLike, opts?: BrowserToolsOptions): Tool[] {
  const blockPrivateHosts = opts?.blockPrivateHosts ?? true;
  const maxContentBytes = opts?.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
  const guardOpts = { allowlist: opts?.allowlist, blockPrivateHosts };

  // ---------------------------------------------------------------------------
  // browser_navigate
  // ---------------------------------------------------------------------------
  const navigateTool = createTool({
    id: "browser_navigate",
    description:
      "Navigate the browser page to an http(s) URL. " +
      "Only http(s) schemes are accepted. " +
      "Private/loopback/metadata hosts are always rejected (SSRF defense). " +
      "When an egress allowlist is configured, the host must be on it. " +
      "After navigation, the final URL is re-validated to detect redirect-based escapes — " +
      "the tool errors if the page was redirected off the allowlist.",
    inputSchema: z.object({
      url: z.string().describe("Absolute http(s) URL to navigate to"),
    }),
    sideEffect: "destructive",
    execute: async ({ input }) => {
      // Validate target before navigating.
      assertNavigableUrl(input.url, guardOpts);

      try {
        await page.goto(input.url);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`browser_navigate: goto failed: ${msg}`);
      }

      // Re-validate the URL the page actually landed on (catches server-side redirects).
      const finalUrl = page.url();
      try {
        assertNavigableUrl(finalUrl, guardOpts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `browser_navigate: redirect to blocked/disallowed URL detected after navigation: ${msg}`,
        );
      }

      return { navigated: true, url: finalUrl };
    },
  });

  // ---------------------------------------------------------------------------
  // browser_read
  // ---------------------------------------------------------------------------
  const readTool = createTool({
    id: "browser_read",
    description:
      "Read the current page's title, URL, and text content. " +
      "When `selector` is provided, returns innerText of that element; " +
      "otherwise returns innerText of the `body` element. " +
      "Content is truncated to the configured `maxContentBytes` limit.",
    inputSchema: z.object({
      selector: z
        .string()
        .optional()
        .describe("CSS selector to read (defaults to `body` if omitted)"),
    }),
    sideEffect: "read-only",
    execute: async ({ input }) => {
      const title = await page.title();
      const url = page.url();
      const sel = input.selector ?? "body";

      let text: string;
      try {
        text = await page.innerText(sel);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `browser_read: innerText failed for selector "${sel}": ${msg}`, title, url };
      }

      const truncated = truncateContent(text, maxContentBytes);
      return { title, url, text: truncated, truncated: truncated !== text };
    },
  });

  // ---------------------------------------------------------------------------
  // browser_click
  // ---------------------------------------------------------------------------
  const clickTool = createTool({
    id: "browser_click",
    description:
      "Click an element on the current page identified by a CSS selector. " +
      "Selector errors (element not found, ambiguous) are surfaced as tool errors, not throws.",
    inputSchema: z.object({
      selector: z.string().describe("CSS selector of the element to click"),
    }),
    sideEffect: "destructive",
    execute: async ({ input }) => {
      try {
        await page.click(input.selector);
        return { clicked: true, selector: input.selector };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `browser_click: click failed for selector "${input.selector}": ${msg}`, clicked: false };
      }
    },
  });

  // ---------------------------------------------------------------------------
  // browser_fill
  // ---------------------------------------------------------------------------
  const fillTool = createTool({
    id: "browser_fill",
    description:
      "Fill an input, textarea, or contenteditable element on the current page identified " +
      "by a CSS selector. Selector errors are surfaced as tool errors, not throws.",
    inputSchema: z.object({
      selector: z.string().describe("CSS selector of the input element to fill"),
      value: z.string().describe("Value to fill into the element"),
    }),
    sideEffect: "destructive",
    execute: async ({ input }) => {
      try {
        await page.fill(input.selector, input.value);
        return { filled: true, selector: input.selector };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `browser_fill: fill failed for selector "${input.selector}": ${msg}`, filled: false };
      }
    },
  });

  return [navigateTool, readTool, clickTool, fillTool];
}
