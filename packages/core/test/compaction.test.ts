import { describe, it, expect } from "vitest";
import { estimateTokens, compactMessages, type CompactionConfig } from "../src/compaction.js";
import { textBlock, toolUseBlock, type ModelMessage } from "@eidentic/types";

// Helper: assistant turn that carries tool_use blocks (a "paired" assistant message).
const asstTool = (callId: string, name: string): ModelMessage => ({
  role: "assistant",
  content: [toolUseBlock(callId, name, {})],
});

const sys = (s: string): ModelMessage => ({ role: "system", content: s });
const user = (s: string): ModelMessage => ({ role: "user", content: s });
const asst = (s: string): ModelMessage => ({ role: "assistant", content: [textBlock(s)] });
const tool = (callId: string, name: string, output: unknown): ModelMessage => ({
  role: "tool",
  callId,
  toolName: name,
  content: JSON.stringify(output),
});

describe("estimateTokens", () => {
  it("is ~ceil(chars/4) over serialized content and deterministic", () => {
    const msgs = [sys("abcd"), user("efgh")]; // 8 chars → 2 tokens
    expect(estimateTokens(msgs)).toBe(2);
    expect(estimateTokens(msgs)).toBe(estimateTokens(msgs.slice()));
  });
  it("counts tool_use name+input and text blocks", () => {
    const msgs = [asst("hi"), { role: "assistant", content: [toolUseBlock("c1", "fetch", { url: "x" })] } as ModelMessage];
    expect(estimateTokens(msgs)).toBeGreaterThan(0);
  });
});

describe("compactMessages — Stage 1 tool-result condensing", () => {
  const cfg: CompactionConfig = { maxContextTokens: 1_000_000, toolResultMaxChars: 100, keepRecentTurns: 6 };

  it("condenses a huge tool result and preserves its pointer (id/url/path)", () => {
    const big = "y".repeat(5_000);
    const msgs = [sys("S"), tool("c1", "fetch", { url: "https://example.com/doc", body: big })];
    const r = compactMessages(msgs, cfg);
    expect(r.stages).toContain("tool-result-condense");
    const condensed = r.messages[1]!.content as string;
    expect(condensed).toContain("https://example.com/doc"); // pointer preserved
    expect(condensed).toContain("…[condensed");
    expect(condensed.length).toBeLessThan(big.length);
  });

  it("leaves small tool results untouched (no stage applied → not compacted)", () => {
    const msgs = [sys("S"), tool("c1", "ok", { ok: true })];
    const r = compactMessages(msgs, cfg);
    expect(r.compacted).toBe(false);
    expect(r.stages).toEqual([]);
    expect(r.messages).toEqual(msgs);
  });

  it("truncates a base64 blob with a note instead of summarizing it (§4.4 anti-pattern)", () => {
    const blob = "data:image/png;base64," + "A".repeat(4_000);
    const msgs = [sys("S"), tool("c1", "screenshot", blob)]; // note: raw string output
    const r = compactMessages(msgs, { ...cfg, toolResultMaxChars: 50 });
    const out = r.messages[1]!.content as string;
    expect(out).toContain("binary/base64 omitted");
    expect(out).not.toContain("A".repeat(100)); // blob body dropped, not condensed-with-body
  });
});

describe("compactMessages — Stage 3 FIFO truncation + §4.6 failure preservation", () => {
  it("drops OLD low-signal observations but KEEPS the system prefix, recent window, user turns, and failure evidence", () => {
    const filler = "z".repeat(4_000); // each ~1000 tokens
    const msgs: ModelMessage[] = [
      sys("SYSTEM-PREFIX"),
      user("do it"),
      asst("ok working"),
      tool("c1", "read", { path: "/a", body: filler }),        // old low-signal → droppable
      tool("c2", "run", { isError: true, error: "boom failed" }), // FAILURE → must survive
      tool("c3", "read", { path: "/b", body: filler }),        // old low-signal → droppable
      asst("chatter " + filler),                                // old assistant chatter → droppable
      // recent window (keepRecentTurns=3): the last 3 non-system messages are protected
      tool("c4", "read", { path: "/c", body: filler }),
      asst("recent thought"),
      user("anything else?"),
    ];
    const r = compactMessages(msgs, { maxContextTokens: 2_000, keepRecentTurns: 3, toolResultMaxChars: 1_000_000 });
    expect(r.stages).toContain("fifo-truncate");
    const serialized = r.messages.map((m) => JSON.stringify(m));
    // system prefix preserved
    expect(serialized.some((s) => s.includes("SYSTEM-PREFIX"))).toBe(true);
    // failure evidence preserved (§4.6)
    expect(serialized.some((s) => s.includes("boom failed"))).toBe(true);
    // user turns preserved
    expect(serialized.some((s) => s.includes("do it"))).toBe(true);
    expect(serialized.some((s) => s.includes("anything else?"))).toBe(true);
    // recent window preserved
    expect(serialized.some((s) => s.includes("recent thought"))).toBe(true);
    // at least one old low-signal observation was dropped
    expect(r.messages.length).toBeLessThan(msgs.length);
    // got under (or as close as protections allow to) budget
    expect(r.after).toBeLessThanOrEqual(r.before);
  });

  it("never drops the system prefix even if it alone is large", () => {
    const msgs: ModelMessage[] = [sys("S".repeat(40_000)), tool("c1", "x", { body: "y".repeat(40_000) })];
    const r = compactMessages(msgs, { maxContextTokens: 1, keepRecentTurns: 0, toolResultMaxChars: 1_000_000 });
    expect((r.messages[0]!.content as string).startsWith("S")).toBe(true);
  });
});

