import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkflowRunRegistry,
  fileWorkflowRunStore,
  map,
  retry,
  step,
  withTimeout,
} from "../src/index.js";
import type { Step, StepContext, WorkflowRunRecord } from "../src/index.js";

const noop: Step<number, number> = async (value) => value;

function context(signal?: AbortSignal): StepContext {
  return { signal, emit: () => undefined, path: [] };
}

const invalidPositiveSafeIntegers = [
  { label: "zero", value: 0 },
  { label: "negative", value: -1 },
  { label: "fractional", value: 1.5 },
  { label: "NaN", value: Number.NaN },
  { label: "Infinity", value: Number.POSITIVE_INFINITY },
  { label: "unsafe", value: Number.MAX_SAFE_INTEGER + 1 },
];

describe("workflow numeric option validation", () => {
  it.each(invalidPositiveSafeIntegers)("rejects $label map concurrency at construction", ({ value }) => {
    expect(() => map(noop, { concurrency: value })).toThrow(/concurrency.*positive safe integer/i);
  });

  it.each(invalidPositiveSafeIntegers)("rejects $label retry maxAttempts at construction", ({ value }) => {
    expect(() => retry(noop, { maxAttempts: value })).toThrow(/maxAttempts.*positive safe integer/i);
  });

  it.each(invalidPositiveSafeIntegers)("rejects $label retry backoffMs at construction", ({ value }) => {
    expect(() => retry(noop, { maxAttempts: 1, backoffMs: value })).toThrow(/backoffMs.*positive safe integer/i);
  });

  it.each(invalidPositiveSafeIntegers)("rejects $label inline retry maxAttempts at construction", ({ value }) => {
    expect(() => step("invalid", noop, { retry: { maxAttempts: value } })).toThrow(
      /maxAttempts.*positive safe integer/i,
    );
  });

  it.each(invalidPositiveSafeIntegers)("rejects $label inline retry backoffMs at construction", ({ value }) => {
    expect(() => step("invalid", noop, { retry: { maxAttempts: 1, backoffMs: value } })).toThrow(
      /backoffMs.*positive safe integer/i,
    );
  });

  it.each(invalidPositiveSafeIntegers)("rejects $label timeout at construction", ({ value }) => {
    expect(() => withTimeout(noop, value)).toThrow(/timeoutMs.*positive safe integer/i);
  });

  it.each(invalidPositiveSafeIntegers)("rejects $label registry limit at construction", ({ value }) => {
    expect(() => createWorkflowRunRegistry({ limit: value })).toThrow(/limit.*positive safe integer/i);
  });

  it.each(invalidPositiveSafeIntegers)("rejects $label maxRuns alias at construction", ({ value }) => {
    expect(() => createWorkflowRunRegistry({ maxRuns: value })).toThrow(/maxRuns.*positive safe integer/i);
  });

  it.each(invalidPositiveSafeIntegers)("rejects $label resume lease at construction", ({ value }) => {
    expect(() => createWorkflowRunRegistry({ resumeLeaseMs: value })).toThrow(
      /resumeLeaseMs.*positive safe integer/i,
    );
  });

  it("validates an ignored maxRuns alias instead of silently accepting bad configuration", () => {
    expect(() => createWorkflowRunRegistry({ limit: 10, maxRuns: 0 })).toThrow(
      /maxRuns.*positive safe integer/i,
    );
  });
});

describe("retry cancellation listener lifecycle", () => {
  it("removes the combinator backoff listener after normal timer completion", async () => {
    const signal = new AbortController().signal;
    const add = vi.spyOn(signal, "addEventListener");
    const remove = vi.spyOn(signal, "removeEventListener");
    let attempts = 0;
    const flaky: Step<number, number> = async (value) => {
      if (++attempts === 1) throw new Error("retry");
      return value;
    };

    await expect(retry(flaky, { maxAttempts: 2, backoffMs: 1 })(7, context(signal))).resolves.toBe(7);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
  });

  it("removes the inline retry backoff listener after normal timer completion", async () => {
    const signal = new AbortController().signal;
    const add = vi.spyOn(signal, "addEventListener");
    const remove = vi.spyOn(signal, "removeEventListener");
    let attempts = 0;
    const flaky: Step<number, number> = async (value) => {
      if (++attempts === 1) throw new Error("retry");
      return value;
    };
    const wrapped = step("flaky", flaky, { retry: { maxAttempts: 2, backoffMs: 1 } });

    await expect(wrapped(9, context(signal))).resolves.toBe(9);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
  });
});

