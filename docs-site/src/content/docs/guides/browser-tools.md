---
title: Browser Tools
description: "@eidentic/browser — PageLike injection, the four browser automation tools, allowlist/SSRF posture, Playwright wiring."
---

`@eidentic/browser` gives agents four browser automation tools over an injected `PageLike` surface. You supply the page (a Playwright `Page` or any structural equivalent); the tools enforce SSRF guards and domain allowlisting.

## Install

```bash
npm install @eidentic/browser playwright-core
```

## Quick start with Playwright

```ts
import { chromium } from "playwright-core";
import { browserTools } from "@eidentic/browser";
import { Agent } from "eidentic";

const browser = await chromium.launch();
const page = await browser.newPage();

const agent = new Agent({
  id: "web-agent",
  model,
  store,
  tools: browserTools(page, {
    allowlist: ["docs.example.com", "api.example.com"],
  }),
});

for await (const ev of agent.query("Summarise the pricing page at https://docs.example.com/pricing", { sessionId: "s1" })) {
  if (ev.type === "text_delta") process.stdout.write(ev.delta);
}

await browser.close();
```

## `PageLike` — the injected surface

`browserTools` accepts any object that implements this structural interface. A real `playwright-core` `Page` satisfies it without an adapter:

```ts
interface PageLike {
  goto(url: string): Promise<unknown>;
  content(): Promise<string>;
  innerText(selector: string): Promise<string>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  url(): string;
  title(): Promise<string>;
  // screenshot() is optional and NOT exposed as a tool in v1
}
```

For tests, pass a faithful in-memory fake that implements the same interface.

## The four tools

| Tool id | Side effect | Description |
|---|---|---|
| `browser_navigate` | destructive | Navigate to an http(s) URL. Validates before navigating AND re-validates `page.url()` after navigation to detect redirect-based escapes. |
| `browser_read` | read-only | Return the page title, URL, and `innerText` of a CSS selector (defaults to `body`). Content is truncated to `maxContentBytes`. |
| `browser_click` | destructive | Click a CSS selector. Selector errors are surfaced as tool errors, not throws. |
| `browser_fill` | destructive | Fill an input by CSS selector. Selector errors are tool errors. |

`browser_screenshot` is not included in v1 — binary results don't compose cleanly with text tool results. It is on the roadmap.

## Options (`BrowserToolsOptions`)

| Option | Type | Default | Description |
|---|---|---|---|
| `allowlist` | `string[]` | `undefined` | Hostname allowlist. `undefined` = no domain restriction (any public host). `[]` = deny all. Non-empty = restrict to listed hosts and their subdomains. |
| `blockPrivateHosts` | `boolean` | `true` | Always reject private/loopback/link-local/cloud-metadata IPs (SSRF defense-in-depth). Set to `false` only in controlled test environments. |
| `maxContentBytes` | `number` | `524288` (512 KB) | Maximum UTF-8 bytes in `browser_read` results. Content exceeding this is truncated with a marker. |

## SSRF posture

Every navigation is validated at two points:

1. **Before `goto()`** — the target URL is checked against the allowlist and private-host blocklist.
2. **After navigation** — `page.url()` is re-validated. If a server-side redirect lands on a blocked host, the tool returns an error and does not yield the page content.

Private/loopback ranges always blocked (when `blockPrivateHosts: true`):
- IPv4: `127.x.x.x`, `10.x.x.x`, `172.16–31.x.x`, `192.168.x.x`, `169.254.x.x`
- IPv6: `::1`, `fc00::/7` ULA, `fe80::/10` link-local
- Non-dotted IPv4 literals (decimal, hex, octal) are all parsed and checked.
- `localhost` by name

The `allowlist` field uses suffix matching on dot boundaries: `"example.com"` permits `example.com` and `sub.example.com` but not `notexample.com`.

## Gotchas

- Pass a fresh `Page` per agent instance when running multiple agents concurrently — `PageLike` is closure-captured, not cloned.
- Selector errors in `browser_click` and `browser_fill` are returned as tool error strings, not thrown — the agent can read the error and try a different selector.
- `browser_read` truncates content at `maxContentBytes` and appends `\n…[content truncated]`. The `truncated: true` field in the result indicates this happened.
- `browser_navigate` always uses `http`/`https` only — `file:`, `data:`, `javascript:` schemes are rejected.
