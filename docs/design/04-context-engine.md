# 4. Context Engine

[← 3. Agent Loop](03-agent-loop.md) · [Index](master-design.md) · Next: [5. Tool System →](05-tool-system.md)

> Context engineering is *"effectively the #1 job of engineers building AI agents"*
> (Cognition). At Manus's production 100:1 input:output ratio, the context window — not
> model quality — is the primary cost and reliability driver. The Context Engine is a
> first-class core primitive (Constitution #4), not a prompt-building helper.

## 4.1 Responsibilities

The Context Engine owns *which tokens are in the window at every step, in what order, and
why*. It implements five operations:

1. **Select** — choose the high-signal tokens (memory blocks, recalled facts, recent events).
2. **Compress** — summarize without losing signal (compaction, tool-result condensing).
3. **Order** — most task-relevant tokens closest to the action; stable prefix first.
4. **Isolate** — sub-agents get clean, minimal windows (§8).
5. **Format** — structured, deterministic serialization to reduce ambiguity.

Goal: *"the smallest set of high-signal tokens that maximize the likelihood of the desired
outcome."*

## 4.2 Window layout (priority-ordered, cache-aware)

The window is assembled in a fixed order chosen to maximize KV-cache reuse — stable
content first, volatile content last:

```
┌─ STABLE PREFIX (cached) ─────────────────────────────────┐
│ 1. System identity & policy        (never changes)       │
│ 2. Tool manifest (schemas)         (changes rarely; masked, not removed) │
│ 3. Skill catalog (names+descs)     (progressive disclosure, §7) │
├─ SEMI-STABLE ────────────────────────────────────────────┤
│ 4. Memory blocks (core memory)     (self-edited; §6)      │
│ 5. Pinned context / project facts                         │
├─ VOLATILE (never cached) ────────────────────────────────┤
│ 6. Retrieved memory (multi-signal recall, this turn; §6)  │
│ 7. Recent event log (messages, tool results)             │
│ 8. Attention anchor (todo/plan recitation)               │
│ 9. Current user input                                     │
└──────────────────────────────────────────────────────────┘
```

## 4.3 KV-cache optimization (the 10× cost lever)

Manus's 10× cost reduction was *entirely* KV-cache optimization (cached tokens cost ~10%
of uncached on typical models). Rules enforced by the engine:

- **Append-only context.** Never mutate prior segments; any edit invalidates the cache from
  that point. New information is appended.
- **Stable, deterministic prefix.** No timestamps, no `Math.random()`, no per-request
  reordering in the cached region. Tool/skill order is deterministic.
