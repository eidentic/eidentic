import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createTool, ToolRegistry } from "../src/tool.js";
import { permissions } from "../src/permission.js";
import { MapSecrets } from "@eidentic/types/testing";
import type { PermissionPolicy, PermissionDecision, Scope } from "@eidentic/types";
import type { ToolContext } from "../src/tool.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

const scope: Scope = { kind: "agent", agentId: "test-agent" };

// ─── Dispatch permission gate ─────────────────────────────────────────────────

describe("ToolRegistry dispatch permission gate", () => {
  it("no-permissions path is unchanged: tool executes normally, no gate", async () => {
    let ran = false;
    const t = createTool({
      id: "echo", description: "echo", inputSchema: z.object({ msg: z.string() }),
      execute: async ({ input }) => { ran = true; return { echoed: input.msg }; },
    });
    const reg = new ToolRegistry([t]);
    const [r] = await reg.dispatch([{ callId: "c1", name: "echo", input: { msg: "hi" } }]);
    expect(ran).toBe(true);
    expect(r!.isError).toBe(false);
    expect(r!.output).toEqual({ echoed: "hi" });
  });

  it("an explicit secure-default policy denies mutating tools without an approval resolver", async () => {
    let ran = false;
    const t = createTool({
      id: "send_money", description: "mutates", sideEffect: "destructive",
      inputSchema: z.object({}),
      execute: async () => { ran = true; return { ok: true }; },
    });
    const reg = new ToolRegistry([t], { permissions: {} });
    const [r] = await reg.dispatch([{ callId: "c1", name: "send_money", input: {} }]);
    expect(ran).toBe(false);
    expect(r?.meta?.permissionDenied).toBe(true);
  });

  it("deny policy: tool does NOT execute, returns permission-denied error", async () => {
    let ran = false;
    const dangerous = createTool({
      id: "danger_rm", description: "removes", sideEffect: "destructive",
      inputSchema: z.object({}),
      execute: async () => { ran = true; return { done: true }; },
    });
    const policy: PermissionPolicy = { deny: ["danger_*"] };
    const reg = new ToolRegistry([dangerous], { permissions: policy });
    const [r] = await reg.dispatch([{ callId: "c1", name: "danger_rm", input: {} }]);
    expect(ran).toBe(false);
    expect(r!.isError).toBe(true);
    expect((r!.output as { error: string }).error).toMatch(/permission denied/i);
    expect((r!.output as { error: string }).error).toContain("danger_rm");
    expect(r!.meta?.permissionDenied).toBe(true);
  });

  it("plan mode: non-read-only tool is denied at dispatch", async () => {
    let ran = false;
    const mutating = createTool({
      id: "write_file", description: "writes", sideEffect: "idempotent",
      inputSchema: z.object({}),
      execute: async () => { ran = true; return { ok: true }; },
    });
    const policy: PermissionPolicy = { mode: "plan" };
    const reg = new ToolRegistry([mutating], { permissions: policy });
    const [r] = await reg.dispatch([{ callId: "c1", name: "write_file", input: {} }]);
    expect(ran).toBe(false);
    expect(r!.isError).toBe(true);
    expect(r!.meta?.permissionDenied).toBe(true);
  });

  it("ask mode with onPermissionRequest returning allow: tool executes", async () => {
    let ran = false;
    const t = createTool({
      id: "ask_tool", description: "asks", sideEffect: "destructive",
      inputSchema: z.object({}),
      execute: async () => { ran = true; return { ok: true }; },
    });
    const policy: PermissionPolicy = { mode: "ask" };
    const onPermissionRequest = async (_id: string, _input: unknown): Promise<PermissionDecision> => "allow";
    const reg = new ToolRegistry([t], { permissions: policy, onPermissionRequest });
    const [r] = await reg.dispatch([{ callId: "c1", name: "ask_tool", input: {} }]);
    expect(ran).toBe(true);
    expect(r!.isError).toBe(false);
  });

  it("ask mode with onPermissionRequest returning deny: tool does NOT execute", async () => {
    let ran = false;
    const t = createTool({
      id: "ask_tool", description: "asks", sideEffect: "destructive",
      inputSchema: z.object({}),
      execute: async () => { ran = true; return { ok: true }; },
    });
    const policy: PermissionPolicy = { mode: "ask" };
    const onPermissionRequest = async (_id: string, _input: unknown): Promise<PermissionDecision> => "deny";
    const reg = new ToolRegistry([t], { permissions: policy, onPermissionRequest });
    const [r] = await reg.dispatch([{ callId: "c1", name: "ask_tool", input: {} }]);
    expect(ran).toBe(false);
    expect(r!.isError).toBe(true);
    expect(r!.meta?.permissionDenied).toBe(true);
  });

  it("ask mode with NO onPermissionRequest: tool is denied (safe default)", async () => {
    let ran = false;
    const t = createTool({
      id: "risky", description: "risky", sideEffect: "destructive",
      inputSchema: z.object({}),
      execute: async () => { ran = true; return { ok: true }; },
    });
    const policy: PermissionPolicy = { mode: "ask" };
    const reg = new ToolRegistry([t], { permissions: policy }); // no onPermissionRequest
    const [r] = await reg.dispatch([{ callId: "c1", name: "risky", input: {} }]);
    expect(ran).toBe(false);
    expect(r!.isError).toBe(true);
    expect(r!.meta?.permissionDenied).toBe(true);
  });

  it("denyByDefault: unlisted tools are denied without executing", async () => {
    let ran = false;
    const t = createTool({
      id: "deal_update", description: "updates", sideEffect: "idempotent",
      inputSchema: z.object({}),
      execute: async () => { ran = true; return { ok: true }; },
    });
    const reg = new ToolRegistry([t], { permissions: permissions.denyByDefault({ allow: ["knowledge_*"] }) });
    const [r] = await reg.dispatch([{ callId: "c1", name: "deal_update", input: {} }]);
    expect(ran).toBe(false);
    expect(r!.isError).toBe(true);
    expect(r!.meta?.permissionDenied).toBe(true);
  });

  it("onPreToolUse returning deny: tool does NOT execute (checked before policy)", async () => {
    let ran = false;
    const t = createTool({
      id: "safe_read", description: "reads", sideEffect: "read-only",
      inputSchema: z.object({}),
      execute: async () => { ran = true; return { ok: true }; },
    });
    // No policy deny, but onPreToolUse always denies
    const onPreToolUse = (_id: string, _input: unknown): PermissionDecision => "deny";
    const reg = new ToolRegistry([t], { onPreToolUse });
    const [r] = await reg.dispatch([{ callId: "c1", name: "safe_read", input: {} }]);
    expect(ran).toBe(false);
    expect(r!.isError).toBe(true);
    expect(r!.meta?.permissionDenied).toBe(true);
  });

  it("onPreToolUse returning allow cannot override an absolute deny", async () => {
    let ran = false;
    const t = createTool({
      id: "anything", description: "x", sideEffect: "destructive",
      inputSchema: z.object({}),
      execute: async () => { ran = true; return { ok: true }; },
    });
    // Policy would deny, but onPreToolUse overrides with allow
    const policy: PermissionPolicy = { deny: ["anything"] };
    const onPreToolUse = (_id: string, _input: unknown): PermissionDecision => "allow";
    const reg = new ToolRegistry([t], { permissions: policy, onPreToolUse });
    const [r] = await reg.dispatch([{ callId: "c1", name: "anything", input: {} }]);
    expect(ran).toBe(false);
    expect(r!.isError).toBe(true);
    expect(r!.meta?.permissionDenied).toBe(true);
  });

  it("onPreToolUse returning void: continues to policy evaluation", async () => {
    let ran = false;
    const t = createTool({
      id: "danger_nuke", description: "x", sideEffect: "destructive",
      inputSchema: z.object({}),
      execute: async () => { ran = true; return { ok: true }; },
    });
    const policy: PermissionPolicy = { deny: ["danger_*"] };
    const onPreToolUse = (_id: string, _input: unknown): void => { /* void — fall through */ };
    const reg = new ToolRegistry([t], { permissions: policy, onPreToolUse });
    const [r] = await reg.dispatch([{ callId: "c1", name: "danger_nuke", input: {} }]);
    expect(ran).toBe(false); // policy denied it
    expect(r!.meta?.permissionDenied).toBe(true);
  });
});

