import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import { createTool, ToolRegistry } from "../src/tool.js";
import { InMemoryStore } from "@eidentic/types/testing";

const echo = createTool({
  id: "echo",
  description: "echoes its message",
  inputSchema: z.object({ msg: z.string() }),
  execute: async ({ input }) => ({ echoed: input.msg }),
});

describe("tool registry & dispatch", () => {
  it("exposes schemas and dispatches a valid call", async () => {
    const reg = new ToolRegistry([echo]);
    expect(reg.schemas().map((s) => s.name)).toEqual(["echo"]);
    const [r] = await reg.dispatch([{ callId: "c1", name: "echo", input: { msg: "hi" } }]);
    expect(r).toEqual({ callId: "c1", toolName: "echo", output: { echoed: "hi" }, isError: false });
  });

  it("returns a typed error result for invalid input (no throw)", async () => {
    const reg = new ToolRegistry([echo]);
    const [r] = await reg.dispatch([{ callId: "c2", name: "echo", input: { msg: 123 } }]);
    expect(r!.isError).toBe(true);
    expect(String((r!.output as { error: string }).error)).toMatch(/invalid/i);
  });

  it("returns an error result for unknown tool, listing valid tools", async () => {
    const reg = new ToolRegistry([echo]);
    const [r] = await reg.dispatch([{ callId: "c3", name: "nope", input: {} }]);
    expect(r!.isError).toBe(true);
    expect(String((r!.output as { error: string }).error)).toMatch(/echo/);
  });

  it("truncates an overlong tool error message", async () => {
    const boom = createTool({ id: "boom", description: "x", inputSchema: z.object({}), execute: async () => { throw new Error("E".repeat(2000)); } });
    const reg = new ToolRegistry([boom]);
    const [r] = await reg.dispatch([{ callId: "c", name: "boom", input: {} }]);
    expect(r!.isError).toBe(true);
    const msg = (r!.output as { error: string }).error;
    expect(msg.length).toBeLessThan(600);
    expect(msg.endsWith("…(truncated)")).toBe(true);
  });
});