describe("compactMessages — Stage 4 coalescing", () => {
  it("does NOT merge consecutive tool messages that carry distinct callIds (pairing must be preserved)", () => {
    // c1 and c2 have distinct callIds → they must NOT be coalesced (each must stay paired with its tool_use).
    const msgs: ModelMessage[] = [
      sys("S"),
      tool("c1", "a", { v: 1 }),
      tool("c2", "b", { v: 2 }),
      asst("between"),
      tool("c3", "c", { v: 3 }),
    ];
    const r = compactMessages(msgs, { maxContextTokens: 1_000_000, keepRecentTurns: 100, toolResultMaxChars: 1_000_000 });
    // No stage should fire (nothing to do, all within budget, no callId-less adjacent tools).
    expect(r.stages).not.toContain("coalesce");
    // All three tool messages survive as distinct entries.
    const toolCount = r.messages.filter((m) => m.role === "tool").length;
    expect(toolCount).toBe(3);
  });

  it("merges consecutive same-role tool messages that carry NO callId (legacy/degenerate)", () => {
    // Messages without a callId have no pairing relationship, so coalescing is safe.
    const noCallId1: ModelMessage = { role: "tool", content: "output-A" };
    const noCallId2: ModelMessage = { role: "tool", content: "output-B" };
    const msgs: ModelMessage[] = [sys("S"), noCallId1, noCallId2];
    const r = compactMessages(msgs, { maxContextTokens: 0, keepRecentTurns: 100, toolResultMaxChars: 1_000_000 });
    expect(r.stages).toContain("coalesce");
    const toolCount = r.messages.filter((m) => m.role === "tool").length;
    expect(toolCount).toBe(1); // the two no-callId messages merge into one
  });
});

describe("compactMessages — purity & determinism", () => {
  it("does not mutate its input and is deterministic", () => {
    const msgs: ModelMessage[] = [sys("S"), tool("c1", "x", { body: "y".repeat(5_000) })];
    const snapshot = JSON.parse(JSON.stringify(msgs));
    const a = compactMessages(msgs, { maxContextTokens: 1, toolResultMaxChars: 100, keepRecentTurns: 1 });
    const b = compactMessages(msgs, { maxContextTokens: 1, toolResultMaxChars: 100, keepRecentTurns: 1 });
    expect(msgs).toEqual(snapshot);            // input untouched
    expect(a.messages).toEqual(b.messages);    // deterministic
    expect(a.stages).toEqual(b.stages);
  });

  it("reports before/after token counts and compacted=false when nothing to do", () => {
    const msgs: ModelMessage[] = [sys("S"), user("hi")];
    const r = compactMessages(msgs, { maxContextTokens: 1_000_000 });
    expect(r.compacted).toBe(false);
    expect(r.before).toBe(r.after);
  });
});

/**
 * Pairing invariant helper: verifies that every surviving role:"tool" message has a matching
 * assistant tool_use in the output, and no surviving assistant tool_use is unmatched.
 */
function assertPairingInvariant(msgs: ModelMessage[]): void {
  // Collect all tool_use callIds from assistant messages.
  const asstCallIds = new Set<string>();
  for (const m of msgs) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === "tool_use") asstCallIds.add(b.callId);
      }
    }
  }
  // Collect all callIds from role:"tool" messages.
  const toolCallIds = new Set<string>();
  for (const m of msgs) {
    if (m.role === "tool" && m.callId) toolCallIds.add(m.callId);
  }
  // Every tool result must have a matching assistant tool_use.
  for (const cid of toolCallIds) {
    expect(asstCallIds.has(cid), `role:"tool" callId=${cid} is orphaned (no matching assistant tool_use)`).toBe(true);
  }
  // Every assistant tool_use must have a matching tool result.
  for (const cid of asstCallIds) {
    expect(toolCallIds.has(cid), `assistant tool_use callId=${cid} has no matching role:"tool" result`).toBe(true);
  }
}

