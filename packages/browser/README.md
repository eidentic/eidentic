# @eidentic/browser

Sealed browser-automation tools for Eidentic — first-class sandboxed browser tools over an
injected `PageLike` page. Pass any object that satisfies the `PageLike` interface: a real
Playwright `Page`, or a faithful in-memory fake for tests.

## Install

```bash
pnpm add @eidentic/browser playwright-core
npx playwright install chromium
```

## Usage

```ts
import { chromium } from "playwright-core";
import { browserTools } from "@eidentic/browser";
import { Agent } from "eidentic";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

const agent = new Agent({
  id: "web-agent",
  model,
  store,
  tools: browserTools(page, {
    allowlist: ["example.com", "docs.example.com"],
  }),
});

for await (const ev of agent.query("What is on the homepage of example.com?", { sessionId: "s-1" })) {
  if (ev.kind === "text_delta") process.stdout.write(ev.delta);
}

await browser.close();
```

## Tools

| Tool ID | Side effect | Description |
|---|---|---|
| `browser_navigate` | `destructive` | Navigate to an `http(s)` URL. Validates before AND after navigation (redirect escape detection). |
| `browser_read` | `read-only` | Read current page title, URL, and text (body or a CSS selector). Truncated to `maxContentBytes`. |
| `browser_click` | `destructive` | Click an element by CSS selector. Errors are tool errors, not throws. |
| `browser_fill` | `destructive` | Fill an input by CSS selector. Errors are tool errors, not throws. |

## Security

Every `browser_navigate` call:
1. Validates the target URL scheme (`http`/`https` only).
2. Checks the host against the private-IP/loopback/metadata blocklist (SSRF defense, mirrors `@eidentic/tools`).
3. Checks the host against your `allowlist` (when configured).
4. After `goto()`, **re-validates `page.url()`** — so server-side redirects that would escape the
   allowlist or land on a private host are caught and returned as tool errors before the agent can act on them.

## Options

```ts
browserTools(page, {
  // Optional: restrict navigation to these hostnames (and their subdomains).
  // Omit for no restriction; pass [] to deny all navigation.
  allowlist?: string[];

  // Default: true. Set to false only in controlled test environments.
  blockPrivateHosts?: boolean;

  // Max UTF-8 bytes in browser_read results. Default: 512 KB.
  maxContentBytes?: number;
})
```

## PageLike interface

```ts
interface PageLike {
  goto(url: string): Promise<unknown>;
  content(): Promise<string>;
  innerText(selector: string): Promise<string>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  url(): string;
  title(): Promise<string>;
  screenshot?(): Promise<Uint8Array>; // optional, not exposed as a tool in v1
}
```

A real `playwright-core` `Page` satisfies this interface structurally. No adapter needed.

## Roadmap

- `browser_screenshot`: returns a base64-encoded screenshot string. Not in v1 because binary results
  don't compose cleanly with text tool results; the encoding overhead and context-window cost warrant
  a dedicated design.

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