describe("ToolRegistry durable idempotency", () => {
  const makeDurable = async () => { const s = new InMemoryStore(); await s.migrate(); return s; };

  it("no-durable path is unchanged: side-effecting tools execute, no meta", async () => {
    let runs = 0;
    const writeTool = createTool({
      id: "write", description: "writes", sideEffect: "destructive",
      inputSchema: z.object({ to: z.string() }),
      idempotencyKey: (i) => `write:${i.to}`,
      execute: async () => { runs++; return { sent: true }; },
    });
    const reg = new ToolRegistry([writeTool]); // NO durable
    const [r] = await reg.dispatch([{ callId: "c1", name: "write", input: { to: "x" } }]);
    expect(runs).toBe(1);
    expect(r!.meta).toBeUndefined();
    expect(r!.output).toEqual({ sent: true });
  });

  it("read-only tools never touch the ledger even under durable", async () => {
    const durable = await makeDurable();
    let runs = 0;
    const readTool = createTool({
      id: "read", description: "reads", // default read-only
      inputSchema: z.object({}), execute: async () => { runs++; return { ok: true }; },
    });
    const reg = new ToolRegistry([readTool], { durable });
    await reg.dispatch([{ callId: "c1", name: "read", input: {} }]);
    await reg.dispatch([{ callId: "c2", name: "read", input: {} }]);
    expect(runs).toBe(2); // re-run freely
    expect(await durable.getIdempotency("read")).toBeNull(); // nothing recorded
  });

  it("intent → execute → completion: first run records applied + result", async () => {
    const durable = await makeDurable();
    let runs = 0;
    const writeTool = createTool({
      id: "write", description: "writes", sideEffect: "destructive",
      inputSchema: z.object({ to: z.string() }),
      idempotencyKey: (i) => `write:${i.to}`,
      execute: async () => { runs++; return { sent: runs }; },
    });
    const reg = new ToolRegistry([writeTool], { durable });
    const [r] = await reg.dispatch([{ callId: "c1", name: "write", input: { to: "a" } }]);
    expect(runs).toBe(1);
    expect(r!.output).toEqual({ sent: 1 });
    const rec = await durable.getIdempotency("write:a");
    expect(rec?.status).toBe("applied");
    expect(rec?.result).toEqual({ sent: 1 });
  });

  it("skip-on-applied: a second dispatch with the same key returns the cached result WITHOUT executing", async () => {
    const durable = await makeDurable();
    let runs = 0;
    const writeTool = createTool({
      id: "write", description: "writes", sideEffect: "destructive",
      inputSchema: z.object({ to: z.string() }),
      idempotencyKey: (i) => `write:${i.to}`,
      execute: async () => { runs++; return { sent: runs }; },
    });
    const reg = new ToolRegistry([writeTool], { durable });
    await reg.dispatch([{ callId: "c1", name: "write", input: { to: "a" } }]);
    const [r2] = await reg.dispatch([{ callId: "c2", name: "write", input: { to: "a" } }]);
    expect(runs).toBe(1); // NOT re-run
    expect(r2!.output).toEqual({ sent: 1 }); // cached result
    expect(r2!.meta?.durableSkipped).toBe(true);
  });

  it("idempotent tools (not just destructive) are protected by key", async () => {
    const durable = await makeDurable();
    let runs = 0;
    const upsert = createTool({
      id: "upsert", description: "upserts", sideEffect: "idempotent",
      inputSchema: z.object({ id: z.string() }),
      idempotencyKey: (i) => `upsert:${i.id}`,
      execute: async () => { runs++; return { v: runs }; },
    });
    const reg = new ToolRegistry([upsert], { durable });
    await reg.dispatch([{ callId: "c1", name: "upsert", input: { id: "z" } }]);
    const [r2] = await reg.dispatch([{ callId: "c2", name: "upsert", input: { id: "z" } }]);
    expect(runs).toBe(1);
    expect(r2!.meta?.durableSkipped).toBe(true);
  });

  it("destructive tool WITHOUT idempotencyKey under durable: executes but is marked unprotected (v1 policy)", async () => {
    const durable = await makeDurable();
    let runs = 0;
    const writeTool = createTool({
      id: "write", description: "writes", sideEffect: "destructive",
      inputSchema: z.object({}), execute: async () => { runs++; return { ok: true }; },
    });
    const reg = new ToolRegistry([writeTool], { durable });
    const [r] = await reg.dispatch([{ callId: "c1", name: "write", input: {} }]);
    expect(runs).toBe(1);
    expect(r!.meta?.durableUnprotected).toBe(true);
    expect(await durable.getIdempotency("write")).toBeNull(); // never recorded
  });

  it("argsHash collision: same key + different input returns an error result, not the stale cache", async () => {
    const durable = await makeDurable();
    let runs = 0;
    const writeTool = createTool({
      id: "write", description: "writes", sideEffect: "destructive",
      inputSchema: z.object({ to: z.string() }),
      idempotencyKey: (_i) => "fixed-key", // always the same key regardless of input
      execute: async ({ input }) => { runs++; return { to: input.to, run: runs }; },
    });
    const reg = new ToolRegistry([writeTool], { durable });
    // First dispatch: applies with input "a"
    const [r1] = await reg.dispatch([{ callId: "c1", name: "write", input: { to: "a" } }]);
    expect(r1!.isError).toBe(false);
    expect(runs).toBe(1);
    // Second dispatch: same key but DIFFERENT input "b" — must NOT return the "a" result
    const [r2] = await reg.dispatch([{ callId: "c2", name: "write", input: { to: "b" } }]);
    expect(runs).toBe(1); // tool did NOT re-execute
    expect(r2!.isError).toBe(true);
    expect((r2!.output as { error: string }).error).toMatch(/collision/);
    expect(r2!.meta?.collision).toBe(true);
    expect(r2!.meta?.durableSkipped).toBe(true);
  });

  it("argsHash match: same key + same input still returns the cached result", async () => {
    const durable = await makeDurable();
    let runs = 0;
    const writeTool = createTool({
      id: "write", description: "writes", sideEffect: "destructive",
      inputSchema: z.object({ to: z.string() }),
      idempotencyKey: (i) => `write:${i.to}`,
      execute: async ({ input }) => { runs++; return { to: input.to, run: runs }; },
    });
    const reg = new ToolRegistry([writeTool], { durable });
    await reg.dispatch([{ callId: "c1", name: "write", input: { to: "a" } }]);
    const [r2] = await reg.dispatch([{ callId: "c2", name: "write", input: { to: "a" } }]);
    expect(runs).toBe(1); // NOT re-run
    expect(r2!.isError).toBe(false);
    expect((r2!.output as { to: string; run: number }).run).toBe(1); // cached
    expect(r2!.meta?.durableSkipped).toBe(true);
    expect(r2!.meta?.collision).toBeUndefined();
  });

  describe("warn on unprotected destructive tool (via logger, routed to stderr)", () => {
    afterEach(() => vi.restoreAllMocks());

    it("fires warn for keyless destructive tool under durable", async () => {
      const durable = await makeDurable();
      // The logger routes warn to console.error (stderr), not console.warn.
      const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const writeTool = createTool({
        id: "destroy", description: "destroys", sideEffect: "destructive",
        inputSchema: z.object({}),
        execute: async () => ({ done: true }),
      });
      const reg = new ToolRegistry([writeTool], { durable });
      await reg.dispatch([{ callId: "c1", name: "destroy", input: {} }]);
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0]![0]).toMatch(/destroy/);
      expect(warnSpy.mock.calls[0]![0]).toMatch(/idempotencyKey/);
    });

    it("does NOT warn for a read-only tool under durable", async () => {
      const durable = await makeDurable();
      const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const readTool = createTool({
        id: "lookup", description: "reads", sideEffect: "read-only",
        inputSchema: z.object({}),
        execute: async () => ({ ok: true }),
      });
      const reg = new ToolRegistry([readTool], { durable });
      await reg.dispatch([{ callId: "c1", name: "lookup", input: {} }]);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("does NOT warn for a destructive tool when NOT under durable", async () => {
      const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const writeTool = createTool({
        id: "destroy", description: "destroys", sideEffect: "destructive",
        inputSchema: z.object({}),
        execute: async () => ({ done: true }),
      });
      const reg = new ToolRegistry([writeTool]); // no durable
      await reg.dispatch([{ callId: "c1", name: "destroy", input: {} }]);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  it("intent-without-completion (errored tool) does NOT mark applied → re-runs next time (v1 policy)", async () => {
    const durable = await makeDurable();
    let runs = 0;
    const flaky = createTool({
      id: "flaky", description: "throws once", sideEffect: "destructive",
      inputSchema: z.object({ to: z.string() }),
      idempotencyKey: (i) => `flaky:${i.to}`,
      execute: async () => { runs++; if (runs === 1) throw new Error("boom"); return { ok: runs }; },
    });
    const reg = new ToolRegistry([flaky], { durable });
    const [r1] = await reg.dispatch([{ callId: "c1", name: "flaky", input: { to: "a" } }]);
    expect(r1!.isError).toBe(true);
    expect((await durable.getIdempotency("flaky:a"))?.status).toBe("intent"); // intent only, not applied
    const [r2] = await reg.dispatch([{ callId: "c2", name: "flaky", input: { to: "a" } }]);
    expect(runs).toBe(2); // re-ran
    expect(r2!.output).toEqual({ ok: 2 });
    expect((await durable.getIdempotency("flaky:a"))?.status).toBe("applied");
  });

  // ─── Finding #7: idempotency key-format migration gap ─────────────────────────

  it("migration compat (#7): bare-key ledger entry (pre-session-prefix) is honoured on resume", async () => {
    // Simulates a ledger written by a version that stored bare `toolKey` without session prefix.
    // After upgrade the prefixed key is missing; the registry must fall back to the bare key
    // so that a previously-settled destructive tool is NOT re-executed.
    const durable = await makeDurable();
    let runs = 0;
    const writeTool = createTool({
      id: "write", description: "writes", sideEffect: "destructive",
      inputSchema: z.object({ to: z.string() }),
      idempotencyKey: (i) => `write:${i.to}`,
      execute: async ({ input }) => { runs++; return { sent: input.to, n: runs }; },
    });

    // Seed a bare-key entry (as the old version would have written): registry with NO sessionId.
    const seedReg = new ToolRegistry([writeTool], { durable }); // no sessionId → bare key
    const [seedResult] = await seedReg.dispatch([{ callId: "c0", name: "write", input: { to: "migrate@test.com" } }]);
    expect(seedResult!.isError).toBe(false);
    expect(runs).toBe(1); // first (seed) execution

    // Verify the bare key is in the ledger.
    const bareEntry = await durable.getIdempotency("write:migrate@test.com");
    expect(bareEntry?.status).toBe("applied");
    // The prefixed key must NOT exist yet.
    expect(await durable.getIdempotency("sess-migrate:write:migrate@test.com")).toBeNull();

    // Reset run counter — now a session-prefixed registry must NOT re-execute.
    runs = 0;
    const sessionReg = new ToolRegistry([writeTool], { durable, sessionId: "sess-migrate" });
    const [r] = await sessionReg.dispatch([{ callId: "c1", name: "write", input: { to: "migrate@test.com" } }]);

    expect(runs).toBe(0); // NOT re-executed; bare-key fallback honoured
    expect(r!.isError).toBe(false);
    expect(r!.meta?.durableSkipped).toBe(true);
    expect((r!.output as { sent: string }).sent).toBe("migrate@test.com");
  });

  it("migration compat (#7): bare-key fallback only applies when the prefixed key is absent", async () => {
    // If the prefixed key DOES exist (normal post-upgrade operation), the bare key is not consulted.
    const durable = await makeDurable();
    let runs = 0;
    const writeTool = createTool({
      id: "write", description: "writes", sideEffect: "destructive",
      inputSchema: z.object({ to: z.string() }),
      idempotencyKey: (i) => `write:${i.to}`,
      execute: async ({ input }) => { runs++; return { sent: input.to, n: runs }; },
    });
    const sessionId = "sess-new";
    const reg = new ToolRegistry([writeTool], { durable, sessionId });

    // Normal first run: writes with prefixed key.
    await reg.dispatch([{ callId: "c1", name: "write", input: { to: "new@test.com" } }]);
    expect(runs).toBe(1);
    expect(await durable.getIdempotency(`${sessionId}:write:new@test.com`)).toBeTruthy();

    // Second run: prefixed key exists → skip (no fallback needed, zero bare-key lookup).
    const [r2] = await reg.dispatch([{ callId: "c2", name: "write", input: { to: "new@test.com" } }]);
    expect(runs).toBe(1); // not re-executed
    expect(r2!.meta?.durableSkipped).toBe(true);
  });
});