- **Deterministic JSON serialization.** Stable key order for all serialized state.
- **Keep tools in the cached schema; reject at dispatch — don't remove them.** When a tool
  becomes unavailable mid-run, the engine leaves it in the cached manifest and the
  **permission/dispatch layer refuses invocation** (returns a `permission_denied` result to
  the model, §5.3/§10.4). Removing the tool would invalidate the cache and orphan prior
  `tool_use` references. *(Correction from review: portable per-tool **logit masking does not
  exist** across hosted providers — AI SDK exposes only `tool_choice` none/auto/required/
  specific, not a per-tool disable. Manus's "mask, don't remove" relied on controlling the
  inference stack; we achieve the same cache-preserving effect via dispatch-time rejection.)*
  Static per-agent tool filtering is set at session start (so it's part of the cached prefix);
  a mid-session permission-mode change (e.g. → `plan`) intentionally invalidates the cache
  from that point — accepted and rare. Sub-agents get their own fresh window/cache (§8.3).
- **Explicit cache breakpoints** where the provider supports prompt caching, placed at
  the stable/semi-stable boundary.

The engine exposes **KV-cache hit rate** as a primary metric in traces (§11) — Manus's
single most important production number.

## 4.4 Compaction (progressive, threshold-triggered)

Context rot is measurable: LLM accuracy can fall from 98% → 64% purely from how context is
filled; degradation accelerates past ~100k tokens regardless of advertised window size. The
engine compacts at **configurable pre-rot thresholds** (default budgets below the model's
true limit), in five progressive stages — cheapest first, only escalating as needed:

1. **Tool-result condensing** — per-tool-type summarization (test output → pass/fail+diff;
   large fetch → summary+pointer). Preserves the *pointer* (URL/path/id) so it stays reversible.
2. **Large-output offloading** — verbose results moved to the filesystem/store; a summary +
   handle stays in context (filesystem-as-memory, §4.5).
3. **Old-observation truncation** — FIFO eviction of stale low-signal events.
4. **Message coalescing** — merge consecutive same-role events.
5. **Episodic extraction** — compress a conversation span into learned facts handed to the
   memory engine (§6), then drop the raw span.

The **`onPreCompact` hook** fires first so the caller can archive the full transcript before
anything is dropped. Compaction is recorded as an event so the session log remains a
faithful audit trail.

**Anti-pattern avoided:** the observational-memory "death spiral" of feeding base64
image data into a summarizer. The engine type-checks payloads; binary/oversized tool
outputs are offloaded (stage 2), never fed to a summarizer.

## 4.5 Filesystem-as-memory (unlimited, reversible)

Following Manus (100:1 compression this way): the agent can read/write scratch files via
tools, and the engine offloads large content to a backing store (local FS in embedded
mode, object store in server mode) keyed by handle. **Compression always preserves the
pointer** — the agent can re-expand any offloaded item on demand. This is the bridge
between the ephemeral window and durable memory (§6).

## 4.6 Attention anchoring & failure evidence

- **Recitation anchor.** For long multi-step runs (~50 tool calls), the engine maintains a
  `todo`/plan summary re-emitted into the *recent* region each turn, pulling the global goal
  into the model's recency window — mitigating "lost-in-the-middle". Updated append-only.
- **Preserve failure evidence.** Errors and failed attempts are *kept* in context (within
  budget), not scrubbed: *"erasing failure removes the evidence the model needs to adapt."*
  Compaction condenses but does not delete the *fact* of a failure.
- **Break few-shot collapse.** For repetitive tasks, the engine introduces controlled
  structural variation in serialization to prevent rigid pattern mimicry/drift.

## 4.7 Context budget guidance (defaults)

| Window fill | Strategy |
|-------------|----------|
| < 10k tokens | append-only, no compaction |
| 10k–50k | enable stage 1–2 compaction |
| 50k–100k | add offloading + smart retrieval (lean on §6 recall, not raw history) |
| > 100k (pre-rot) | prefer sub-agent isolation (§8); single window discouraged |

Defaults are conservative (pre-rot threshold typically < 256k even on large-window models)
and per-agent tunable.

## 4.8 API sketch

```ts
interface ContextEngine {
  assemble(input: {
    agent: AgentConfig; session: Session; memory: RetrievedMemory; toolManifest: ToolSchema[]
  }): AssembledWindow            // { messages, cacheBreakpoints, toolChoiceMask, estTokens }

  shouldCompact(window: AssembledWindow, model: ModelInfo): boolean
  compact(session: Session, plan: CompactionPlan): Promise<CompactionResult>  // fires onPreCompact
  offload(content: unknown): Promise<Handle>     // filesystem-as-memory
  expand(handle: Handle): Promise<unknown>
}
```

Token estimation uses a fast heuristic (~4 chars/token) for budgeting, refined by the
provider's reported usage after each call.

## 4.9 Traceability

- Context rot, lost-in-the-middle → §4.2 ordering, §4.4 pre-rot compaction, §4.6 anchoring.
- Hidden-cost & death-spiral memory → §4.3 transparency + §4.4 type-checked offloading.
- $-blowups → §4.3 KV-cache hit-rate as a first-class lever and metric.
