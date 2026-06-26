# 1. Vision & Principles

[← Index](master-design.md) · Next: [2. Architecture Overview →](02-architecture-overview.md)

## 1.1 One-line vision

Eidentic is the SDK a developer embeds in their own product to give it agents that
**remember, learn, and act reliably in production** — without adopting a whole
platform, without lock-in, and without the breakage and hidden costs that plague
today's frameworks.

## 1.2 Problem statement (grounded)

The June-2026 landscape research surfaced a consistent, sourced picture:

- **88–95% of agent pilots never reach production** — the blocker is architecture,
  not model quality (compounding step-failure: a 95%/step agent ≈ 60% on a 10-step task).
- **The fundamentals are everyone's afterthought.** Durable execution, observability,
  cost control, and security are bolted on late — and that is precisely what kills
  frameworks. ($47K and $500M runaway-cost incidents; 27% of prod failures = "no
  observability"; 98% of agents structurally exploitable by the "lethal trifecta".)
- **Lock-in & churn are the loudest complaints.** Existing frameworks are criticized for being *"not a
  memory layer — the stack itself"*; others ship breaking changes nearly weekly and
  hide background LLM costs; self-evolution loops don't actually persist
  mutations and target end-user assistants, not SDKs.
- **Memory that genuinely improves over time is unsolved in TypeScript.** The strong
  ideas (self-editing memory blocks, sleep-time consolidation, temporal knowledge
  graphs, per-skill episodic memory) exist only in Python research/products or not at all.

Eidentic's thesis: **win on production-grade fundamentals + best-in-class
self-improving memory and skills, delivered as composable, stable, OSI-licensed
TypeScript packages.**

## 1.3 Target user & primary use cases

- **Primary user:** a developer/team embedding agents into their own product, website,
  or backend — *not* an end-user assistant product.
- **Primary use cases:**
  - A product feature powered by a stateful agent that remembers users across sessions
    and gets better over time (support, research, ops copilots, vertical assistants).
  - Coding/dev-tool agents that need a production-grade harness as an embeddable library.
  - Multi-agent pipelines (research/analysis fan-out, supervisor/worker) that must be
    cost-bounded, observable, and crash-safe.
- **Deployment shapes (hybrid):** runs embedded in the developer's own process with
  zero infra (libSQL/SQLite on local disk) for dev and small scale; the same primitives
  flip to "server mode" (Postgres + REST API, agents-as-a-service) for production scale.

## 1.4 Positioning

> **Eidentic is a TS-first, batteries-included agent SDK done as composable libraries with
> production fundamentals built in.**

- **Memory-as-a-drop-in:** the full depth of self-improving memory as a **drop-in layer**
  (usable without adopting our runtime), with concurrency-safe memory, published
  benchmarks, and hardened sandboxing from day one.
- **API stability:** no breaking changes in minor releases, transparent cost accounting,
  true serverless-friendliness, and a pure OSI license.
- **Self-developing skills:** skills that actually persist and are test-gated, with
  security/provenance built into the skill lifecycle.

## 1.5 The Design Constitution (non-negotiable principles)

These bind every subsystem. [Section 14](14-traceability-matrix.md) traces each back to
the production gap it answers.

1. **Composable, no lock-in.** Every layer (memory, loop, skills, durable) is usable
   standalone and pluggable into other frameworks. We are never "the whole stack."
2. **Stable API + semver.** No breaking changes in minor; codemods for major. Churn
   kills trust.
3. **Production fundamentals are architectural from day one** — never bolt-on: durable
   checkpoint/resume, OTel tracing, hard cost/iteration caps, deny-by-default permissions.
4. **Context engineering is a core primitive** — KV-cache-aware stable prefixes,
   append-only, compaction at configurable pre-rot thresholds, filesystem-as-memory,
   preserve failure evidence.
5. **Transparent cost.** Every LLM call (including background/memory calls) is visible in
   token accounting. No hidden calls.
6. **Grounded verification.** No same-model self-critique for correctness; external /
   execution-based verification with critic-role separation.
7. **Security = assume-breach.** Sealed tool endpoints, credential isolation, egress
   allowlisting, human-gates for irreversible actions, sandboxed code, signed-skill provenance.
8. **Eval is first-class.** Trajectory-level scoring + a built-in "turn every failure
   into a regression test" operation.
9. **Memory that actually works.** Multi-signal retrieval (semantic + BM25 + entity),
   async writes, temporal validity, staleness TTL, and a published benchmark harness.
10. **OSI license (Apache-2.0).** No procurement friction, no dual-license surprises.

## 1.6 Non-goals (YAGNI)

- **Not** an end-user assistant app, chat UI, or hosted product (at least not in the SDK core).
- **Not** a model provider or a gateway/proxy — we build on AI SDK v7 for provider access.
- **Not** a no-code/visual workflow builder.
- **No** bespoke vector database, durable-execution engine, or sandbox runtime — we
  define clean adapter interfaces and ship sane defaults, not reinvented infra.
- **No** RL training loop in core. Skill/memory self-improvement uses prompt/trace-level
  optimization, not weight training (a trainable controller may come later, behind an interface).
- **No** Python SDK in the first phase (designed-for later, not built first).

## 1.7 Success criteria

- A developer can build a stateful, memory-backed agent in <30 lines and <5 minutes,
  with zero external infra — using `memory: 'lite'` (blocks + lexical recall; no embedding/
  rerank/consolidation service required). The flagship `memory: 'full'` is one opt-in away.
- The same agent runs crash-safe, traced (OTel), and cost-capped without extra wiring.
- The memory layer can be dropped into a non-Eidentic agent loop with one adapter.
- Published memory benchmark numbers (LongMemEval / LoCoMo) shipped with the repo.
- No breaking change lands in a minor release across the entire 1.x line.
