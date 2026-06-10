import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createTool } from "../src/tool.js";
import { globMatch, evaluatePermission, filterToolsForSchema } from "../src/permission.js";
import type { PermissionPolicy } from "@eidentic/types";

// --- helper ---
const makeTool = (id: string, sideEffect: "read-only" | "idempotent" | "destructive" = "read-only") =>
  createTool({ id, description: id, inputSchema: z.object({}), sideEffect, execute: async () => ({}) });

// ─── globMatch ────────────────────────────────────────────────────────────────

describe("globMatch", () => {
  it("exact match (no wildcard)", () => {
    expect(globMatch("echo", "echo")).toBe(true);
    expect(globMatch("echo", "Echo")).toBe(false);
    expect(globMatch("echo", "echo2")).toBe(false);
  });

  it("trailing wildcard", () => {
    expect(globMatch("fs_*", "fs_read")).toBe(true);
    expect(globMatch("fs_*", "fs_write")).toBe(true);
    expect(globMatch("fs_*", "net_read")).toBe(false);
    expect(globMatch("danger_*", "danger_rm")).toBe(true);
    expect(globMatch("danger_*", "safe_rm")).toBe(false);
  });

  it("leading wildcard", () => {
    expect(globMatch("*_write", "fs_write")).toBe(true);
    expect(globMatch("*_write", "db_write")).toBe(true);
    expect(globMatch("*_write", "db_read")).toBe(false);
  });

  it("universal wildcard (*) matches anything", () => {
    expect(globMatch("*", "anything")).toBe(true);
    expect(globMatch("*", "")).toBe(true);
  });

  it("mid-string wildcard", () => {
    expect(globMatch("a*b", "ab")).toBe(true);
    expect(globMatch("a*b", "axyzb")).toBe(true);
    expect(globMatch("a*b", "axyzbc")).toBe(false);
  });
});

// ─── evaluatePermission truth table ───────────────────────────────────────────

describe("evaluatePermission", () => {
  it("no policy → allow (back-compat)", () => {
    expect(evaluatePermission(undefined, { id: "any_tool", sideEffect: "destructive" })).toBe("allow");
  });

  it("empty policy → allow", () => {
    expect(evaluatePermission({}, { id: "any_tool", sideEffect: "destructive" })).toBe("allow");
  });

  it("deny glob matches → deny (overrides everything)", () => {
    const policy: PermissionPolicy = { deny: ["danger_*"], allow: ["danger_rm"] };
    expect(evaluatePermission(policy, { id: "danger_rm", sideEffect: "destructive" })).toBe("deny");
  });

  it("deny exact match → deny", () => {
    const policy: PermissionPolicy = { deny: ["secret_tool"] };
    expect(evaluatePermission(policy, { id: "secret_tool", sideEffect: "read-only" })).toBe("deny");
  });

  it("deny does not match other tools", () => {
    const policy: PermissionPolicy = { deny: ["danger_*"] };
    expect(evaluatePermission(policy, { id: "safe_read", sideEffect: "read-only" })).toBe("allow");
  });

  it("plan mode: non-read-only → deny", () => {
    const policy: PermissionPolicy = { mode: "plan" };
    expect(evaluatePermission(policy, { id: "write_file", sideEffect: "destructive" })).toBe("deny");
    expect(evaluatePermission(policy, { id: "write_file", sideEffect: "idempotent" })).toBe("deny");
  });

  it("plan mode: read-only → allow", () => {
    const policy: PermissionPolicy = { mode: "plan" };
    expect(evaluatePermission(policy, { id: "read_file", sideEffect: "read-only" })).toBe("allow");
  });

  it("allow glob matches → allow (after deny check)", () => {
    const policy: PermissionPolicy = { allow: ["safe_*"] };
    expect(evaluatePermission(policy, { id: "safe_read", sideEffect: "read-only" })).toBe("allow");
  });

  it("ask mode with no matching allow → ask", () => {
    const policy: PermissionPolicy = { mode: "ask" };
    expect(evaluatePermission(policy, { id: "any_tool", sideEffect: "destructive" })).toBe("ask");
  });

  it("ask mode but allow glob matches → allow (skip ask)", () => {
    const policy: PermissionPolicy = { mode: "ask", allow: ["safe_*"] };
    expect(evaluatePermission(policy, { id: "safe_op", sideEffect: "destructive" })).toBe("allow");
  });

  it("default mode, no deny/allow → allow", () => {
    const policy: PermissionPolicy = { mode: "default" };
    expect(evaluatePermission(policy, { id: "any_tool", sideEffect: "destructive" })).toBe("allow");
  });

  it("bypass mode → allow (falls through)", () => {
    const policy: PermissionPolicy = { mode: "bypass" };
    expect(evaluatePermission(policy, { id: "any_tool", sideEffect: "destructive" })).toBe("allow");
  });

  it("acceptEdits mode → allow (falls through)", () => {
    const policy: PermissionPolicy = { mode: "acceptEdits" };
    expect(evaluatePermission(policy, { id: "any_tool", sideEffect: "destructive" })).toBe("allow");
  });
});

// ─── filterToolsForSchema ─────────────────────────────────────────────────────

describe("filterToolsForSchema", () => {
  const read = makeTool("read_file", "read-only");
  const write = makeTool("write_file", "destructive");
  const danger = makeTool("danger_rm", "destructive");
  const upsert = makeTool("db_upsert", "idempotent");

  it("no policy → all tools visible", () => {
    const result = filterToolsForSchema([read, write, danger], undefined);
    expect(result.map((t) => t.id)).toEqual(["read_file", "write_file", "danger_rm"]);
  });

  it("deny glob removes matching tools from schema", () => {
    const policy: PermissionPolicy = { deny: ["danger_*"] };
    const result = filterToolsForSchema([read, write, danger], policy);
    expect(result.map((t) => t.id)).toEqual(["read_file", "write_file"]);
    expect(result.find((t) => t.id === "danger_rm")).toBeUndefined();
  });

  it("plan mode: removes non-read-only tools from schema", () => {
    const policy: PermissionPolicy = { mode: "plan" };
    const result = filterToolsForSchema([read, write, upsert], policy);
    expect(result.map((t) => t.id)).toEqual(["read_file"]);
  });

  it("ask mode: all tools stay visible (ask resolved at dispatch time)", () => {
    const policy: PermissionPolicy = { mode: "ask" };
    const result = filterToolsForSchema([read, write, danger], policy);
    expect(result.map((t) => t.id)).toEqual(["read_file", "write_file", "danger_rm"]);
  });

  it("allow + deny: deny takes precedence, allow tools stay visible", () => {
    const policy: PermissionPolicy = { deny: ["danger_*"], allow: ["db_*"] };
    const result = filterToolsForSchema([read, write, danger, upsert], policy);
    expect(result.find((t) => t.id === "danger_rm")).toBeUndefined();
    expect(result.find((t) => t.id === "db_upsert")).toBeDefined();
  });

  it("plan mode + deny: union of exclusions", () => {
    const policy: PermissionPolicy = { mode: "plan", deny: ["db_*"] };
    // plan removes write + upsert (non-read-only); deny removes db_upsert (already gone); net: only read_file
    const result = filterToolsForSchema([read, write, upsert], policy);
    expect(result.map((t) => t.id)).toEqual(["read_file"]);
  });
});
