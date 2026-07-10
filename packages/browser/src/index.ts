import { z } from "zod";
import { createTool, type Tool } from "@eidentic/core";
import {
  assertSafeEgressUrl,
  hostAllowed,
  isBlockedHost,
  safeUrlForError,
} from "@eidentic/tools";

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
  goto(url: string, options?: { timeout?: number }): Promise<unknown>;
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
  /**
   * Playwright-compatible request interception. Required by default when private-host blocking
   * is enabled, because post-navigation URL checks happen after an SSRF request has escaped.
   */
  route?(
    pattern: string,
    handler: (route: BrowserRouteLike) => void | Promise<void>,
  ): Promise<unknown>;
  /** Close this page. Required for managed ephemeral runs; optional only for the legacy shim. */
  close?(): Promise<void>;
}

export interface BrowserRouteLike {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(errorCode?: "blockedbyclient"): Promise<void>;
}

/** A page created and owned by an ephemeral managed browser run. */
export interface ManagedPageLike extends PageLike {
  close(): Promise<void>;
}

/**
 * Minimal Playwright-compatible context surface used by {@link withBrowserTools}.
 * Context-level routing applies to the initial page and every later page/popup.
 */
export interface BrowserContextLike {
  route(
    pattern: string,
    handler: (route: BrowserRouteLike) => void | Promise<void>,
  ): Promise<unknown>;
  newPage(): Promise<ManagedPageLike>;
  close(): Promise<void>;
}

/** Verified tenant/run identity supplied to an ephemeral browser context factory. */
export interface BrowserRunIdentity {
  tenantId: string;
  runId: string;
}

/** Input passed to a managed context factory for every isolated run. */
export interface BrowserContextFactoryInput extends BrowserRunIdentity {
  /** Must be forwarded to Playwright's `browser.newContext()` unchanged. */
  contextOptions: Readonly<{ serviceWorkers: "block" }>;
}

/** Create a brand-new, caller-unshared browser context for one tenant run. */
export type BrowserContextFactory = (
  input: BrowserContextFactoryInput,
) => Promise<BrowserContextLike>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Default limit for read results — 512 KB expressed in UTF-8 code units. */
const DEFAULT_MAX_CONTENT_BYTES = 512 * 1024;

/** Tool-result truncation marker appended when content is cut. */
const TRUNCATION_MARKER = "\n…[content truncated]";

