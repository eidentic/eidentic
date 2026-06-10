# 8. Multi-Agent

[← 7. Skill System](07-skill-system.md) · [Index](master-design.md) · Next: [9. Durable Execution →](09-durable-execution.md)

Multi-agent is powerful and overhyped in equal measure (Gartner: >40% of agentic projects
canceled by 2027; multi-agent burns ~15× chat tokens). Eidentic's design encodes the
*settled* lesson from the June-2025 Cognition-vs-Anthropic debate rather than picking a side.

## 8.1 The settled rule

Despite opposing blog titles, both camps agree on the actual decision rule:

| Task shape | Architecture | Why |
|------------|-------------|-----|
| Deep, sequential, state-dependent (coding, writing) | **Single agent** | context continuity; no coordination overhead |
| Broad, parallelizable, read-heavy (research, analysis) | **Multi-agent** | each sub-agent gets a clean context window (Anthropic: +90% on breadth-first research) |
| Write-heavy parallelization (co-editing shared artifact) | **Avoid multi-agent** | conflicting writes; Cognition's "Flappy Bird" failure |

Eidentic makes single-agent the default and multi-agent an explicit, justified choice — with
the cost surfaced. We never market "more agents = better."

## 8.2 Agent-as-Tool (the primary pattern)

Rather than agents conversing as peers (expensive, brittle), a sub-agent is invoked as a
**deterministic function that returns structured output** — a MapReduce shape:

```ts
const planner = subAgent({
  id: 'planner', model: 'opus',
  instructions: '…', tools: { search },
  output: z.object({ steps: z.array(z.string()) }),   // typed return; no parsing
})

// In the parent, this appears as a tool `spawn_agent(planner, input)`:
const { steps } = await ctx.spawn(planner, { goal })
```

The parent calls `spawn_agent`; the result is validated structured data, immediately usable.
This keeps the harness modular and avoids conversational parsing overhead.

## 8.3 Context isolation (the core safety property)

A sub-agent starts with a **fresh, minimal context window**. The *only* channel from parent
to child is the invocation input (a prompt/struct) — never the parent's full history. The
child receives: its own instructions, the invocation input, its tool/skill manifest, and
project memory (if scoped in). It does **not** inherit the parent's conversation, system
prompt, or unrelated context.

This is the scaling mechanism: each sub-agent runs a focused budget, so a fan-out can cover
breadth that no single window could hold. *"Share memory by communicating, don't communicate
by sharing memory."* Shared context is treated as an expensive, cache-breaking dependency and
passed explicitly only when genuinely needed.

- **Depth limit:** sub-agents cannot spawn sub-sub-agents by default (`maxDepth = 1`) —
  prevents runaway orchestration (a standard orchestration safeguard). For 100+ agent fan-outs a
  dedicated pipeline/workflow construct is used, not recursive spawning.
- **Isolation via schema, not runtime checks:** a sub-agent's restricted tools are *absent
  from its schema*, not merely blocked — it cannot attempt what it cannot see (the plan-mode
  pattern from §3/§10).

## 8.4 Coordination via shared memory blocks

When agents *do* need shared state (supervisor + workers on a common task), they attach the
same **shared-scope memory block** (§6.7, `{kind:'shared', blockId}`). Updates are visible to
all attached agents, and the CAS concurrency model (§6.3) prevents the last-writer-wins data
loss that can plague shared memory. This is simpler than message-passing for many
coordination problems and is the recommended default for supervisor/worker sharing.

## 8.5 Canonical patterns (as compositions, not new primitives)

All are built from `spawn_agent` + shared blocks + the loop strategies (§3.6):

- **Supervisor/Worker** — a coordinator spawns specialized workers (typed outputs), optionally
  sharing a guidelines block. Tag-based selection for worker pools.
- **Parallel fan-out / gather** — N workers run concurrently on partitioned input; the parent
  reduces typed results. The classic "breadth-first research" win.
- **Producer/Reviewer** — pairs with the reflection strategy (§3.6); reviewer is a *different*
  model (grounded critique, Constitution #6).
- **Hierarchical teams** — bounded by `maxDepth`; deeper structures use explicit pipelines.

## 8.6 Cost & accounting

Multi-agent's ~15× token cost is only worth it when work genuinely can't be serialized. The
cost governor (§11) aggregates child costs into the parent run, and every sub-agent's
usage/cost is a labeled child span (§11) — so "running six agents costs $2–3/query" is
*visible and capped*, not a surprise. A multi-agent run shares one cost budget across the
tree; exceeding it aborts the whole tree.

## 8.7 Stable primitive (no coordination-primitive churn)

Shipping a coordination primitive then deprecating it within a year breaks trust. Eidentic
ships exactly one coordination primitive (`spawn_agent` + shared blocks + strategies) and
commits to its stability. There is no separate "network" abstraction to later regret;
orchestration richness comes from composition, not from a heavyweight construct.

## 8.8 API sketch

```ts
const supervisor = new Agent({
  id: 'research-lead', model: 'opus',
  instructions: 'Coordinate parallel research; synthesize a cited report.',
  subAgents: { searcher, reader, factChecker },     // become spawn_agent targets
  policy: { maxCostUsd: 2.0, maxDepth: 1 },          // whole-tree budget
})
// supervisor decides to fan out:  spawn_agent(searcher, …) ×N  → gather → spawn_agent(factChecker,…)
```

## 8.9 Traceability

- Cognition "Flappy Bird" isolation failure → §8.3 explicit, minimal handoff.
- Multi-agent cost blowups → §8.6 shared-tree budget + per-child cost spans.
- Shared-memory data loss → §8.4 CAS shared blocks.
- Coordination-primitive deprecation → §8.7 one stable composable primitive.