function record(id: string): WorkflowRunRecord {
  return {
    id,
    name: "hardening",
    status: "ok",
    runStatus: "completed",
    startedAt: 0,
    durationMs: 0,
    stepCount: 0,
    trace: [],
  };
}

describe("fileWorkflowRunStore hardening", () => {
  it("rejects a symlinked parent without writing through it", async () => {
    const root = mkdtempSync(join(tmpdir(), "eidentic-workflow-parent-"));
    try {
      const outside = join(root, "outside");
      const linkedParent = join(root, "linked-parent");
      writeFileSync(join(root, "marker"), "safe", "utf8");
      // The symlink target exists, but the store must never create runs.json through it.
      symlinkSync(root, linkedParent, "dir");
      const target = join(linkedParent, "runs.json");

      await expect(fileWorkflowRunStore(target).save(record("escape"))).rejects.toThrow(/symlink/i);
      expect(existsSync(join(root, "runs.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked ancestor before creating missing descendants", async () => {
    const root = mkdtempSync(join(tmpdir(), "eidentic-workflow-ancestor-"));
    const outside = mkdtempSync(join(tmpdir(), "eidentic-workflow-outside-"));
    try {
      const linkedAncestor = join(root, "linked");
      symlinkSync(outside, linkedAncestor, "dir");
      const target = join(linkedAncestor, "new", "runs.json");

      await expect(fileWorkflowRunStore(target).save(record("escape"))).rejects.toThrow(/symlink/i);
      expect(existsSync(join(outside, "new", "runs.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("replaces a permissive snapshot with an owner-only atomic snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "eidentic-workflow-mode-"));
    try {
      const target = join(root, "runs.json");
      writeFileSync(target, "[]", { encoding: "utf8", mode: 0o644 });
      chmodSync(target, 0o644);

      await fileWorkflowRunStore(target).save(record("private"));

      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(target, "utf8"))).toHaveLength(1);
      expect(readdirSync(root).filter((name) => name.includes(`${basename(target)}.`))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("repairs permissive permissions before returning data from an existing snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "eidentic-workflow-read-mode-"));
    try {
      const target = join(root, "runs.json");
      writeFileSync(target, JSON.stringify([record("existing")]), { encoding: "utf8", mode: 0o644 });
      chmodSync(target, 0o644);

      await expect(fileWorkflowRunStore(target).load("existing")).resolves.toMatchObject({ id: "existing" });
      expect(statSync(target).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the cross-process lock path is a symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "eidentic-workflow-lock-link-"));
    try {
      const target = join(root, "runs.json");
      const outside = join(root, "outside");
      writeFileSync(outside, "unchanged", "utf8");
      symlinkSync(outside, join(root, ".runs.json.lock"), "file");

      await expect(fileWorkflowRunStore(target).save(record("blocked"))).rejects.toThrow(/symlink/i);
      expect(readFileSync(outside, "utf8")).toBe("unchanged");
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recovers an old lock whose owner process is no longer alive", async () => {
    const root = mkdtempSync(join(tmpdir(), "eidentic-workflow-stale-lock-"));
    try {
      const target = join(root, "runs.json");
      const lock = join(root, ".runs.json.lock");
      writeFileSync(lock, JSON.stringify({ token: "dead", pid: 2_147_483_647 }), {
        encoding: "utf8",
        mode: 0o600,
      });
      const stale = new Date(Date.now() - 31_000);
      utimesSync(lock, stale, stale);

      await expect(fileWorkflowRunStore(target).save(record("recovered"))).resolves.toBeUndefined();
      expect(existsSync(lock)).toBe(false);
      expect(JSON.parse(readFileSync(target, "utf8"))).toMatchObject([{ id: "recovered" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes independent store instances without losing concurrent updates", async () => {
    const root = mkdtempSync(join(tmpdir(), "eidentic-workflow-lock-"));
    try {
      const target = join(root, "runs.json");
      const stores = [fileWorkflowRunStore(target), fileWorkflowRunStore(target)];
      await Promise.all(
        Array.from({ length: 24 }, (_, index) => stores[index % stores.length]!.save(record(`r-${index}`))),
      );

      const persisted = await fileWorkflowRunStore(target).list();
      expect(new Set(persisted.map((item) => item.id))).toEqual(
        new Set(Array.from({ length: 24 }, (_, index) => `r-${index}`)),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