export interface BrowserToolsOptions {
  /**
   * Explicit opt-in for the deprecated caller-owned `browserTools(page, …)` compatibility shim.
   * It cannot enforce tenant/run isolation or cover popup requests with context-level routing.
   * Ignored by {@link withBrowserTools}, which is the safe default.
   */
  unsafeSharedPage?: boolean;
  /**
   * Egress allowlist of hostnames for browser navigation (§5.6 / §10.3). A host is allowed when
   * it equals an entry OR is a subdomain of an entry (suffix match on a dot boundary).
   *
   * - **Omitted/empty:** denies ALL navigation.
   * - **Non-empty:** restricts navigation to the listed hosts (and their subdomains).
   *
   * With the default `blockPrivateHosts: true`, private / loopback / link-local /
   * cloud-metadata hosts are always rejected (see `isBlockedHost` from `@eidentic/tools`).
   *
   * Every navigation is validated before `goto()`. Managed runs require context routing; the
   * deprecated shim requires `PageLike.route()` by default. HTTP document/subresource requests
   * are DNS-checked before they continue when private-host blocking is enabled.
   */
  allowlist?: string[];
  /** @deprecated Unsafe compatibility mode permitting every globally routed host. */
  unsafeAllowAnyPublicHost?: boolean;
  /** @deprecated Permit cleartext HTTP navigation. Production default is HTTPS-only. */
  allowInsecureHttp?: boolean;
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
  /** Resolve and validate every A/AAAA address for every browser request. Default: true. */
  resolveHosts?: boolean;
  /** Resolver override for deterministic runtimes/tests. Must return all usable addresses. */
  resolveHost?: (hostname: string) => Promise<string[]>;
  /**
   * Require `PageLike.route()` so redirects and subresources are blocked before I/O.
   * Defaults to true when `blockPrivateHosts` is enabled. The managed {@link withBrowserTools}
   * API always requires context-level interception and rejects `false`; this escape hatch exists
   * only for the deprecated shared-page shim behind an equivalent network sandbox.
   */
  requireNetworkInterception?: boolean;
  /** Navigation timeout passed to Playwright-compatible pages. Default: 15 seconds. */
  navigationTimeoutMs?: number;
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
interface NavigationGuardOptions {
  allowlist?: string[];
  unsafeAllowAnyPublicHost: boolean;
  requireHttps: boolean;
  blockPrivateHosts: boolean;
  resolveHosts: boolean;
  resolveHost?: (hostname: string) => Promise<string[]>;
}

async function assertNavigableUrl(
  rawUrl: string,
  opts: NavigationGuardOptions,
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`browser: invalid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`browser: only http(s) URLs are allowed (got ${parsed.protocol})`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("browser: URL credentials are not allowed");
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
  if (opts.allowlist === undefined && !opts.unsafeAllowAnyPublicHost) {
    throw new Error(
      `browser: host not on allowlist: ${parsed.hostname}`,
    );
  }
  if (opts.requireHttps && parsed.protocol !== "https:") {
    throw new Error("browser: HTTPS is required");
  }
  if (opts.blockPrivateHosts) {
    try {
      return await assertSafeEgressUrl(parsed, {
        allowlist: opts.allowlist,
        unsafeAllowAnyPublicHost: opts.unsafeAllowAnyPublicHost,
        requireHttps: opts.requireHttps,
        resolveHosts: opts.resolveHosts,
        resolveHost: opts.resolveHost,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "URL rejected";
      throw new Error(`browser: ${message}`);
    }
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
  if (markerBuf.byteLength >= maxBytes) return utf8Prefix(TRUNCATION_MARKER, maxBytes);
  return utf8Prefix(text, maxBytes - markerBuf.byteLength) + TRUNCATION_MARKER;
}

function utf8Prefix(value: string, maxBytes: number): string {
  let prefix = Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(prefix, "utf8") > maxBytes) {
    prefix = Array.from(prefix).slice(0, -1).join("");
  }
  return prefix;
}

interface NormalizedBrowserOptions {
  guard: NavigationGuardOptions;
  maxContentBytes: number;
  navigationTimeoutMs: number;
  requireNetworkInterception: boolean;
}

function normalizeBrowserOptions(opts?: BrowserToolsOptions): NormalizedBrowserOptions {
  const blockPrivateHosts = opts?.blockPrivateHosts ?? true;
  const maxContentBytes = opts?.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
  if (!Number.isSafeInteger(maxContentBytes) || maxContentBytes < 0) {
    throw new Error("browserTools: maxContentBytes must be a non-negative safe integer");
  }
  const navigationTimeoutMs = opts?.navigationTimeoutMs ?? 15_000;
  if (!Number.isFinite(navigationTimeoutMs) || navigationTimeoutMs <= 0) {
    throw new Error("browserTools: navigationTimeoutMs must be a positive number");
  }
  return {
    guard: {
      allowlist: opts?.allowlist,
      unsafeAllowAnyPublicHost: opts?.unsafeAllowAnyPublicHost === true,
      requireHttps: opts?.allowInsecureHttp !== true,
      blockPrivateHosts,
      resolveHosts: opts?.resolveHosts ?? blockPrivateHosts,
      resolveHost: opts?.resolveHost,
    },
    maxContentBytes,
    navigationTimeoutMs,
    requireNetworkInterception: opts?.requireNetworkInterception ?? blockPrivateHosts,
  };
}

interface BrowserRouteTargetLike {
  route?(
    pattern: string,
    handler: (route: BrowserRouteLike) => void | Promise<void>,
  ): Promise<unknown>;
}

interface BrowserNetworkBoundary {
  ensureInstalled(): Promise<void>;
  resetBlockedRequest(): void;
  blockedRequest(): string | undefined;
}

function createNetworkBoundary(
  target: BrowserRouteTargetLike,
  guard: NavigationGuardOptions,
  requireNetworkInterception: boolean,
): BrowserNetworkBoundary {
  let lastBlockedRequest: string | undefined;
  let routeInstall: Promise<unknown> | undefined;
  return {
    async ensureInstalled(): Promise<void> {
      if (!target.route) {
        if (requireNetworkInterception) {
          throw new Error(
            "browser: Playwright-compatible network interception is required for safe navigation",
          );
        }
        return;
      }
      routeInstall ??= target.route("**/*", async (route) => {
        try {
          await assertNavigableUrl(route.request().url(), guard);
          await route.continue();
        } catch (error) {
          lastBlockedRequest = error instanceof Error ? error.message : "blocked network request";
          await route.abort("blockedbyclient");
        }
      });
      await routeInstall;
    },
    resetBlockedRequest(): void {
      lastBlockedRequest = undefined;
    },
    blockedRequest(): string | undefined {
      return lastBlockedRequest;
    },
  };
}

// ---------------------------------------------------------------------------
// browserTools
// ---------------------------------------------------------------------------

/**
 * Deprecated browser-automation compatibility shim over a caller-owned `PageLike` page.
 *
 * Returns an array of Eidentic `Tool` definitions:
 *  - `browser_navigate` (destructive): installs a request interceptor, validates URL + DNS +
 *    allowlist + private-host guard, then navigates and verifies the final URL.
 *  - `browser_read` (read-only): returns page title + URL + innerText of a selector (or `body`),
 *    truncated to `opts.maxContentBytes`.
 *  - `browser_click` (destructive): clicks a CSS selector; selector errors are surfaced as tool errors.
 *  - `browser_fill` (destructive): fills an input by CSS selector; selector errors are tool errors.
 *
 * The injected page remains caller-owned, so this function cannot enforce tenant/run lifecycle
 * isolation or context-level popup routing. It now requires `unsafeSharedPage: true` explicitly.
 * New code should use {@link withBrowserTools}.
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
 *   tools: browserTools(page, {
 *     unsafeSharedPage: true,
 *     allowlist: ["example.com"],
 *   }),
 * });
 * ```
 *
 * @note No `browser_screenshot` tool in v1 — binary results don't compose with text tool results.
 *   Roadmap: a future release will return a base64-encoded image string.
 * @deprecated Use {@link withBrowserTools}; shared caller-owned pages are an unsafe opt-in.
 */
export function browserTools(page: PageLike, opts?: BrowserToolsOptions): Tool[] {
  if (opts?.unsafeSharedPage !== true) {
    throw new Error(
      "browserTools(page) is a deprecated shared-page compatibility shim; " +
      "use withBrowserTools() for an ephemeral managed browser run, or explicitly set " +
      "unsafeSharedPage: true behind equivalent tenant and network isolation",
    );
  }
  const normalized = normalizeBrowserOptions(opts);
  return buildBrowserTools(
    page,
    normalized,
    createNetworkBoundary(page, normalized.guard, normalized.requireNetworkInterception),
  );
}

function buildBrowserTools(
  page: PageLike,
  options: NormalizedBrowserOptions,
  networkBoundary: BrowserNetworkBoundary,
): Tool[] {
  const guardOpts = options.guard;
  const maxContentBytes = options.maxContentBytes;
  const navigationTimeoutMs = options.navigationTimeoutMs;
  const ensureNetworkGuard = () => networkBoundary.ensureInstalled();

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
      await ensureNetworkGuard();
      networkBoundary.resetBlockedRequest();
      await assertNavigableUrl(input.url, guardOpts);

      try {
        await page.goto(input.url, { timeout: navigationTimeoutMs });
      } catch (err) {
        const blockedRequest = networkBoundary.blockedRequest();
        if (blockedRequest) {
          throw new Error(`browser_navigate: blocked network request: ${blockedRequest}`);
        }
        throw new Error(
          `browser_navigate: goto failed for ${safeUrlForError(input.url)} (${errorKind(err)})`,
        );
      }
      const blockedRequest = networkBoundary.blockedRequest();
      if (blockedRequest) {
        throw new Error(`browser_navigate: blocked network request: ${blockedRequest}`);
      }

      // Re-validate the URL the page actually landed on (catches server-side redirects).
      const finalUrl = page.url();
      try {
        await assertNavigableUrl(finalUrl, guardOpts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `browser_navigate: redirect to blocked/disallowed URL detected after navigation: ${msg}`,
        );
      }

      return { navigated: true, url: safeUrlForError(finalUrl) };
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
      const title = truncateContent(await page.title(), 8 * 1024);
      const url = page.url();
      const safeUrl = safeUrlForError(url);
      if (url.startsWith("http://") || url.startsWith("https://")) {
        await assertNavigableUrl(url, guardOpts);
      }
      const sel = input.selector ?? "body";

      let text: string;
      try {
        text = await page.innerText(sel);
      } catch (err) {
        return {
          error: `browser_read: innerText failed for selector "${sel}" (${errorKind(err)})`,
          title,
          url: safeUrl,
        };
      }

      const truncated = truncateContent(text, maxContentBytes);
      return { title, url: safeUrl, text: truncated, truncated: truncated !== text };
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
        await ensureNetworkGuard();
        networkBoundary.resetBlockedRequest();
        await page.click(input.selector);
        const blockedRequest = networkBoundary.blockedRequest();
        if (blockedRequest) {
          return { error: `browser_click: blocked network request: ${blockedRequest}`, clicked: false };
        }
        const currentUrl = page.url();
        if (currentUrl.startsWith("http://") || currentUrl.startsWith("https://")) {
          await assertNavigableUrl(currentUrl, guardOpts);
        }
        return { clicked: true, selector: input.selector };
      } catch (err) {
        const blockedRequest = networkBoundary.blockedRequest();
        return {
          error: blockedRequest
            ? `browser_click: blocked network request: ${blockedRequest}`
            : `browser_click: click failed for selector "${input.selector}" (${errorKind(err)})`,
          clicked: false,
        };
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
        await ensureNetworkGuard();
        networkBoundary.resetBlockedRequest();
        await page.fill(input.selector, input.value);
        const blockedRequest = networkBoundary.blockedRequest();
        if (blockedRequest) {
          return { error: `browser_fill: blocked network request: ${blockedRequest}`, filled: false };
        }
        return { filled: true, selector: input.selector };
      } catch (err) {
        const blockedRequest = networkBoundary.blockedRequest();
        return {
          error: blockedRequest
            ? `browser_fill: blocked network request: ${blockedRequest}`
            : `browser_fill: fill failed for selector "${input.selector}" (${errorKind(err)})`,
          filled: false,
        };
      }
    },
  });

  return [navigateTool, readTool, clickTool, fillTool];
}

