import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileTools } from "../src/index.js";

function byId(tools: ReturnType<typeof fileTools>, id: string) {
  const t = tools.find((x) => x.id === id);
  if (!t) throw new Error(`no tool ${id}`);
  return t;
}

describe("fileTools", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "eidentic-tools-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("write_file then read_file round-trips, creating parent dirs", async () => {
    const tools = fileTools({ root });
    const w = await byId(tools, "write_file").execute({ path: "a/b/c.txt", content: "hello" });
    expect((w as { bytesWritten: number }).bytesWritten).toBe(5);
    const r = await byId(tools, "read_file").execute({ path: "a/b/c.txt" });
    expect((r as { content: string }).content).toBe("hello");
  });

  it("write_file is destructive with an idempotencyKey; read/glob/grep are read-only", () => {
    const tools = fileTools({ root });
    expect(byId(tools, "write_file").sideEffect).toBe("destructive");
    expect(byId(tools, "write_file").idempotencyKey).toBeTypeOf("function");
    expect(byId(tools, "edit_file").sideEffect).toBe("destructive");
    expect(byId(tools, "read_file").sideEffect).toBe("read-only");
    expect(byId(tools, "glob").sideEffect).toBe("read-only");
    expect(byId(tools, "grep").sideEffect).toBe("read-only");
  });

  it("edit_file replaces a unique occurrence", async () => {
    const tools = fileTools({ root });
    await byId(tools, "write_file").execute({ path: "f.txt", content: "foo BAR baz" });
    await byId(tools, "edit_file").execute({ path: "f.txt", oldString: "BAR", newString: "QUX" });
    expect(await readFile(join(root, "f.txt"), "utf8")).toBe("foo QUX baz");
  });

  it("edit_file errors when oldString is missing or ambiguous", async () => {
    const tools = fileTools({ root });
    await byId(tools, "write_file").execute({ path: "f.txt", content: "x x" });
    await expect(byId(tools, "edit_file").execute({ path: "f.txt", oldString: "x", newString: "y" }))
      .rejects.toThrow(/ambiguous/);
    await expect(byId(tools, "edit_file").execute({ path: "f.txt", oldString: "nope", newString: "y" }))
      .rejects.toThrow(/not found/);
  });

  it("glob matches **/* and *.ext patterns", async () => {
    const tools = fileTools({ root });
    await byId(tools, "write_file").execute({ path: "src/a.ts", content: "" });
    await byId(tools, "write_file").execute({ path: "src/nested/b.ts", content: "" });
    await byId(tools, "write_file").execute({ path: "readme.md", content: "" });
    const g1 = (await byId(tools, "glob").execute({ pattern: "**/*.ts" })) as { matches: string[] };
    expect(g1.matches).toEqual(["src/a.ts", "src/nested/b.ts"]);
    const g2 = (await byId(tools, "glob").execute({ pattern: "*.md" })) as { matches: string[] };
    expect(g2.matches).toEqual(["readme.md"]);
  });

  it("grep returns matching lines with line numbers", async () => {
    const tools = fileTools({ root });
    await byId(tools, "write_file").execute({ path: "log.txt", content: "alpha\nERROR here\nbeta" });
    const out = (await byId(tools, "grep").execute({ pattern: "ERROR" })) as {
      matches: Array<{ file: string; line: number; text: string }>;
    };
    expect(out.matches).toEqual([{ file: "log.txt", line: 2, text: "ERROR here" }]);
  });

  it("read_file truncates oversized files and flags truncation", async () => {
    const tools = fileTools({ root });
    const big = "x".repeat(300 * 1024);
    await byId(tools, "write_file").execute({ path: "big.txt", content: big });
    const r = (await byId(tools, "read_file").execute({ path: "big.txt" })) as { content: string; truncated: boolean };
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBeLessThan(big.length);
  });

  // ---- §5.6 path-confinement (invariant #4): traversal MUST be impossible ----

  it("rejects .. traversal on read and write", async () => {
    const tools = fileTools({ root });
    await expect(byId(tools, "read_file").execute({ path: "../escape.txt" })).rejects.toThrow(/escape|confinement/);
    await expect(byId(tools, "write_file").execute({ path: "../escape.txt", content: "x" })).rejects.toThrow(/escape|confinement/);
  });

  it("rejects absolute paths", async () => {
    const tools = fileTools({ root });
    await expect(byId(tools, "read_file").execute({ path: "/etc/passwd" })).rejects.toThrow(/absolute/);
    await expect(byId(tools, "write_file").execute({ path: "/tmp/evil", content: "x" })).rejects.toThrow(/absolute/);
  });

  it("rejects symlink escape (a symlink pointing outside the root)", async () => {
    const outside = await mkdtemp(join(tmpdir(), "eidentic-outside-"));
    await writeFile(join(outside, "secret.txt"), "top secret");
    await mkdir(join(root, "sub"), { recursive: true });
    await symlink(outside, join(root, "sub", "link"), "dir");
    const tools = fileTools({ root });
    await expect(byId(tools, "read_file").execute({ path: "sub/link/secret.txt" })).rejects.toThrow(/symlink|confinement/);
    await rm(outside, { recursive: true, force: true });
  });

  it("write_file rejects a symlink leaf without changing its outside target", async () => {
    const outside = await mkdtemp(join(tmpdir(), "eidentic-outside-"));
    const outsideFile = join(outside, "target.txt");
    await writeFile(outsideFile, "before");
    await symlink(outsideFile, join(root, "link.txt"), "file");

    const tools = fileTools({ root });
    await expect(
      byId(tools, "write_file").execute({ path: "link.txt", content: "after" }),
    ).rejects.toThrow(/symlink|confinement/i);
    expect(await readFile(outsideFile, "utf8")).toBe("before");

    await rm(outside, { recursive: true, force: true });
  });

  it("edit_file rejects a symlink leaf without changing its target", async () => {
    const target = join(root, "target.txt");
    await writeFile(target, "before VALUE after");
    await symlink(target, join(root, "alias.txt"), "file");

    const tools = fileTools({ root });
    await expect(
      byId(tools, "edit_file").execute({
        path: "alias.txt",
        oldString: "VALUE",
        newString: "CHANGED",
      }),
    ).rejects.toThrow(/symlink|confinement/i);
    expect(await readFile(target, "utf8")).toBe("before VALUE after");
  });

  // ---- grep pattern-length cap (ReDoS defense) ----

  it("grep rejects patterns longer than 1024 chars", async () => {
    const tools = fileTools({ root });
    const longPattern = "a".repeat(1025);
    await expect(byId(tools, "grep").execute({ pattern: longPattern }))
      .rejects.toThrow(/pattern too long/);
  });

  it("grep rejects an invalid regex with a clear message", async () => {
    const tools = fileTools({ root });
    await expect(byId(tools, "grep").execute({ pattern: "([" }))
      .rejects.toThrow(/invalid regex/);
  });

  it("grep accepts a valid pattern at exactly 1024 chars", async () => {
    const tools = fileTools({ root });
    // Pattern of exactly 1024 literal chars — valid, just long
    const edgePattern = "a".repeat(1024);
    // No files match, but it should not throw
    const out = (await byId(tools, "grep").execute({ pattern: edgePattern })) as { matches: unknown[] };
    expect(Array.isArray(out.matches)).toBe(true);
  });

  it("grep rejects nested quantified expressions that can catastrophically backtrack", async () => {
    const tools = fileTools({ root });
    await expect(byId(tools, "grep").execute({ pattern: "(a+)+$" }))
      .rejects.toThrow(/unsafe|backtracking|ReDoS/i);
  });

  it("terminates catastrophic patterns that evade the static heuristic", async () => {
    await writeFile(join(root, "attack.txt"), `${"a".repeat(30)}!`);
    const tools = fileTools({ root });
    await expect(byId(tools, "grep").execute({ pattern: "((a+))+$" }))
      .rejects.toThrow(/timed out|ReDoS/i);
  });

  it("grep skips oversized files and reports a truncated scan", async () => {
    await writeFile(join(root, "huge.txt"), `${"a".repeat(2 * 1024 * 1024)}MATCH`);
    await writeFile(join(root, "small.txt"), "MATCH");
    const tools = fileTools({ root });

    const out = await byId(tools, "grep").execute({ pattern: "MATCH" }) as {
      matches: Array<{ file: string }>;
      truncated: boolean;
    };
    expect(out.matches).toEqual([{ file: "small.txt", line: 1, text: "MATCH" }]);
    expect(out.truncated).toBe(true);
  });
});
