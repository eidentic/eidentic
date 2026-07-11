import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createTool, ToolRegistry } from "@eidentic/core";
import {
  browserTools as unsafeSharedBrowserTools,
  type BrowserToolsOptions,
  type PageLike,
} from "../src/index.js";

/** Existing behavioral cases exercise the explicitly opted-in compatibility shim. */
function browserTools(page: PageLike, opts: BrowserToolsOptions = {}) {
  return unsafeSharedBrowserTools(page, {
    unsafeAllowAnyPublicHost: opts.allowlist === undefined,
    allowInsecureHttp: true,
    ...opts,
    unsafeSharedPage: true,
  });
}

// ---------------------------------------------------------------------------
// FakePage — faithful in-memory fake of PageLike for tests
//
// Tracks navigation state, returns canned content, and faithfully rejects
// bad selectors so error-path tests are meaningful.
// ---------------------------------------------------------------------------

interface CannedPage {
  url: string;
  title: string;
  /** Map from CSS selector → innerText. Use "body" for the body selector. */
  content: Record<string, string>;
}

class FakePage implements PageLike {
  private currentUrl: string;
  private currentTitle: string;
  private currentContent: Record<string, string>;
  private pages: Map<string, CannedPage>;
  /** List of URLs navigated to, in order. */
  readonly navHistory: string[] = [];
  /** List of clicks made (selector strings). */
  readonly clicks: string[] = [];
  /** List of fills made ({ selector, value }). */
  readonly fills: { selector: string; value: string }[] = [];
  private routeHandler?: (route: {
    request(): { url(): string };
    continue(): Promise<void>;
    abort(): Promise<void>;
  }) => Promise<void>;

  constructor(pages: CannedPage[]) {
    const defaultPage: CannedPage = {
      url: "about:blank",
      title: "Blank",
      content: { body: "" },
    };
    this.currentUrl = defaultPage.url;
    this.currentTitle = defaultPage.title;
    this.currentContent = defaultPage.content;
    this.pages = new Map([[defaultPage.url, defaultPage]]);
    for (const p of pages) {
      this.pages.set(p.url, p);
    }
  }

  async goto(url: string): Promise<void> {
    if (this.routeHandler) {
      let aborted = false;
      await this.routeHandler({
        request: () => ({ url: () => url }),
        continue: async () => undefined,
        abort: async () => { aborted = true; },
      });
      if (aborted) throw new Error("request aborted by route");
    }
    this.navHistory.push(url);
    const page = this.pages.get(url);
    if (page) {
      this.currentUrl = page.url;
      this.currentTitle = page.title;
      this.currentContent = page.content;
    } else {
      // Simulate landing on the URL even if there's no canned content.
      this.currentUrl = url;
      this.currentTitle = "Unknown Page";
      this.currentContent = { body: `Content of ${url}` };
    }
  }

  async content(): Promise<string> {
    return `<html><body>${this.currentContent["body"] ?? ""}</body></html>`;
  }

  async innerText(selector: string): Promise<string> {
    const val = this.currentContent[selector];
    if (val === undefined) {
      throw new Error(`No element found for selector: "${selector}"`);
    }
    return val;
  }

  async click(selector: string): Promise<void> {
    if (!this.currentContent[selector] && !Object.keys(this.currentContent).includes(selector)) {
      throw new Error(`No element found for selector: "${selector}"`);
    }
    this.clicks.push(selector);
  }

  async fill(selector: string, value: string): Promise<void> {
    if (!Object.keys(this.currentContent).includes(selector)) {
      throw new Error(`No element found for selector: "${selector}"`);
    }
    this.fills.push({ selector, value });
  }

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return this.currentTitle;
  }

  async route(
    _pattern: string,
    handler: (route: {
      request(): { url(): string };
      continue(): Promise<void>;
      abort(): Promise<void>;
    }) => Promise<void>,
  ): Promise<void> {
    this.routeHandler = handler;
  }
}

