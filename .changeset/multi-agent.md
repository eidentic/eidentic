---
"@eidentic/types": minor
"@eidentic/core": minor
---

Add **multi-agent** support (§8): the single coordination primitive `spawn_agent` (agent-as-tool, MapReduce shape).

Configure a parent with `new Agent({ subAgents: { name: { agent, description, outputSchema? } }, maxDepth?, policy })`. Per query the parent receives one synthesized `spawn_agent` tool whose `agent` enum lists the registered sub-agents. Calling it runs the chosen sub-agent's own `Agent.query` in a **fresh, isolated context window** — only the invocation `input` crosses the boundary, never the parent's instructions or history (§8.3). An optional `outputSchema` validates the child's final text into typed structured data (the child's text is `JSON.parse`d and Zod-validated; parse/validate failures return a clear tool error).

Isolation and depth are enforced **via schema, not runtime checks** (§8.3): `spawn_agent` is present only when `subAgents` is non-empty AND the current spawn depth is below `maxDepth` (default 1), so a sub-agent at the depth limit structurally cannot spawn sub-sub-agents — the model never sees the tool.

Cost is governed across the **whole tree** under one budget (§8.6): every sub-agent's usage/USD folds into a shared accumulator; the cost-governor preflight (Plan 9b) weighs tree spend against `policy.maxCostUsd`/`maxTokens` and aborts the whole tree when exceeded, and `spawn_agent` refuses to launch a sub-agent that would exceed budget. The parent's terminal `CostBreakdown` gains a transparent `children?: Usage` field summing all delegated work.

Shared-scope memory blocks (`{kind:"shared"}`, CAS) from prior plans are reused for supervisor/worker coordination — no new abstraction. There is no separate "network" construct (§8.7): orchestration richness comes from composition.

Deferred to later plans: a dedicated 100+ fan-out pipeline/workflow construct, the full loop-strategy library (reflection / plan-execute, §3.6), tag-based worker pools, and deep hierarchical-team auto-orchestration.
