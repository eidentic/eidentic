import { describe, it, expect } from "vitest";
import { isToolAllowed, contentHashOf, matchSkillGlob } from "../src/executable.js";

describe("isToolAllowed (deny-by-default capability scope, §7.6)", () => {
  it("denies ALL tools when allowedTools is undefined", () => {
    expect(isToolAllowed(undefined, "read_file")).toBe(false);
    expect(isToolAllowed(undefined, "anything")).toBe(false);
  });
  it("denies ALL tools when allowedTools is empty", () => {
    expect(isToolAllowed([], "read_file")).toBe(false);
  });
  it("allows only tools matching a declared glob", () => {
    expect(isToolAllowed(["read_*"], "read_file")).toBe(true);
    expect(isToolAllowed(["read_*"], "read_dir")).toBe(true);
    expect(isToolAllowed(["read_*"], "delete_all")).toBe(false);
    expect(isToolAllowed(["read_*", "list"], "list")).toBe(true);
  });
});

describe("matchSkillGlob parity with @eidentic/core semantics", () => {
  it("anchors and treats * as any run of chars", () => {
    expect(matchSkillGlob("read_*", "read_file")).toBe(true);
    expect(matchSkillGlob("read", "read")).toBe(true);
    expect(matchSkillGlob("read", "reader")).toBe(false);     // anchored, no wildcard
    expect(matchSkillGlob("a*c", "abc")).toBe(true);
    expect(matchSkillGlob("a*c", "ac")).toBe(true);            // * matches empty
    expect(matchSkillGlob("a*c", "abd")).toBe(false);
  });
});

describe("contentHashOf (stable provenance hash)", () => {
  it("is deterministic and ignores test fn identity / key order", () => {
    const a = contentHashOf({ name: "s", description: "d", code: "x", allowedTools: ["read_*"] });
    const b = contentHashOf({ description: "d", allowedTools: ["read_*"], name: "s", code: "x" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("changes when the skill source changes", () => {
    const a = contentHashOf({ name: "s", description: "d", code: "x" });
    const b = contentHashOf({ name: "s", description: "d", code: "y" });
    expect(a).not.toBe(b);
  });
});