// ---------------------------------------------------------------------------
// Helper: find a tool by id in the array returned by browserTools().
// ---------------------------------------------------------------------------
function byId(tools: ReturnType<typeof browserTools>, id: string) {
  const t = tools.find((x) => x.id === id);
  if (!t) throw new Error(`no tool ${id}`);
  return t;
}

// ---------------------------------------------------------------------------
// browser_navigate — happy path + allowlist + private-host guard
// ---------------------------------------------------------------------------

describe("browser_navigate — basic navigation", () => {
  it("does not expose query credentials from navigation errors", async () => {
    class ThrowingPage extends FakePage {
      override async goto(): Promise<void> {
        throw new Error("failed https://example.com/path?token=super-secret");
      }
    }
    const page = new ThrowingPage([]);
    const tools = browserTools(page, { resolveHost: async () => ["93.184.216.34"] });
    let thrown: unknown;
    try {
      await byId(tools, "browser_navigate").execute({
        url: "https://example.com/path?token=super-secret",
      });
    } catch (error) {
      thrown = error;
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).not.toContain("super-secret");
    expect(message).toContain("https://example.com/path");
  });

  it("strips query strings and fragments from returned browser URLs", async () => {
    const page = new FakePage([
      {
        url: "https://example.com/callback?token=secret#fragment",
        title: "Callback",
        content: { body: "ok" },
      },
    ]);
    const tools = browserTools(page, { resolveHost: async () => ["93.184.216.34"] });
    const result = await byId(tools, "browser_navigate").execute({
      url: "https://example.com/callback?token=secret#fragment",
    }) as { url: string };
    expect(result.url).toBe("https://example.com/callback");
  });

  it("navigates to an allowlisted URL successfully", async () => {
    const page = new FakePage([
      { url: "https://example.com/", title: "Example", content: { body: "Hello!" } },
    ]);
    const tools = browserTools(page, { allowlist: ["example.com"] });
    const result = await byId(tools, "browser_navigate").execute({ url: "https://example.com/" });
    expect((result as { navigated: boolean }).navigated).toBe(true);
    expect(page.navHistory).toContain("https://example.com/");
  });

  it("rejects a non-allowlisted host", async () => {
    const page = new FakePage([]);
    const tools = browserTools(page, { allowlist: ["example.com"] });
    await expect(
      byId(tools, "browser_navigate").execute({ url: "https://evil.test/" }),
    ).rejects.toThrow(/allowlist/);
  });

  it("empty allowlist denies ALL navigation", async () => {
    const page = new FakePage([]);
    const tools = browserTools(page, { allowlist: [] });
    await expect(
      byId(tools, "browser_navigate").execute({ url: "https://example.com/" }),
    ).rejects.toThrow(/allowlist/);
  });

  it("denies an omitted allowlist by default", async () => {
    const page = new FakePage([]);
    const tools = unsafeSharedBrowserTools(page, {
      unsafeSharedPage: true,
      resolveHosts: false,
    });
    await expect(byId(tools, "browser_navigate").execute({ url: "https://example.com/" }))
      .rejects.toThrow(/allowlist/i);
  });

  it("explicit unsafe compatibility mode allows any public host", async () => {
    const page = new FakePage([
      { url: "https://anything.example.org/", title: "Anything", content: { body: "open" } },
    ]);
    const tools = browserTools(page, { resolveHosts: false }); // deterministic fake; no allowlist
    const result = await byId(tools, "browser_navigate").execute({ url: "https://anything.example.org/" });
    expect((result as { navigated: boolean }).navigated).toBe(true);
  });

  it("rejects non-http(s) schemes", async () => {
    const page = new FakePage([]);
    const tools = browserTools(page);
    await expect(
      byId(tools, "browser_navigate").execute({ url: "file:///etc/passwd" }),
    ).rejects.toThrow(/http/i);
    await expect(
      byId(tools, "browser_navigate").execute({ url: "javascript:alert(1)" }),
    ).rejects.toThrow(/http/i);
  });
});