// ─── Fix 2: argument-scoped deny patterns ────────────────────────────────────

describe("Fix 2 — argument-scoped deny patterns", () => {
  it("(a) bare deny:['refund_*'] removes refund_order from schema AND denies at dispatch", async () => {
    let ran = false;
    const refund = createTool({
      id: "refund_order", description: "refunds", sideEffect: "destructive",
      inputSchema: z.object({ orderId: z.string() }),
      execute: async () => { ran = true; return { ok: true }; },
    });
    const safe = createTool({
      id: "read_orders", description: "reads", sideEffect: "read-only",
      inputSchema: z.object({}),
      execute: async () => ({ orders: [] }),
    });
    const policy: PermissionPolicy = { deny: ["refund_*"] };
    const reg = new ToolRegistry([refund, safe], { permissions: policy });

    // Schema check: refund_order must NOT appear in schemas()
    const schemas = reg.schemas();
    expect(schemas.map((s) => s.name)).not.toContain("refund_order");
    expect(schemas.map((s) => s.name)).toContain("read_orders");

    // Dispatch check: even if called directly, it is denied
    const [r] = await reg.dispatch([{ callId: "c1", name: "refund_order", input: { orderId: "123" } }]);
    expect(ran).toBe(false);
    expect(r!.isError).toBe(true);
    expect(r!.meta?.permissionDenied).toBe(true);
  });

  it("(b) deny:['refund_order(*)'] KEEPS refund_order in schema but denies ANY input at dispatch", async () => {
    let ran = false;
    const refund = createTool({
      id: "refund_order", description: "refunds", sideEffect: "destructive",
      inputSchema: z.object({ orderId: z.string() }),
      execute: async () => { ran = true; return { ok: true }; },
    });
    const policy: PermissionPolicy = { deny: ["refund_order(*)"] };
    const reg = new ToolRegistry([refund], { permissions: policy });

    // Schema check: refund_order MUST remain in schema (arg-scoped deny is conditional)
    const schemas = reg.schemas();
    expect(schemas.map((s) => s.name)).toContain("refund_order");

    // Dispatch check: denied for any input
    const [r] = await reg.dispatch([{ callId: "c1", name: "refund_order", input: { orderId: "123" } }]);
    expect(ran).toBe(false);
    expect(r!.isError).toBe(true);
    expect(r!.meta?.permissionDenied).toBe(true);
  });

  it("(b2) arg-scoped deny applies EVEN under mode:'bypass'", async () => {
    let ran = false;
    const refund = createTool({
      id: "refund_order", description: "refunds", sideEffect: "destructive",
      inputSchema: z.object({ orderId: z.string() }),
      execute: async () => { ran = true; return { ok: true }; },
    });
    const policy: PermissionPolicy = { mode: "bypass", deny: ["refund_order(*)"] };
    const reg = new ToolRegistry([refund], { permissions: policy });

    const [r] = await reg.dispatch([{ callId: "c1", name: "refund_order", input: { orderId: "anything" } }]);
    expect(ran).toBe(false);
    expect(r!.isError).toBe(true);
    expect(r!.meta?.permissionDenied).toBe(true);
  });

  it("(c) non-'*' argGlob: deny only when input matches, allow when it doesn't", async () => {
    let ran = false;
    const refund = createTool({
      id: "refund_order", description: "refunds", sideEffect: "destructive",
      inputSchema: z.object({ orderId: z.string() }),
      execute: async () => { ran = true; return { ok: true }; },
    });
    // Only deny when the JSON-stringified input contains "9999"
    const policy: PermissionPolicy = { allow: ["refund_order"], deny: ["refund_order(*9999*)"] };
    const reg = new ToolRegistry([refund], { permissions: policy });

    // Input that matches the argGlob → denied
    const [denied] = await reg.dispatch([{ callId: "c1", name: "refund_order", input: { orderId: "ord9999" } }]);
    expect(denied!.isError).toBe(true);
    expect(denied!.meta?.permissionDenied).toBe(true);
    expect(ran).toBe(false);

    // Input that does NOT match → allowed
    ran = false;
    const [allowed] = await reg.dispatch([{ callId: "c2", name: "refund_order", input: { orderId: "ord1234" } }]);
    expect(allowed!.isError).toBe(false);
    expect(ran).toBe(true);
  });
});

