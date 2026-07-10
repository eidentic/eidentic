import { describe, it, expect, afterEach } from "vitest";
import { access, mkdir, mkdtemp, rm, readFile, stat, symlink, writeFile } from "node:fs/promises";
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
  it("creates the store with owner-only permissions", async () => {
    const path = await makeTmpPath();
    const registry = createPromptRegistry(filePromptStore(path));
    await registry.register("private", "body");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("rejects a symlink destination without changing its target", async () => {
    const path = await makeTmpPath();
    const outside = join(tmpDir!, "outside.json");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, path, "file");
    const registry = createPromptRegistry(filePromptStore(path));
    await expect(registry.register("escape", "body")).rejects.toThrow(/symlink/i);
    expect(await readFile(outside, "utf8")).toBe("outside");
  });

  it("rejects a symlinked writable parent directory", async () => {
    await makeTmpPath();
    const outside = join(tmpDir!, "outside");
    const linkedParent = join(tmpDir!, "linked");
    await mkdir(outside);
    await symlink(outside, linkedParent, "dir");
    const escaped = join(linkedParent, "prompts.json");
    const registry = createPromptRegistry(filePromptStore(escaped));
    await expect(registry.register("escape", "body")).rejects.toThrow(/symlink parent/i);
    await expect(access(join(outside, "prompts.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes independent registries without losing version allocation", async () => {
    const path = await makeTmpPath();
    const first = createPromptRegistry(filePromptStore(path));
    const second = createPromptRegistry(filePromptStore(path));
    const [a, b] = await Promise.all([
      first.register("shared", "body-a"),
      second.register("shared", "body-b"),
    ]);
    expect(new Set([a.version, b.version])).toEqual(new Set([1, 2]));

    const reloaded = createPromptRegistry(filePromptStore(path));
    expect((await reloaded.history("shared")).filter((event) => event.kind === "version_registered"))
      .toHaveLength(2);
    expect((await reloaded.get("shared", 1)).body).not.toBe((await reloaded.get("shared", 2)).body);
  });

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