describe("browser_navigate — private-host guard (SSRF defense)", () => {
  it("rejects a public-looking hostname when DNS includes a private address", async () => {
    const page = new FakePage([]);
    const tools = browserTools(page, {
      resolveHost: async () => ["93.184.216.34", "127.0.0.1"],
    });
    await expect(
      byId(tools, "browser_navigate").execute({ url: "https://files.example/document" }),
    ).rejects.toThrow(/resolved host|non-global|blocked/i);
    expect(page.navHistory).toHaveLength(0);
  });

  it("rejects URL credentials", async () => {
    const page = new FakePage([]);
    const tools = browserTools(page, {
      resolveHost: async () => ["93.184.216.34"],
    });
    await expect(
      byId(tools, "browser_navigate").execute({ url: "https://user:secret@example.com/" }),
    ).rejects.toThrow(/credentials/i);
  });

  it("blocks loopback (127.0.0.1)", async () => {
    const page = new FakePage([]);
    const tools = browserTools(page);
    await expect(
      byId(tools, "browser_navigate").execute({ url: "http://127.0.0.1/" }),
    ).rejects.toThrow(/blocked|private/i);
  });

  it("blocks localhost", async () => {
    const page = new FakePage([]);
    const tools = browserTools(page);
    await expect(
      byId(tools, "browser_navigate").execute({ url: "http://localhost/" }),
    ).rejects.toThrow(/blocked|private/i);
  });

  it("blocks cloud metadata endpoint (169.254.169.254)", async () => {
    const page = new FakePage([]);
    const tools = browserTools(page);
    await expect(
      byId(tools, "browser_navigate").execute({ url: "http://169.254.169.254/latest/meta-data" }),
    ).rejects.toThrow(/blocked|private/i);
  });

  it("blocks 10.x.x.x private range", async () => {
    const page = new FakePage([]);
    const tools = browserTools(page);
    await expect(
      byId(tools, "browser_navigate").execute({ url: "http://10.0.0.1/" }),
    ).rejects.toThrow(/blocked|private/i);
  });

  it("blockPrivateHosts: false disables the guard (for test environments)", async () => {
    // Note: this doesn't actually navigate (goto will get a synthetic URL), but
    // the validate step should pass.
    const page = new FakePage([
      { url: "http://10.0.0.1/", title: "Internal", content: { body: "ok" } },
    ]);
    const tools = browserTools(page, { blockPrivateHosts: false });
    const result = await byId(tools, "browser_navigate").execute({ url: "http://10.0.0.1/" });
    expect((result as { navigated: boolean }).navigated).toBe(true);
  });
});

describe("browser network interception", () => {
  it("blocks private subresource requests before they leave the page", async () => {
    class SubresourcePage extends FakePage {
      private handler?: (route: {
        request(): { url(): string };
        continue(): Promise<void>;
        abort(): Promise<void>;
      }) => Promise<void>;
      privateRequests = 0;

      override async route(
        _pattern: string,
        handler: (route: {
          request(): { url(): string };
          continue(): Promise<void>;
          abort(): Promise<void>;
        }) => Promise<void>,
      ): Promise<void> {
        this.handler = handler;
        await super.route(_pattern, handler);
      }

      override async goto(url: string): Promise<void> {
        await super.goto(url);
        if (!this.handler) {
          this.privateRequests++;
          return;
        }
        let aborted = false;
        await this.handler({
          request: () => ({ url: () => "http://127.0.0.1/private" }),
          continue: async () => { this.privateRequests++; },
          abort: async () => { aborted = true; },
        });
        expect(aborted).toBe(true);
      }
    }

    const page = new SubresourcePage([
      { url: "https://example.com/", title: "Example", content: { body: "ok" } },
    ]);
    const tools = browserTools(page, {
      allowlist: ["example.com"],
      resolveHost: async () => ["93.184.216.34"],
    });
    await expect(
      byId(tools, "browser_navigate").execute({ url: "https://example.com/" }),
    ).rejects.toThrow(/blocked/i);
    expect(page.privateRequests).toBe(0);
  });

  it("fails closed when the injected page cannot intercept network requests", async () => {
    class UnroutedPage implements PageLike {
      private current = "about:blank";
      async goto(url: string) { this.current = url; }
      async content() { return ""; }
      async innerText() { return ""; }
      async click() {}
      async fill() {}
      url() { return this.current; }
      async title() { return ""; }
    }
    const page = new UnroutedPage();
    const tools = browserTools(page, {
      resolveHost: async () => ["93.184.216.34"],
    });
    await expect(
      byId(tools, "browser_navigate").execute({ url: "https://example.com/" }),
    ).rejects.toThrow(/interception|route/i);
  });
});

