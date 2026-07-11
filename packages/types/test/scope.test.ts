import { describe, it, expect } from "vitest";
import { scopeKey } from "../src/ports.js";
import type { Scope } from "../src/ports.js";

describe("scopeKey", () => {
  it("agent → agent:<agentId>", () => {
    const s: Scope = { kind: "agent", agentId: "ag1" };
    expect(scopeKey(s)).toBe("agent:ag1");
  });

  it("user → user:<agentId>:<userId>", () => {
    const s: Scope = { kind: "user", agentId: "ag1", userId: "u1" };
    expect(scopeKey(s)).toBe("user:ag1:u1");
  });

  it("thread → thread:<agentId>:<sessionId>", () => {
    const s: Scope = { kind: "thread", agentId: "ag1", sessionId: "sess1" };
    expect(scopeKey(s)).toBe("thread:ag1:sess1");
  });

  it("org → org:<agentId>:<orgId>", () => {
    const s: Scope = { kind: "org", agentId: "ag1", orgId: "acme" };
    expect(scopeKey(s)).toBe("org:ag1:acme");
  });

  it("shared → shared:<blockId> (NOT agent-scoped)", () => {
    const s: Scope = { kind: "shared", blockId: "block-xyz" };
    expect(scopeKey(s)).toBe("shared:block-xyz");
  });

  it("two different agents resolve the SAME shared:<blockId> key (cross-agent sharing)", () => {
    const agent1: Scope = { kind: "shared", blockId: "shared-kb" };
    const agent2: Scope = { kind: "shared", blockId: "shared-kb" };
    // Both agents see the same key — this is the cross-agent property
    expect(scopeKey(agent1)).toBe(scopeKey(agent2));
    expect(scopeKey(agent1)).toBe("shared:shared-kb");
  });

  it("uses a versioned injective tuple when legacy delimiters would collide", () => {
    const left: Scope = { kind: "user", agentId: "tenant:alpha", userId: "u" };
    const right: Scope = { kind: "user", agentId: "tenant", userId: "alpha:u" };
    expect(scopeKey(left)).not.toBe(scopeKey(right));
    expect(scopeKey(left)).toBe('eidentic.scope.v2:["user","tenant:alpha","u"]');
    expect(scopeKey(right)).toBe('eidentic.scope.v2:["user","tenant","alpha:u"]');
  });
});
