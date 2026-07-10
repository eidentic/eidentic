import { describe, it, expect } from "vitest";
import { sandboxConformanceCases } from "@eidentic/types/testing";
import { E2BSandbox, type E2BLike, type E2BExecution } from "../src/index.js";

/**
 * Faithful in-memory E2B. Mirrors the REAL `@e2b/code-interpreter` contract the adapter relies on:
 *  - `Sandbox.create(opts)` → a sandbox instance;
 *  - `runCode(code, { language })` → an `Execution` with `logs.stdout`/`logs.stderr` (string arrays)
 *    and an optional `error` ({ name, value, traceback }); NO numeric exit code;
 *  - `kill()` resolves (returns Promise<void>, matching real @e2b/code-interpreter@^2.6.0).
 * The tiny interpreter understands the deterministic program surface of `sandboxConformanceCases`:
 *  - program `fail`            → error (maps to non-zero exitCode + error string);
 *  - `echo X` under `bash`     → stdout `X` (language pass-through observable);
 *  - anything else             → stdout = the source verbatim.
 */
class FakeSandbox {
  killed = false;
  /** Options captured from the last runCode call (for assertion). */
  lastRunOpts: { language?: string; timeoutMs?: number } | undefined;
  async runCode(code: string, opts?: { language?: string; timeoutMs?: number }): Promise<E2BExecution> {
    this.lastRunOpts = opts;
    if (code.trim() === "fail") {
      return {
        logs: { stdout: [], stderr: ["boom"] },
        error: { name: "FakeError", value: "forced failure", traceback: "…" },
      };
    }
    const lang = opts?.language ?? "python";
    if (lang === "bash" && code.trim().startsWith("echo ")) {
      return { logs: { stdout: [code.trim().slice("echo ".length)], stderr: [] } };
    }
    return { logs: { stdout: [code], stderr: [] } };
  }
  async kill(): Promise<void> {
    this.killed = true;
  }
}

const fakeClient: E2BLike = {
  async create() {
    return new FakeSandbox();
  },
};

describe("E2BSandbox conformance (faithful in-memory fake)", () => {
  for (const c of sandboxConformanceCases(() => E2BSandbox.create({ client: fakeClient })))
    it(c.name, c.run);
});