// ─── Fix 1: arg-scoped deny with undefined input ──────────────────────────────

describe("Fix 1 — arg-scoped deny with undefined/void input", () => {
  // A pass-through tool whose parse yields `undefined` (z.void() or z.any() with no input)
  const makePassThrough = (id: string) => ({
    id,
    description: id,
    sideEffect: "read-only" as const,
    jsonSchema: {},
    parse: (input: unknown) => ({ ok: true as const, value: input as undefined }),
    execute: async (_input: unknown) => ({ ran: true }),
  });

  it("(a) arg-scoped deny foo(*) against undefined input returns permission-denied WITHOUT throwing", async () => {
    const tool = makePassThrough("foo");
    const policy: PermissionPolicy = { deny: ["foo(*)"] };
    const reg = new ToolRegistry([tool], { permissions: policy });
    // Pre-fix this would throw TypeError: Cannot read properties of undefined (reading 'startsWith')
    const [r] = await reg.dispatch([{ callId: "c1", name: "foo", input: undefined }]);
    expect(r!.isError).toBe(true);
    expect(r!.meta?.permissionDenied).toBe(true);
    expect((r!.output as { error: string }).error).toMatch(/permission denied/i);
  });

  it("(b) arg-scoped deny foo(*) with non-undefined input is still denied", async () => {
    const tool = makePassThrough("foo");
    const policy: PermissionPolicy = { deny: ["foo(*)"] };
    const reg = new ToolRegistry([tool], { permissions: policy });
    const [r] = await reg.dispatch([{ callId: "c2", name: "foo", input: { x: 1 } }]);
    expect(r!.isError).toBe(true);
    expect(r!.meta?.permissionDenied).toBe(true);
  });

  it("(c) a different tool NOT matching the deny runs fine with undefined input", async () => {
    const fooTool = makePassThrough("foo");
    const barTool = makePassThrough("bar");
    const policy: PermissionPolicy = { deny: ["foo(*)"] };
    const reg = new ToolRegistry([fooTool, barTool], { permissions: policy });
    const [r] = await reg.dispatch([{ callId: "c3", name: "bar", input: undefined }]);
    expect(r!.isError).toBe(false);
    expect((r!.output as { ran: boolean }).ran).toBe(true);
  });
});