const claimedManagedContexts = new WeakSet<object>();

function assertRunIdentity(identity: BrowserRunIdentity): void {
  if (typeof identity.tenantId !== "string" || identity.tenantId.trim().length === 0) {
    throw new Error("withBrowserTools: tenantId must be a non-empty string from a verified principal");
  }
  if (typeof identity.runId !== "string" || identity.runId.trim().length === 0) {
    throw new Error("withBrowserTools: runId must be a non-empty string");
  }
}

function isBrowserContextLike(value: unknown): value is BrowserContextLike {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BrowserContextLike>;
  return typeof candidate.route === "function" &&
    typeof candidate.newPage === "function" &&
    typeof candidate.close === "function";
}

/**
 * Run browser tools inside a brand-new tenant/run-scoped browser context.
 *
 * The context factory is invoked once for this run with `serviceWorkers: "block"`. Context-level
 * request interception is installed before the first page is created, so the initial page and all
 * later popups/pages share the same egress policy. The managed page and the entire context are
 * closed after `run` settles, including throw, cancellation and suspension paths.
 *
 * A context object can be claimed only once in this process. Factories that return a shared or
 * previously used context fail closed.
 *
 * @example
 * ```ts
 * await withBrowserTools(
 *   async ({ contextOptions }) => browser.newContext(contextOptions),
 *   { tenantId: verifiedPrincipal.id, runId: sessionId },
 *   { allowlist: ["docs.example.com"] },
 *   async (tools) => {
 *     const agent = new Agent({ id: "browser", model, store, tools });
 *     for await (const event of agent.query(prompt, { sessionId })) consume(event);
 *   },
 * );
 * ```
 */
