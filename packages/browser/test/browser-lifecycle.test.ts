import { describe, expect, it } from "vitest";
import type { Tool } from "@eidentic/core";
import {
  browserTools,
  withBrowserTools,
  type BrowserContextFactoryInput,
  type BrowserContextLike,
  type BrowserRouteLike,
  type ManagedPageLike,
} from "../src/index.js";

class ManagedFakeContext implements BrowserContextLike {
  readonly events: string[] = [];
  readonly continuedRequests: string[] = [];
  readonly pages: ManagedFakePage[] = [];
  closeCalls = 0;
  closeFailure?: Error;
  popupUrl = "http://127.0.0.1/private";
  private routeHandler?: (route: BrowserRouteLike) => void | Promise<void>;

  async route(
    _pattern: string,
    handler: (route: BrowserRouteLike) => void | Promise<void>,
  ): Promise<void> {
    this.events.push("route");
    this.routeHandler = handler;
  }

  async newPage(): Promise<ManagedFakePage> {
    this.events.push("newPage");
    const page = new ManagedFakePage(this);
    this.pages.push(page);
    return page;
  }

  async dispatch(url: string): Promise<boolean> {
    let aborted = false;
    if (this.routeHandler) {
      await this.routeHandler({
        request: () => ({ url: () => url }),
        continue: async () => { this.continuedRequests.push(url); },
        abort: async () => { aborted = true; },
      });
    } else {
      this.continuedRequests.push(url);
    }
    return aborted;
  }

  async close(): Promise<void> {
    this.events.push("context.close");
    this.closeCalls++;
    for (const page of this.pages) page.closed = true;
    if (this.closeFailure) throw this.closeFailure;
  }
}

class ManagedFakePage implements ManagedPageLike {
  closed = false;
  closeCalls = 0;
  private currentUrl = "about:blank";

  constructor(private readonly context: ManagedFakeContext) {}

  async goto(url: string): Promise<void> {
    if (await this.context.dispatch(url)) throw new Error("request aborted");
    this.currentUrl = url;
  }
  async content(): Promise<string> { return "<html><body>safe</body></html>"; }
  async innerText(): Promise<string> { return "safe"; }
  async click(selector: string): Promise<void> {
    if (selector !== "#popup") return;
    if (await this.context.dispatch(this.context.popupUrl)) throw new Error("popup request aborted");
  }
  async fill(): Promise<void> {}
  url(): string { return this.currentUrl; }
  async title(): Promise<string> { return "Safe"; }
  async close(): Promise<void> {
    this.context.events.push("page.close");
    this.closeCalls++;
    this.closed = true;
  }
}

function toolById(tools: Tool[], id: string) {
  const tool = tools.find((candidate) => candidate.id === id);
  if (!tool) throw new Error(`missing tool ${id}`);
  return tool;
}

const identity = { tenantId: "tenant-a", runId: "run-1" };
const egress = { allowlist: ["example.com"], resolveHost: async () => ["93.184.216.34"] };

describe("managed browser run lifecycle", () => {
  it("installs context interception before page creation and closes page/context after the run", async () => {
    const context = new ManagedFakeContext();
    let factoryInput: BrowserContextFactoryInput | undefined;

    const output = await withBrowserTools(
      async (input) => {
        factoryInput = input;
        return context;
      },
      identity,
      egress,
      async (tools) => {
        await toolById(tools, "browser_navigate").execute({ url: "https://example.com/" });
        const read = await toolById(tools, "browser_read").execute({}) as { text: string };
        expect(context.pages[0]!.closed).toBe(false);
        return read.text;
      },
    );

    expect(output).toBe("safe");
    expect(factoryInput).toEqual({
      tenantId: "tenant-a",
      runId: "run-1",
      contextOptions: { serviceWorkers: "block" },
    });
    expect(context.events).toEqual(["route", "newPage", "page.close", "context.close"]);
    expect(context.pages[0]!.closeCalls).toBe(1);
    expect(context.closeCalls).toBe(1);
  });

  it("applies the context route to popup requests before network I/O", async () => {
    const context = new ManagedFakeContext();
    await withBrowserTools(async () => context, identity, {
      allowlist: ["example.com"],
      ...egress,
    }, async (tools) => {
      await toolById(tools, "browser_navigate").execute({ url: "https://example.com/" });
      const result = await toolById(tools, "browser_click").execute({ selector: "#popup" }) as {
        clicked: boolean;
      };
      expect(result.clicked).toBe(false);
      expect(context.continuedRequests).not.toContain(context.popupUrl);
    });
  });

  it("closes page and context when the run throws", async () => {
    const context = new ManagedFakeContext();
    await expect(withBrowserTools(
      async () => context,
      identity,
      egress,
      async () => { throw new Error("run failed"); },
    )).rejects.toThrow("run failed");
    expect(context.pages[0]!.closeCalls).toBe(1);
    expect(context.closeCalls).toBe(1);
  });

  it("fails closed when the context cannot be closed", async () => {
    const context = new ManagedFakeContext();
    context.closeFailure = new Error("transport refused close");
    await expect(withBrowserTools(
      async () => context,
      identity,
      egress,
      async () => "completed",
    )).rejects.toThrow(/failed to close its context/i);
    expect(context.pages[0]!.closeCalls).toBe(1);
    expect(context.closeCalls).toBe(1);
  });

  it("rejects a context factory that reuses a prior run context", async () => {
    const context = new ManagedFakeContext();
    const factory = async () => context;
    await withBrowserTools(factory, identity, egress, async () => undefined);
    await expect(withBrowserTools(
      factory,
      { tenantId: "tenant-b", runId: "run-2" },
      egress,
      async () => undefined,
    )).rejects.toThrow(/fresh|reuse/i);
    expect(context.closeCalls).toBe(1);
  });

  it("requires an explicit unsafe opt-in for the deprecated shared-page shim", () => {
    const context = new ManagedFakeContext();
    const page = new ManagedFakePage(context);
    expect(() => browserTools(page)).toThrow(/unsafeSharedPage|managed browser run/i);
    expect(browserTools(page, { unsafeSharedPage: true })).toHaveLength(4);
  });

  it("validates tenant/run identity and safe interception settings before factory I/O", async () => {
    let factoryCalls = 0;
    const factory = async () => {
      factoryCalls++;
      return new ManagedFakeContext();
    };
    await expect(withBrowserTools(
      factory,
      { tenantId: "", runId: "run" },
      egress,
      async () => undefined,
    )).rejects.toThrow(/tenantId/i);
    await expect(withBrowserTools(
      factory,
      identity,
      { ...egress, requireNetworkInterception: false },
      async () => undefined,
    )).rejects.toThrow(/cannot be disabled/i);
    expect(factoryCalls).toBe(0);
  });
});