// ─── Fix 1 defense-in-depth: gate exception → fail-closed ────────────────────

describe("Fix 1 defense-in-depth — gate exception → deny (fail-closed)", () => {
  it("onPreToolUse that throws is caught and the call is denied with a gate-error result", async () => {
    let ran = false;
    const t = createTool({
      id: "boom_gate", description: "x", sideEffect: "read-only",
      inputSchema: z.object({}),
      execute: async () => { ran = true; return {}; },
    });
    const onPreToolUse = (_id: string, _input: unknown): never => {
      throw new Error("gate exploded");
    };
    const reg = new ToolRegistry([t], { onPreToolUse });
    const [r] = await reg.dispatch([{ callId: "c1", name: "boom_gate", input: {} }]);
    expect(ran).toBe(false);
    expect(r!.isError).toBe(true);
    expect(r!.meta?.permissionDenied).toBe(true);
    expect((r!.output as { error: string }).error).toMatch(/gate error/i);
  });
});

// ─── Fix 2: malformed deny patterns fail-safe ─────────────────────────────────

describe("Fix 2 — malformed deny patterns fail-safe (empty argGlob → match-all)", () => {
  it("deny:['refund_order('] (missing closing paren) DENIES refund_order — not silently grants", async () => {
    let ran = false;
    const refund = createTool({
      id: "refund_order", description: "refunds", sideEffect: "destructive",
      inputSchema: z.object({ orderId: z.string() }),
      execute: async () => { ran = true; return { ok: true }; },
    });
    const policy: PermissionPolicy = { deny: ["refund_order("] };
    const reg = new ToolRegistry([refund], { permissions: policy });
    const [r] = await reg.dispatch([{ callId: "c1", name: "refund_order", input: { orderId: "123" } }]);
    expect(ran).toBe(false);
    expect(r!.isError).toBe(true);
    expect(r!.meta?.permissionDenied).toBe(true);
  });

  it("deny:['refund_order()'] (empty arg parens) DENIES refund_order — not silently grants", async () => {
    let ran = false;
    const refund = createTool({
      id: "refund_order", description: "refunds", sideEffect: "destructive",
      inputSchema: z.object({ orderId: z.string() }),
      execute: async () => { ran = true; return { ok: true }; },
    });
    const policy: PermissionPolicy = { deny: ["refund_order()"] };
    const reg = new ToolRegistry([refund], { permissions: policy });
    const [r] = await reg.dispatch([{ callId: "c1", name: "refund_order", input: { orderId: "456" } }]);
    expect(ran).toBe(false);
    expect(r!.isError).toBe(true);
    expect(r!.meta?.permissionDenied).toBe(true);
  });
});

