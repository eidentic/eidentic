/**
 * Unit tests for loadLongMemEval / loadLoCoMo file-size pre-checks (item 6).
 *
 * We write small temporary JSON files to disk to exercise the real stat path,
 * and override maxBytes to a tiny cap so we can trigger the error without
 * creating truly large files.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLongMemEval, loadLoCoMo } from "../src/loaders.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `eidentic-bench-loaders-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeTmp(name: string, content: string): string {
  const p = join(tmpDir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

const MINIMAL_LME_JSON = JSON.stringify([
  {
    session_id: "s1",
    conversation: [{ role: "user", content: "Hello" }],
    questions: [{ question: "Q?", answer: "A", evidence: ["Hello"] }],
  },
]);

const MINIMAL_LOCOMO_JSON = JSON.stringify({
  data: [
    {
      conversation_id: "c1",
      sessions: [{ session_id: "sess1", dialog: [{ speaker: "user", text: "Hi" }] }],
      qa: [{ question: "Q?", answer: "A", evidence: ["Hi"] }],
    },
  ],
});

// ---------------------------------------------------------------------------
// loadLongMemEval — size pre-check
// ---------------------------------------------------------------------------

describe("loadLongMemEval — size pre-check (item 6)", () => {
  it("loads a valid small file successfully", async () => {
    const p = writeTmp("lme.json", MINIMAL_LME_JSON);
    const ds = await loadLongMemEval(p);
    expect(ds.name).toBe("LongMemEval");
    expect(ds.cases).toHaveLength(1);
    expect(ds.cases[0]!.id).toBe("s1");
  });

  it("throws when file size exceeds maxBytes cap", async () => {
    const p = writeTmp("big-lme.json", MINIMAL_LME_JSON);
    // Cap smaller than the file's actual byte count
    await expect(loadLongMemEval(p, { maxBytes: 1 })).rejects.toThrow(/cap|MiB|exceeds/i);
  });

  it("error message includes the file path", async () => {
    const p = writeTmp("lme-cap.json", MINIMAL_LME_JSON);
    await expect(loadLongMemEval(p, { maxBytes: 1 })).rejects.toThrow(p);
  });

  it("throws when the file does not exist", async () => {
    await expect(
      loadLongMemEval(join(tmpDir, "nonexistent.json")),
    ).rejects.toThrow(/cannot stat|ENOENT/i);
  });

  it("respects a custom maxBytes larger than the file (passes through)", async () => {
    const p = writeTmp("lme-large-cap.json", MINIMAL_LME_JSON);
    const ds = await loadLongMemEval(p, { maxBytes: 512 * 1024 * 1024 });
    expect(ds.cases).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// loadLoCoMo — size pre-check
// ---------------------------------------------------------------------------

describe("loadLoCoMo — size pre-check (item 6)", () => {
  it("loads a valid small file successfully", async () => {
    const p = writeTmp("locomo.json", MINIMAL_LOCOMO_JSON);
    const ds = await loadLoCoMo(p);
    expect(ds.name).toBe("LoCoMo");
    expect(ds.cases).toHaveLength(1);
    expect(ds.cases[0]!.id).toBe("c1");
  });

  it("throws when file size exceeds maxBytes cap", async () => {
    const p = writeTmp("big-locomo.json", MINIMAL_LOCOMO_JSON);
    await expect(loadLoCoMo(p, { maxBytes: 1 })).rejects.toThrow(/cap|MiB|exceeds/i);
  });

  it("error message includes the file path", async () => {
    const p = writeTmp("locomo-cap.json", MINIMAL_LOCOMO_JSON);
    await expect(loadLoCoMo(p, { maxBytes: 1 })).rejects.toThrow(p);
  });

  it("throws when the file does not exist", async () => {
    await expect(
      loadLoCoMo(join(tmpDir, "nonexistent.json")),
    ).rejects.toThrow(/cannot stat|ENOENT/i);
  });
});