describe("browser_navigate — redirect escape detection", () => {
  it("detects redirect to a blocked private host and errors", async () => {
    // Simulate a server-side redirect: goto sets currentUrl to a private IP.
    class RedirectingPage implements PageLike {
      private _url = "https://example.com/";
      async goto(_url: string): Promise<void> {
        // Simulate redirect to a private host.
        this._url = "http://192.168.1.1/";
      }
      async content() { return "<html><body></body></html>"; }
      async innerText(_s: string) { return ""; }
      async click(_s: string) {}
      async fill(_s: string, _v: string) {}
      url() { return this._url; }
      async title() { return "Internal"; }
    }
    const page = new RedirectingPage();
    const tools = browserTools(page, {
      allowlist: ["example.com"],
      requireNetworkInterception: false,
      resolveHosts: false,
    });
    await expect(
      byId(tools, "browser_navigate").execute({ url: "https://example.com/redirect" }),
    ).rejects.toThrow(/redirect.*blocked|redirect.*disallowed/i);
  });

  it("detects redirect to an off-allowlist host and errors", async () => {
    class OffAllowlistRedirect implements PageLike {
      private _url = "https://example.com/";
      async goto(_url: string): Promise<void> {
        this._url = "https://evil.test/";
      }
      async content() { return "<html><body></body></html>"; }
      async innerText(_s: string) { return ""; }
      async click(_s: string) {}
      async fill(_s: string, _v: string) {}
      url() { return this._url; }
      async title() { return "Evil"; }
    }
    const page = new OffAllowlistRedirect();
    const tools = browserTools(page, {
      allowlist: ["example.com"],
      requireNetworkInterception: false,
      resolveHosts: false,
    });
    await expect(
      byId(tools, "browser_navigate").execute({ url: "https://example.com/r" }),
    ).rejects.toThrow(/redirect.*blocked|redirect.*disallowed/i);
  });

  it("allows a redirect that stays within the allowlist", async () => {
    class SameHostRedirect implements PageLike {
      private _url = "https://example.com/";
      async goto(_url: string): Promise<void> {
        // Redirect to another page on the same domain — still allowed.
        this._url = "https://www.example.com/new-path";
      }
      async content() { return "<html><body></body></html>"; }
      async innerText(_s: string) { return ""; }
      async click(_s: string) {}
      async fill(_s: string, _v: string) {}
      url() { return this._url; }
      async title() { return "Example New"; }
    }
    const page = new SameHostRedirect();
    const tools = browserTools(page, {
      allowlist: ["example.com"],
      requireNetworkInterception: false,
      resolveHosts: false,
    });
    const result = await byId(tools, "browser_navigate").execute({ url: "https://example.com/old" });
    expect((result as { navigated: boolean }).navigated).toBe(true);
    expect((result as { url: string }).url).toBe("https://www.example.com/new-path");
  });
});

// ---------------------------------------------------------------------------
// browser_read — content reading + truncation
// ---------------------------------------------------------------------------