describe("compactMessages — tool_use/tool_result pairing invariant (no orphans)", () => {
  // Reviewer's exact scenario:
  // [system, user, asst(tool_use c1), tool(c1: {error}), asst(tool_use c2), tool(c2: big), asst(recent text), user]
  // with a tiny budget → failure-preserved c1 pair stays, pairing invariant holds in both directions.
  it("reviewer scenario: failure-preserved tool result keeps its paired assistant tool_use (no orphan)", () => {
    const big = "x".repeat(4_000); // ~1000 tokens
    const msgs: ModelMessage[] = [
      sys("SYSTEM"),
      user("start"),
      asstTool("c1", "risky"),                                      // issues tool_use c1
      tool("c1", "risky", { isError: true, error: "boom" }),        // failure → §4.6 protected
      asstTool("c2", "fetch"),                                      // issues tool_use c2
      tool("c2", "fetch", { path: "/big", body: big }),             // big but old → droppable without pairing fix
      asst("recent text reply"),                                    // recent
      user("done?"),                                                // recent
    ];
    // Tiny budget: only the recent window + system would fit without the fix.
    const r = compactMessages(msgs, { maxContextTokens: 500, keepRecentTurns: 2, toolResultMaxChars: 1_000_000 });
    // Pairing invariant must hold in BOTH directions — no orphaned results or tool_uses.
    assertPairingInvariant(r.messages);
    // The failure evidence must still be present (§4.6).
    const serialized = r.messages.map((m) => JSON.stringify(m));
    expect(serialized.some((s) => s.includes("boom"))).toBe(true);
  });

  it("pairing invariant holds when ONLY the tool result is in the recent window (assistant turn is older)", () => {
    const filler = "y".repeat(4_000);
    const msgs: ModelMessage[] = [
      sys("S"),
      user("go"),
      asstTool("c1", "do"),                         // older assistant tool_use
      tool("c1", "do", { result: filler }),          // its result is in the recent window
      user("reply"),                                 // recent
    ];
    // keepRecentTurns=2 covers: tool(c1) and user("reply"). The assistant is older.
    // Without the fix, the assistant would be dropped while tool(c1) is kept → orphan.
    const r = compactMessages(msgs, { maxContextTokens: 100, keepRecentTurns: 2, toolResultMaxChars: 1_000_000 });
    assertPairingInvariant(r.messages);
  });

  it("pairing invariant holds after Stage 4 — two adjacent tool results with distinct callIds are NOT merged", () => {
    const msgs: ModelMessage[] = [
      sys("S"),
      asstTool("c1", "a"),
      tool("c1", "a", { v: 1 }),
      asstTool("c2", "b"),                          // note: separate assistant message for c2
      tool("c2", "b", { v: 2 }),
      user("done"),
    ];
    // Force Stage 4 to be considered (budget=0 → everything checked).
    // Stage 3 with keepRecentTurns=10 protects everything; Stage 4 should not merge c1+c2 results.
    const r = compactMessages(msgs, { maxContextTokens: 0, keepRecentTurns: 10, toolResultMaxChars: 1_000_000 });
    assertPairingInvariant(r.messages);
    // The two tool results must remain as SEPARATE messages (distinct callIds, not merged).
    const toolMsgs = r.messages.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(2);
    expect(toolMsgs[0]!.callId).toBe("c1");
    expect(toolMsgs[1]!.callId).toBe("c2");
  });

  it("pair where ASSISTANT is in recent window but result is older: both kept together", () => {
    const filler = "z".repeat(4_000);
    const msgs: ModelMessage[] = [
      sys("S"),
      user("begin"),
      asstTool("c1", "fetch"),                      // in recent window
      tool("c1", "fetch", { body: filler }),         // older, big — without fix it could be dropped alone
      user("next"),
    ];
    // keepRecentTurns=2 covers: asstTool(c1) and user("next"). tool(c1) is older.
    // Without the fix, tool(c1) could be dropped while asst is kept → orphan in reverse direction.
    const r = compactMessages(msgs, { maxContextTokens: 100, keepRecentTurns: 2, toolResultMaxChars: 1_000_000 });
    assertPairingInvariant(r.messages);
  });
});
