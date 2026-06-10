import { describe, it, expect } from "vitest";
import { createTool } from "../src/tool.js";
import { lazyDiscoveryTools, EAGER_TOOL_IDS, loadedToolNames, lazyManifest } from "../src/discovery-tools.js";
import type { StoredEvent, ToolSchema } from "@eidentic/types";
import { z } from "zod";

function tool(id: string, description: string) {
  return createTool({ id, description, inputSchema: z.object({}), execute: async () => ({ ok: true }) });
}

/** Minimal candidate schemas the discovery tools see (post-permission-filter). */
const candidates: ToolSchema[] = [
  { name: "send_email", description: "Send an email message to a recipient", inputSchema: { type: "object" } },
  { name: "send_sms", description: "Send an SMS text message", inputSchema: { type: "object" } },
  { name: "create_invoice", description: "Create a billing invoice for an order", inputSchema: { type: "object" } },
  { name: "bash", description: "Run a shell command", inputSchema: { type: "object" } },
];

describe("search_tools", () => {
  const [search] = lazyDiscoveryTools(() => candidates, { eager: new Set(["bash"]), topK: 3 });

  it("ranks by keyword overlap over name+description, signatures only", async () => {
    const out = (await search.execute({ query: "send email message" })) as { results: { name: string; description: string }[] };
    expect(out.results[0]).toEqual({ name: "send_email", description: "Send an email message to a recipient" });
    // signatures ONLY — no inputSchema leaks through
    expect(out.results.every((r) => !("inputSchema" in r))).toBe(true);
    expect(out.results.length).toBeLessThanOrEqual(3);
  });

  it("is deterministic with a stable name tie-break", async () => {
    const out1 = (await search.execute({ query: "send" })) as { results: { name: string }[] };
    const out2 = (await search.execute({ query: "send" })) as { results: { name: string }[] };
    expect(out1.results.map((r) => r.name)).toEqual(out2.results.map((r) => r.name));
    // send_email and send_sms both match "send" once → tie broken by name ASC
    expect(out1.results.map((r) => r.name)).toEqual(["send_email", "send_sms"]);
  });

  it("respects an explicit topK override", async () => {
    const out = (await search.execute({ query: "send", topK: 1 })) as { results: { name: string }[] };
    expect(out.results.length).toBe(1);
  });

  it("returns an empty list (not an error) when nothing matches", async () => {
    const out = (await search.execute({ query: "zzz nonexistent" })) as { results: unknown[] };
    expect(out.results).toEqual([]);
  });
});

describe("load_tool", () => {
  const [, load] = lazyDiscoveryTools(() => candidates, { eager: new Set(["bash"]), topK: 5 });

  it("loads a known tool → ok", async () => {
    expect(await load.execute({ name: "send_email" })).toEqual({ ok: true, loaded: ["send_email"] });
  });

  it("loading an eager tool is a no-op success", async () => {
    expect(await load.execute({ name: "bash" })).toEqual({ ok: true, loaded: [], note: "already loaded (eager core)" });
  });

  it("unknown tool name → tool-error result (not a throw)", async () => {
    const r = (await load.execute({ name: "no_such_tool" })) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no_such_tool");
  });

  it("both discovery tools are read-only", () => {
    const [s, l] = lazyDiscoveryTools(() => candidates, { eager: new Set(), topK: 5 });
    expect(s.sideEffect).toBe("read-only");
    expect(l.sideEffect).toBe("read-only");
  });
});

describe("loadedToolNames (pure reconstruction)", () => {
  const ev = (toolName: string, output: unknown): StoredEvent =>
    ({ id: "e", seq: 0, kind: "tool_result", payload: { callId: "c", toolName, output } } as unknown as StoredEvent);

  it("unions eager core with successful load_tool results, idempotently", () => {
    const events = [
      ev("load_tool", { ok: true, loaded: ["send_email"] }),
      ev("load_tool", { ok: true, loaded: ["send_email"] }), // duplicate → one effect
      ev("load_tool", { ok: true, loaded: ["create_invoice"] }),
      ev("load_tool", { ok: false, error: "unknown tool 'x'" }), // failed → ignored
      ev("send_email", { ok: true }), // a real tool call, not a load → ignored
    ];
    const got = loadedToolNames(events, new Set(["bash", "read_file"]));
    expect([...got].sort()).toEqual(["bash", "create_invoice", "read_file", "send_email"]);
  });

  it("with no load events returns exactly the eager core", () => {
    expect([...loadedToolNames([], new Set(["bash"]))]).toEqual(["bash"]);
  });
});

describe("lazyManifest assembly", () => {
  const schemas: ToolSchema[] = [
    ...candidates,
    { name: "search_tools", description: "Search tools", inputSchema: { type: "object" } },
    { name: "load_tool", description: "Load a tool", inputSchema: { type: "object" } },
  ];
  const eager = new Set(["bash", "search_tools", "load_tool"]);

  it("OFF (≤ threshold): byte-identical to the input schemas (same array reference)", () => {
    const out = lazyManifest(schemas, { active: false, eager, loaded: new Set() });
    expect(out).toBe(schemas); // SAME reference — zero allocation, byte-identical
  });

  it("ON: manifest = eager ∪ loaded ∪ {meta}, preserving schemas() order", () => {
    const out = lazyManifest(schemas, { active: true, eager, loaded: new Set(["send_email"]) });
    expect(out.map((s) => s.name)).toEqual(["send_email", "bash", "search_tools", "load_tool"]);
    // full schema present for loaded/eager tools (inputSchema retained, unlike search_tools results)
    expect(out.find((s) => s.name === "send_email")!.inputSchema).toEqual({ type: "object" });
  });

  it("ON: a denied tool absent from `schemas` cannot appear even if loaded-set names it", () => {
    const filtered = schemas.filter((s) => s.name !== "create_invoice"); // simulate permission filter dropped it
    const out = lazyManifest(filtered, { active: true, eager, loaded: new Set(["create_invoice", "send_email"]) });
    expect(out.map((s) => s.name)).not.toContain("create_invoice");
    expect(out.map((s) => s.name)).toContain("send_email");
  });
});
