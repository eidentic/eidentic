import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPromptRegistry,
  filePromptStore,
} from "../src/index.js";

let tmpDir: string | undefined;

async function makeTmpPath(): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), "eidentic-prompts-test-"));
  return join(tmpDir, "prompts.json");
}

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe("filePromptStore — round-trip", () => {
  it("persists and reloads state correctly", async () => {
    const path = await makeTmpPath();

    // Session 1: register and tag
    const r1 = createPromptRegistry(filePromptStore(path));
    await r1.register("p", "v1 body");
    await r1.register("p", "v2 body");
    await r1.tag("p", 2, "stable");

    // Session 2: create a fresh registry pointing at the same file
    const r2 = createPromptRegistry(filePromptStore(path));
    const v = await r2.get("p", "stable");
    expect(v.version).toBe(2);
    expect(v.body).toBe("v2 body");
  });

  it("history survives a reload", async () => {
    const path = await makeTmpPath();
    const r1 = createPromptRegistry(filePromptStore(path));
    await r1.register("p", "body");
    await r1.tag("p", 1, "stable");

    const r2 = createPromptRegistry(filePromptStore(path));
    const h = await r2.history("p");
    expect(h).toHaveLength(2);
    expect(h[0]!.kind).toBe("version_registered");
    expect(h[1]!.kind).toBe("tag_moved");
  });

  it("atomic write: file is either old or new — never torn", async () => {
    const path = await makeTmpPath();
    const r = createPromptRegistry(filePromptStore(path));

    // Trigger many concurrent saves
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => r.register("p", `body-${i}`)),
    );

    // File must be valid JSON after all concurrent saves
    const raw = await readFile(path, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();

    // All 20 unique bodies should be present (dedup: body-0 through body-19)
    const parsed = JSON.parse(raw) as { versions: Array<{ body: string }> };
    expect(parsed.versions).toHaveLength(20);
  });

  it("returns undefined on load when the file does not exist yet", async () => {
    const path = await makeTmpPath();
    const store = filePromptStore(join(path, "nonexistent", "prompts.json"));
    const state = await store.load();
    expect(state).toBeUndefined();
  });

  it("rollback is preserved after reload", async () => {
    const path = await makeTmpPath();

    const r1 = createPromptRegistry(filePromptStore(path));
    await r1.register("p", "v1 body");
    await r1.register("p", "v2 body");
    await r1.tag("p", 2, "stable");
    await r1.tag("p", 1, "stable"); // rollback

    const r2 = createPromptRegistry(filePromptStore(path));
    const v = await r2.get("p", "stable");
    expect(v.version).toBe(1);
    expect(v.body).toBe("v1 body");
  });
});