describe("E2BSandbox lifecycle", () => {
  it("creates a fresh sandbox per run and kills it afterward", async () => {
    const created: FakeSandbox[] = [];
    const client: E2BLike = {
      async create() {
        const sb = new FakeSandbox();
        created.push(sb);
        return sb;
      },
    };
    const sandbox = await E2BSandbox.create({ client });
    await sandbox.run("a");
    await sandbox.run("b");
    expect(created.length).toBe(2);
    expect(created.every((s) => s.killed)).toBe(true);
  });

  it("kills sandbox even when runCode throws", async () => {
    const created: FakeSandbox[] = [];
    const throwingSandbox = new FakeSandbox();
    throwingSandbox.runCode = async () => {
      throw new Error("runCode failed");
    };
    const client: E2BLike = {
      async create() {
        created.push(throwingSandbox);
        return throwingSandbox;
      },
    };
    const sandbox = await E2BSandbox.create({ client });
    await expect(sandbox.run("x")).rejects.toThrow();
    expect(throwingSandbox.killed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M18 fix — timeoutMs forwarded to runCode; signal aborts and kills sandbox
// ---------------------------------------------------------------------------

describe("M18 fix — E2BSandbox: timeoutMs forwarded to runCode", () => {
  it("uses a finite default timeout when none is configured", async () => {
    let lastSandbox: FakeSandbox | null = null;
    const client: E2BLike = {
      async create() {
        lastSandbox = new FakeSandbox();
        return lastSandbox;
      },
    };
    const sandbox = await E2BSandbox.create({ client });
    await sandbox.run("x");
    expect(lastSandbox!.lastRunOpts?.timeoutMs).toBe(60_000);
  });

  it("passes timeoutMs from SandboxRunOptions to runCode", async () => {
    let lastSandbox: FakeSandbox | null = null;
    const client: E2BLike = {
      async create() {
        lastSandbox = new FakeSandbox();
        return lastSandbox;
      },
    };
    const sandbox = await E2BSandbox.create({ client });
    await sandbox.run("x", { timeoutMs: 5000 });
    expect(lastSandbox!.lastRunOpts?.timeoutMs).toBe(5000);
  });

  it("passes defaultTimeoutMs to runCode when no per-run timeoutMs is set", async () => {
    let lastSandbox: FakeSandbox | null = null;
    const client: E2BLike = {
      async create() {
        lastSandbox = new FakeSandbox();
        return lastSandbox;
      },
    };
    const sandbox = await E2BSandbox.create({ client, defaultTimeoutMs: 3000 });
    await sandbox.run("x");
    expect(lastSandbox!.lastRunOpts?.timeoutMs).toBe(3000);
  });

  it("per-run timeoutMs overrides defaultTimeoutMs for runCode", async () => {
    let lastSandbox: FakeSandbox | null = null;
    const client: E2BLike = {
      async create() {
        lastSandbox = new FakeSandbox();
        return lastSandbox;
      },
    };
    const sandbox = await E2BSandbox.create({ client, defaultTimeoutMs: 3000 });
    await sandbox.run("x", { timeoutMs: 1000 });
    expect(lastSandbox!.lastRunOpts?.timeoutMs).toBe(1000);
  });
});

describe("M18 fix — E2BSandbox: AbortSignal kills sandbox and throws AbortError", () => {
  it("enforces the timeout locally and kills a hanging sandbox", async () => {
    const hanging = new FakeSandbox();
    hanging.runCode = () => new Promise(() => { /* intentionally never resolves */ });
    const sandbox = await E2BSandbox.create({ client: { create: async () => hanging } });
    await expect(sandbox.run("x", { timeoutMs: 5 })).rejects.toThrow(/timed out/i);
    expect(hanging.killed).toBe(true);
  });

  it("kills a sandbox that finishes creating after the abort already won", async () => {
    const controller = new AbortController();
    const lateSandbox = new FakeSandbox();
    let resolveCreate!: (sandbox: FakeSandbox) => void;
    const client: E2BLike = {
      create: () => new Promise((resolve) => { resolveCreate = resolve; }),
    };
    const sandbox = await E2BSandbox.create({ client });
    const run = sandbox.run("x", { signal: controller.signal });
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });

    resolveCreate(lateSandbox);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lateSandbox.killed).toBe(true);
  });

  it("throws AbortError immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const created: FakeSandbox[] = [];
    const client: E2BLike = {
      async create() {
        const sb = new FakeSandbox();
        created.push(sb);
        return sb;
      },
    };
    const sandbox = await E2BSandbox.create({ client });
    let thrown: unknown;
    try {
      await sandbox.run("x", { signal: controller.signal });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe("AbortError");
    // No sandbox was created (fast-path abort before create).
    expect(created.length).toBe(0);
  });

  it("kills sandbox and throws AbortError when signal fires mid-run", async () => {
    const controller = new AbortController();

    const hangingSandbox: FakeSandbox & { killCalled: boolean } = Object.assign(new FakeSandbox(), {
      killCalled: false,
    });
    // runCode hangs forever (never resolves on its own).
    hangingSandbox.runCode = () => new Promise(() => { /* intentionally never resolves */ });
    hangingSandbox.kill = async () => {
      hangingSandbox.killCalled = true;
    };

    const client: E2BLike = {
      async create() {
        return hangingSandbox;
      },
    };
    const sandbox = await E2BSandbox.create({ client });

    const runPromise = sandbox.run("x", { signal: controller.signal });
    // Abort while the run is in-flight — the abort listener should win the race.
    controller.abort();

    let thrown: unknown;
    try {
      await runPromise;
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe("AbortError");
    expect(hangingSandbox.killCalled).toBe(true);
  });
});

describe("E2BSandbox output budget", () => {
  it("truncates stdout and stderr to the configured UTF-8 byte cap", async () => {
    const client: E2BLike = {
      async create() {
        const sandbox = new FakeSandbox();
        sandbox.runCode = async () => ({
          logs: {
            stdout: ["x".repeat(1024)],
            stderr: ["y".repeat(1024)],
          },
        });
        return sandbox;
      },
    };
    const sandbox = await E2BSandbox.create({ client, maxOutputBytes: 64 });
    const result = await sandbox.run("x");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(64);
    expect(result.stdout).toContain("truncated");
    expect(result.stderr).toContain("truncated");
  });

  it("keeps multibyte UTF-8 output within the byte cap", async () => {
    const client: E2BLike = {
      async create() {
        const sandbox = new FakeSandbox();
        sandbox.runCode = async () => ({
          logs: { stdout: ["🙂".repeat(100)], stderr: [] },
        });
        return sandbox;
      },
    };
    const sandbox = await E2BSandbox.create({ client, maxOutputBytes: 64 });
    const result = await sandbox.run("x");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(64);
  });

  it("caps execution error text as well as stdout and stderr", async () => {
    const client: E2BLike = {
      async create() {
        const sandbox = new FakeSandbox();
        sandbox.runCode = async () => ({
          logs: { stdout: [], stderr: [] },
          error: { name: "Failure", value: "secret".repeat(200), traceback: "" },
        });
        return sandbox;
      },
    };
    const sandbox = await E2BSandbox.create({ client, maxOutputBytes: 64 });
    const result = await sandbox.run("x");
    expect(Buffer.byteLength(result.error ?? "", "utf8")).toBeLessThanOrEqual(64);
    expect(result.error).toContain("truncated");
  });
});