export async function withBrowserTools<T>(
  createContext: BrowserContextFactory,
  identity: BrowserRunIdentity,
  opts: BrowserToolsOptions,
  run: (tools: Tool[]) => Promise<T>,
): Promise<T> {
  assertRunIdentity(identity);
  if (opts.requireNetworkInterception === false) {
    throw new Error(
      "withBrowserTools: context-level network interception cannot be disabled; " +
      "use the deprecated unsafe shared-page shim only behind an equivalent network sandbox",
    );
  }
  const normalized = normalizeBrowserOptions({ ...opts, requireNetworkInterception: true });
  const factoryInput: BrowserContextFactoryInput = Object.freeze({
    tenantId: identity.tenantId,
    runId: identity.runId,
    contextOptions: Object.freeze({ serviceWorkers: "block" as const }),
  });

  let context: BrowserContextLike | undefined;
  let page: ManagedPageLike | undefined;
  let result: T | undefined;
  let runError: unknown;
  let runFailed = false;

  try {
    const candidate: unknown = await createContext(factoryInput);
    if (!isBrowserContextLike(candidate)) {
      if (typeof candidate === "object" && candidate !== null &&
        "close" in candidate && typeof candidate.close === "function") {
        try { await candidate.close(); } catch { /* malformed factory result: best-effort cleanup */ }
      }
      throw new Error(
        "withBrowserTools: context factory must return a Playwright-compatible BrowserContext",
      );
    }
    if (claimedManagedContexts.has(candidate)) {
      throw new Error(
        "withBrowserTools: context factory reused a prior context; a fresh context is required per tenant/run",
      );
    }
    claimedManagedContexts.add(candidate);
    context = candidate;

    const boundary = createNetworkBoundary(context, normalized.guard, true);
    await boundary.ensureInstalled();
    page = await context.newPage();
    if (typeof page.close !== "function") {
      throw new Error("withBrowserTools: managed pages must provide close()");
    }
    result = await run(buildBrowserTools(page, normalized, boundary));
  } catch (error) {
    runFailed = true;
    runError = error;
  }

  // Start both cleanup operations even if one stalls or rejects. Context.close() is the
  // authoritative boundary because it also closes every popup and background page.
  const [pageCloseResult, contextCloseResult] = await Promise.allSettled([
    (async () => { if (page) await page.close(); })(),
    (async () => { if (context) await context.close(); })(),
  ]);
  if (contextCloseResult.status === "rejected") {
    const errors: unknown[] = [];
    if (runFailed) errors.push(runError);
    if (pageCloseResult.status === "rejected") errors.push(pageCloseResult.reason);
    errors.push(contextCloseResult.reason);
    throw new AggregateError(errors, "withBrowserTools: browser run failed to close its context");
  }
  if (runFailed) throw runError;
  // A successful context close also closes every page/popup, so a redundant main-page close
  // failure does not leave tenant state alive.
  return result as T;
}

function errorKind(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "Error";
}
