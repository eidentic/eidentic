/**
 * Security tests for the non-backtracking glob matcher (ReDoS fix).
 *
 * These tests verify:
 *   1. Existing glob semantics are preserved (*, **, ?, literals).
 *   2. A pathological ReDoS pattern returns quickly (no catastrophic backtracking).
 *   3. Oversized patterns are rejected with a clear error.
 */
import { describe, it, expect } from "vitest";
import { matchGlobPattern, matchGlob } from "../src/index.js";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("matchGlobPattern — semantics", () => {
  it("matches a plain filename with no wildcards", () => {
    expect(matchGlobPattern("readme.md", "readme.md")).toBe(true);
    expect(matchGlobPattern("readme.md", "readme.ts")).toBe(false);
  });

  it("* matches any run of chars within a segment (not /)", () => {
    expect(matchGlobPattern("*.ts", "foo.ts")).toBe(true);
    expect(matchGlobPattern("*.ts", "foo.tsx")).toBe(false);
    expect(matchGlobPattern("*.ts", "src/foo.ts")).toBe(false); // * does not cross /
    expect(matchGlobPattern("src/*.ts", "src/foo.ts")).toBe(true);
    expect(matchGlobPattern("src/*.ts", "src/nested/foo.ts")).toBe(false);
  });

  it("** matches zero or more whole path segments", () => {
    expect(matchGlobPattern("**/*.ts", "src/a.ts")).toBe(true);
    expect(matchGlobPattern("**/*.ts", "src/nested/b.ts")).toBe(true);
    expect(matchGlobPattern("**/*.ts", "a.ts")).toBe(true); // zero segments
    expect(matchGlobPattern("**/*.ts", "a.tsx")).toBe(false);
    expect(matchGlobPattern("src/**/*.ts", "src/a.ts")).toBe(true);
    expect(matchGlobPattern("src/**/*.ts", "src/deep/nested/a.ts")).toBe(true);
    expect(matchGlobPattern("src/**/*.ts", "other/a.ts")).toBe(false);
  });

  it("** alone matches any path", () => {
    expect(matchGlobPattern("**", "foo")).toBe(true);
    expect(matchGlobPattern("**", "a/b/c")).toBe(true);
  });

  it("? matches exactly one non-/ char", () => {
    expect(matchGlobPattern("?.ts", "a.ts")).toBe(true);
    expect(matchGlobPattern("?.ts", "ab.ts")).toBe(false);
    expect(matchGlobPattern("src/?.ts", "src/a.ts")).toBe(true);
    expect(matchGlobPattern("src/?.ts", "src/ab.ts")).toBe(false);
  });

  it("literal dots and dashes are matched exactly", () => {
    expect(matchGlobPattern("package.json", "package.json")).toBe(true);
    expect(matchGlobPattern("package.json", "packageXjson")).toBe(false);
    expect(matchGlobPattern("some-file.ts", "some-file.ts")).toBe(true);
  });

  it("mixed patterns work (** + * + ?)", () => {
    expect(matchGlobPattern("src/**/?oo.ts", "src/bar/foo.ts")).toBe(true);
    expect(matchGlobPattern("src/**/?oo.ts", "src/bar/baz/foo.ts")).toBe(true);
    expect(matchGlobPattern("src/**/?oo.ts", "src/bar/afoo.ts")).toBe(false);
  });
});

describe("matchGlobPattern — ReDoS resistance", () => {
  it("a pathological pattern returns quickly against a non-matching path", () => {
    // Pattern like **a**a**a...b against a long string of 'a's with no 'b'
    // This would cause catastrophic backtracking in a naive regex engine.
    const evilPattern = "**a".repeat(20) + "b";
    const nonMatchingPath = "a".repeat(100);

    const start = Date.now();
    const result = matchGlobPattern(evilPattern, nonMatchingPath);
    const elapsed = Date.now() - start;

    expect(result).toBe(false);
    // Must complete in well under 100ms (even a few ms in practice)
    expect(elapsed).toBeLessThan(100);
  });

  it("another pathological pattern: many * wildcards in a single segment", () => {
    const evilPattern = ("*a".repeat(15) + "b");
    const nonMatchingPath = "a".repeat(50);

    const start = Date.now();
    const result = matchGlobPattern(evilPattern, nonMatchingPath);
    const elapsed = Date.now() - start;

    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(100);
  });
});

describe("matchGlob — oversized pattern rejection", () => {
  let root: string;

  it("rejects patterns longer than 1024 chars", async () => {
    root = await mkdtemp(join(tmpdir(), "eidentic-glob-sec-"));
    try {
      const longPattern = "**/" + "a".repeat(1030);
      await expect(matchGlob(root, longPattern)).rejects.toThrow(/pattern too long/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normal patterns at or below 1024 chars are accepted", async () => {
    root = await mkdtemp(join(tmpdir(), "eidentic-glob-sec-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "hello.ts"), "");
      const result = await matchGlob(root, "**/*.ts");
      expect(result).toContain("src/hello.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