// ─── ctx injection (secrets + scope) ─────────────────────────────────────────

describe("ToolContext injection", () => {
  it("tool receives ctx.secrets from the registry config", async () => {
    let capturedCtx: ToolContext | undefined;
    const t = createTool({
      id: "api_call", description: "uses secrets", sideEffect: "read-only",
      inputSchema: z.object({}),
      execute: async ({ ctx }) => {
        capturedCtx = ctx;
        const key = await ctx?.secrets?.get("API_KEY");
        return { key };
      },
    });
    const secrets = new MapSecrets({ API_KEY: "sk-123" });
    const reg = new ToolRegistry([t], { secrets });
    const [r] = await reg.dispatch([{ callId: "c1", name: "api_call", input: {} }]);
    expect(r!.isError).toBe(false);
    expect((r!.output as { key: string }).key).toBe("sk-123");
    expect(capturedCtx?.secrets).toBe(secrets);
  });

  it("ctx.scope is the configured scope", async () => {
    let capturedScope: unknown;
    const t = createTool({
      id: "scoped", description: "reads scope", sideEffect: "read-only",
      inputSchema: z.object({}),
      execute: async ({ ctx }) => { capturedScope = ctx?.scope; return {}; },
    });
    const reg = new ToolRegistry([t], { scope });
    await reg.dispatch([{ callId: "c1", name: "scoped", input: {} }]);
    expect(capturedScope).toEqual(scope);
  });

  it("ctx is undefined when registry built without secrets/scope (no-permissions path)", async () => {
    let capturedCtx: ToolContext | undefined;
    const t = createTool({
      id: "bare", description: "bare", sideEffect: "read-only",
      inputSchema: z.object({}),
      execute: async ({ ctx }) => { capturedCtx = ctx; return {}; },
    });
    const reg = new ToolRegistry([t]); // no config at all
    await reg.dispatch([{ callId: "c1", name: "bare", input: {} }]);
    // ctx is passed but all fields are undefined
    expect(capturedCtx?.secrets).toBeUndefined();
    expect(capturedCtx?.scope).toBeUndefined();
  });
});