describe("browser_read — content reading", () => {
  it("does not expose query-string credentials in the returned URL", async () => {
    const page = new FakePage([
      { url: "https://example.com/page?api_key=secret", title: "Page", content: { body: "ok" } },
    ]);
    await page.goto("https://example.com/page?api_key=secret");
    const tools = browserTools(page, { resolveHost: async () => ["93.184.216.34"] });
    const result = await byId(tools, "browser_read").execute({}) as { url: string };
    expect(result.url).toBe("https://example.com/page");
  });

  it("returns title, url, and body text", async () => {
    const page = new FakePage([
      { url: "https://example.com/", title: "My Page", content: { body: "Hello world" } },
    ]);
    await page.goto("https://example.com/");
    const tools = browserTools(page);
    const result = await byId(tools, "browser_read").execute({}) as {
      title: string; url: string; text: string; truncated: boolean;
    };
    expect(result.title).toBe("My Page");
    expect(result.url).toBe("https://example.com/");
    expect(result.text).toBe("Hello world");
    expect(result.truncated).toBe(false);
  });

  it("reads a specific selector when provided", async () => {
    const page = new FakePage([
      { url: "https://example.com/", title: "Test", content: { body: "Body text", "h1": "Heading" } },
    ]);
    await page.goto("https://example.com/");
    const tools = browserTools(page);
    const result = await byId(tools, "browser_read").execute({ selector: "h1" }) as { text: string };
    expect(result.text).toBe("Heading");
  });

  it("surfaces an error result (not throw) for a missing selector", async () => {
    const page = new FakePage([
      { url: "https://example.com/", title: "Test", content: { body: "Body" } },
    ]);
    await page.goto("https://example.com/");
    const tools = browserTools(page);
    const result = await byId(tools, "browser_read").execute({ selector: ".non-existent" }) as { error: string };
    expect(result.error).toMatch(/browser_read.*innerText.*failed/i);
  });

  it("truncates content that exceeds maxContentBytes", async () => {
    const longContent = "A".repeat(1000);
    const page = new FakePage([
      { url: "https://example.com/", title: "Long", content: { body: longContent } },
    ]);
    await page.goto("https://example.com/");
    const tools = browserTools(page, { maxContentBytes: 100 });
    const result = await byId(tools, "browser_read").execute({}) as {
      text: string; truncated: boolean;
    };
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThan(longContent.length);
    expect(result.text).toContain("[content truncated]");
  });

  it("does not truncate content within maxContentBytes limit", async () => {
    const content = "Short content";
    const page = new FakePage([
      { url: "https://example.com/", title: "Short", content: { body: content } },
    ]);
    await page.goto("https://example.com/");
    const tools = browserTools(page, { maxContentBytes: 1024 });
    const result = await byId(tools, "browser_read").execute({}) as {
      text: string; truncated: boolean;
    };
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(content);
  });

  it("keeps multibyte text within maxContentBytes", async () => {
    const page = new FakePage([
      { url: "https://example.com/", title: "Unicode", content: { body: "🙂".repeat(100) } },
    ]);
    await page.goto("https://example.com/");
    const tools = browserTools(page, {
      maxContentBytes: 64,
      resolveHost: async () => ["93.184.216.34"],
    });
    const result = await byId(tools, "browser_read").execute({}) as { text: string };
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(64);
  });

  it("browser_read is read-only", () => {
    const page = new FakePage([]);
    const tools = browserTools(page);
    expect(byId(tools, "browser_read").sideEffect).toBe("read-only");
  });
});

// ---------------------------------------------------------------------------
// browser_click — happy + error paths
// ---------------------------------------------------------------------------

describe("browser_click", () => {
  it("clicks an existing element successfully", async () => {
    const page = new FakePage([
      { url: "https://example.com/", title: "Test", content: { body: "text", "button.submit": "Submit" } },
    ]);
    await page.goto("https://example.com/");
    const tools = browserTools(page);
    const result = await byId(tools, "browser_click").execute({ selector: "button.submit" }) as {
      clicked: boolean; selector: string;
    };
    expect(result.clicked).toBe(true);
    expect(result.selector).toBe("button.submit");
    expect(page.clicks).toContain("button.submit");
  });

  it("returns an error result (not throw) for a missing selector", async () => {
    const page = new FakePage([
      { url: "https://example.com/", title: "Test", content: { body: "text" } },
    ]);
    await page.goto("https://example.com/");
    const tools = browserTools(page);
    const result = await byId(tools, "browser_click").execute({ selector: ".non-existent" }) as {
      clicked: boolean; error: string;
    };
    expect(result.clicked).toBe(false);
    expect(result.error).toMatch(/browser_click.*click.*failed/i);
  });

  it("browser_click is destructive", () => {
    const page = new FakePage([]);
    const tools = browserTools(page);
    expect(byId(tools, "browser_click").sideEffect).toBe("destructive");
  });
});

