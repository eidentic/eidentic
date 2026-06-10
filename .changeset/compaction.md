---
"@eidentic/types": minor
"@eidentic/core": minor
---

Add **context-engine compaction** (§4.4) — progressive, token-budget-triggered compaction of the in-context message window.

The loop previously replayed the full event log into the model window every turn, growing it unbounded (context rot + runaway cost). With `compaction` configured, `runLoop` now estimates the window before each model call (`estimateTokens`, a ~4-chars/token heuristic, §4.8) and, past `maxContextTokens`, compacts it through three progressive stages — **(1) tool-result condensing** (oversized results sliced head/tail with the pointer preserved; binary/base64 truncated-with-note, never summarized — the §4.4 anti-pattern), **(3) old-observation FIFO truncation**, and **(4) consecutive same-role coalescing** — cheapest first, stopping once under budget. The **system prefix, the recent window (`keepRecentTurns`), user turns, and all failure evidence (§4.6) are never dropped.** An `onPreCompact` hook fires first so callers can archive the full transcript. Each compaction appends a `compaction` audit event and emits a `compaction` StreamEvent (`before`/`after`/`stages`).

Compaction operates ONLY on the in-memory window — the persisted event log is never mutated and stays the faithful audit trail; resume rebuilds from the full log and re-compacts (replayed `compaction` events are ignored). Compaction intentionally invalidates the KV cache from that point — accepted and rare (§4.3). With no `compaction` config the loop is byte-for-byte unchanged. Configure via `new Agent({ compaction: { maxContextTokens, keepRecentTurns, toolResultMaxChars }, onPreCompact })`.

Deferred to later plans: **large-output offloading + `expand`** (§4.4 stage 2 / §4.5 filesystem-as-memory), **episodic extraction to memory** (§4.4 stage 5, ties to the Consolidator §6), the **recitation / attention anchor** (§4.6 todo re-emission), **explicit provider cache breakpoints** (§4.3), and **few-shot-collapse structural variation** (§4.6).
