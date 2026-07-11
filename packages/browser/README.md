# @eidentic/browser

Sealed browser automation for Eidentic with a fresh Playwright-compatible browser context and
page for every verified tenant run. The managed API installs context-wide egress interception
before page creation and closes the page, popups, and context when the run settles.

## Install

```bash
pnpm add @eidentic/browser playwright-core
npx playwright install chromium
```

## Usage

```ts
import { chromium } from "playwright-core";
import { withBrowserTools } from "@eidentic/browser";
import { Agent } from "eidentic";

const browser = await chromium.launch({ headless: true });
const sessionId = "session-from-your-request-boundary";
const tenantId = verifiedPrincipal.userId;

await withBrowserTools(
  // Always forward contextOptions: it contains serviceWorkers: "block".
  async ({ contextOptions }) => browser.newContext(contextOptions),
  { tenantId, runId: sessionId },
  {
    allowlist: ["example.com", "docs.example.com"],
  },
  async (tools) => {
    const agent = new Agent({
      id: "web-agent",
      instructions: "Browse only the approved documentation sites.",
      model,
      store,
      tools,
    });

    for await (const ev of agent.query(
      "What is on the homepage of example.com?",
      { sessionId },
    )) {
      if (ev.type === "stream.delta") process.stdout.write(ev.delta.text);
    }
  },
); // page and context are closed here, including error/cancellation paths

await browser.close();
```

## Tools

| Tool ID | Side effect | Description |
|---|---|---|
| `browser_navigate` | `destructive` | Navigate to an allowlisted HTTPS URL. DNS-validates the document, redirects, and subresources before I/O. |
| `browser_read` | `read-only` | Read current page title, URL, and text (body or a CSS selector). Truncated to `maxContentBytes`. |
| `browser_click` | `destructive` | Click an element by CSS selector. Errors are tool errors, not throws. |
| `browser_fill` | `destructive` | Fill an input by CSS selector. Errors are tool errors, not throws. |

## Security

`withBrowserTools` is the safe default. It:

1. Requires explicit non-empty `tenantId` and `runId` values from your verified request boundary.
2. Calls the context factory once per run with `{ serviceWorkers: "block" }`.
3. Rejects a context object that was already claimed by another managed run in this process.
4. Installs `context.route("**/*", …)` before creating the first page. The policy therefore
   covers documents, redirects, subresources, and every later page/popup in that context.
5. Rejects URL credentials, non-global/private literal or DNS answers, and off-allowlist hosts.
6. Revalidates `page.url()` and strips URL query/fragment data from tool results.
7. Closes the main page and the entire context in a `finally`-equivalent path after the callback;
   context closure also terminates popups and background pages.

The factory is a trusted boundary: it must create a genuinely new non-persistent context and must
forward `contextOptions` unchanged. An object wrapper around a shared underlying context cannot be
detected reliably.

### Network limits

- Playwright HTTP routing does not intercept requests already controlled by a service worker.
  Managed runs request `serviceWorkers: "block"`; ignoring that factory option voids this guard.
- `context.route("**/*", …)` does not govern WebSocket connections. Context closure terminates
  sockets at run end but does not validate their destination. If untrusted pages may open sockets,
  enforce the same allowlist at an egress proxy/firewall (or block WebSockets there).
- DNS validation and the browser's later connection are separate operations, so DNS rebinding
  cannot be completely eliminated without connection pinning at the network boundary.

For hostile browsing, the egress proxy/firewall is the final enforcement boundary—not Playwright
routing alone.

## Options

```ts
// docs-check-skip: option-shape reference, not an executable expression
withBrowserTools(createContext, { tenantId, runId }, {
  // Required for navigation. Omitted/empty denies all hostnames.
  allowlist?: string[];

  // Deprecated unsafe migration options; do not use without an equivalent proxy/firewall.
  unsafeAllowAnyPublicHost?: boolean;
  allowInsecureHttp?: boolean;

  // Default: true. Set to false only in controlled test environments.
  blockPrivateHosts?: boolean;

  // Max UTF-8 bytes in browser_read results. Default: 512 KB.
  maxContentBytes?: number;

  // DNS validation is on by default. A custom resolver must return every A/AAAA address.
  resolveHosts?: boolean;
  resolveHost?: (hostname: string) => Promise<string[]>;

  // Managed runs always require context interception; false is rejected.
  requireNetworkInterception?: boolean;

  // Passed to page.goto(). Default: 15 seconds.
  navigationTimeoutMs?: number;
}, async (tools) => {
  // Run one tenant/session-bound agent invocation with these tools.
})
```

## Deprecated shared-page compatibility

The old synchronous API remains as an explicit unsafe shim for staged migration:

```ts
import { browserTools } from "@eidentic/browser";

const tools = browserTools(callerOwnedPage, {
  unsafeSharedPage: true,
  allowlist: ["example.com"],
});
```

`browserTools(page, …)` is deprecated. It does not own or close the page/context, cannot prove a
fresh tenant boundary, and page-level routing does not cover every popup. Use it only while the
caller independently creates one context per run, installs equivalent context-level routing, and
closes that context in `finally`.

## PageLike interface

```ts
interface PageLike {
  goto(url: string, options?: { timeout?: number }): Promise<unknown>;
  content(): Promise<string>;
  innerText(selector: string): Promise<string>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  url(): string;
  title(): Promise<string>;
  route?(
    pattern: string,
    handler: (route: BrowserRouteLike) => void | Promise<void>,
  ): Promise<unknown>;
  close?(): Promise<void>; // required by managed runs, optional only for the legacy shim
  screenshot?(): Promise<Uint8Array>; // optional, not exposed as a tool in v1
}
```

A current `playwright-core` `Page` and `BrowserContext` satisfy the managed interfaces
structurally. The context route is mandatory in managed runs.

## Roadmap

- `browser_screenshot`: returns a base64-encoded screenshot string. Not in v1 because binary results
  don't compose cleanly with text tool results; the encoding overhead and context-window cost warrant
  a dedicated design.

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