// ---------------------------------------------------------------------------
// browser_fill — happy + error paths
// ---------------------------------------------------------------------------

describe("browser_fill", () => {
  it("fills an existing input successfully", async () => {
    const page = new FakePage([
      { url: "https://example.com/", title: "Form", content: { body: "text", "#username": "" } },
    ]);
    await page.goto("https://example.com/");
    const tools = browserTools(page);
    const result = await byId(tools, "browser_fill").execute({ selector: "#username", value: "testuser" }) as {
      filled: boolean; selector: string;
    };
    expect(result.filled).toBe(true);
    expect(result.selector).toBe("#username");
    expect(page.fills).toContainEqual({ selector: "#username", value: "testuser" });
  });

  it("returns an error result (not throw) for a missing selector", async () => {
    const page = new FakePage([
      { url: "https://example.com/", title: "Form", content: { body: "text" } },
    ]);
    await page.goto("https://example.com/");
    const tools = browserTools(page);
    const result = await byId(tools, "browser_fill").execute({ selector: "#missing", value: "hi" }) as {
      filled: boolean; error: string;
    };
    expect(result.filled).toBe(false);
    expect(result.error).toMatch(/browser_fill.*fill.*failed/i);
  });

  it("browser_fill is destructive", () => {
    const page = new FakePage([]);
    const tools = browserTools(page);
    expect(byId(tools, "browser_fill").sideEffect).toBe("destructive");
  });
});

// ---------------------------------------------------------------------------
// ToolRegistry integration — dispatch test
// ---------------------------------------------------------------------------

describe("browserTools — ToolRegistry dispatch integration", () => {
  it("tools register and dispatch correctly via ToolRegistry", async () => {
    const page = new FakePage([
      { url: "https://example.com/", title: "Registry Test", content: { body: "Registry body", "#search": "" } },
    ]);
    await page.goto("https://example.com/");
    const tools = browserTools(page, { allowlist: ["example.com"] });
    const registry = new ToolRegistry(tools);

    // Verify all 4 tools are registered.
    const schemaNames = registry.schemas().map((s) => s.name);
    expect(schemaNames).toContain("browser_navigate");
    expect(schemaNames).toContain("browser_read");
    expect(schemaNames).toContain("browser_click");
    expect(schemaNames).toContain("browser_fill");

    // Dispatch browser_read.
    const [readResult] = await registry.dispatch([
      { callId: "r1", name: "browser_read", input: {} },
    ]);
    expect(readResult!.isError).toBe(false);
    expect((readResult!.output as { title: string }).title).toBe("Registry Test");

    // Dispatch browser_navigate with an invalid URL — should be an error result, not a throw.
    const [navResult] = await registry.dispatch([
      { callId: "n1", name: "browser_navigate", input: { url: "https://evil.test/" } },
    ]);
    expect(navResult!.isError).toBe(true);
  });

  it("invalid input returns a typed error result (no throw)", async () => {
    const page = new FakePage([]);
    const tools = browserTools(page);
    const registry = new ToolRegistry(tools);

    // Missing required 'selector' field for browser_fill.
    const [result] = await registry.dispatch([
      { callId: "x1", name: "browser_fill", input: { value: "oops" } }, // missing selector
    ]);
    expect(result!.isError).toBe(true);
  });

  it("composes with extra tools in the same registry", async () => {
    const page = new FakePage([]);
    const pingTool = createTool({
      id: "ping",
      description: "pings",
      inputSchema: z.object({}),
      execute: async () => ({ pong: true }),
    });
    const tools = [...browserTools(page), pingTool];
    const registry = new ToolRegistry(tools);
    const schemaNames = registry.schemas().map((s) => s.name);
    expect(schemaNames).toContain("ping");
    expect(schemaNames).toContain("browser_navigate");
    const [r] = await registry.dispatch([{ callId: "p1", name: "ping", input: {} }]);
    expect((r!.output as { pong: boolean }).pong).toBe(true);
  });
});
