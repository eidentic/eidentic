# Eidentic — Master Design Document (Index)

> An open-source, TypeScript-first SDK for building production agentic AI systems:
> composable agents, self-improving memory, self-developing skills, and multi-agent
> orchestration — with production fundamentals (durability, observability, cost
> control, security) architected in from day one.

**Status:** Draft (in progress) · **Date:** 2026-06-05 · **Owner:** Baran

This is the authoritative architecture spec. Each section lives in its own file and is
written in full detail. The v1 scope is sliced only after this document is complete.

## Sections

| # | Section | File |
|---|---------|------|
| 0 | **Finalized Decisions Log (ADR)** — tech stack, resolved open questions, review fixes, v1 scope | [00-decisions.md](00-decisions.md) |
| 1 | Vision & Principles | [01-vision-principles.md](01-vision-principles.md) |
| 2 | Architecture Overview | [02-architecture-overview.md](02-architecture-overview.md) |
| 3 | Core: Agent Loop | [03-agent-loop.md](03-agent-loop.md) |
| 4 | Context Engine | [04-context-engine.md](04-context-engine.md) |
| 5 | Tool System | [05-tool-system.md](05-tool-system.md) |
| 6 | Self-Improving Memory Engine | [06-memory-engine.md](06-memory-engine.md) |
| 7 | Skill System | [07-skill-system.md](07-skill-system.md) |
| 8 | Multi-Agent | [08-multi-agent.md](08-multi-agent.md) |
| 9 | Durable Execution | [09-durable-execution.md](09-durable-execution.md) |
| 10 | Security & Sandbox | [10-security-sandbox.md](10-security-sandbox.md) |
| 11 | Observability + Cost Governor + Eval | [11-observability-cost-eval.md](11-observability-cost-eval.md) |
| 12 | Persistence & Data Model | [12-persistence-data-model.md](12-persistence-data-model.md) |
| 13 | Packaging & DX | [13-packaging-dx.md](13-packaging-dx.md) |
| 14 | Traceability Matrix | [14-traceability-matrix.md](14-traceability-matrix.md) |
| 15 | Data Governance, PII, Retention & Erasure | [15-data-governance.md](15-data-governance.md) |
| 16 | Concurrency, Cancellation & Backpressure | [16-concurrency-cancellation.md](16-concurrency-cancellation.md) |
| 17 | Error Taxonomy & Recovery | [17-error-taxonomy.md](17-error-taxonomy.md) |
| 18 | SDK Testing & Adapter Conformance | [18-testing-conformance.md](18-testing-conformance.md) |
| 19 | Schema & Prompt Evolution | [19-schema-prompt-evolution.md](19-schema-prompt-evolution.md) |
| 20 | Secrets, Rate Limiting & Quotas | [20-secrets-rate-limiting.md](20-secrets-rate-limiting.md) |
| 21 | Security Boundary Migrations | [21-security-boundary-migrations.md](21-security-boundary-migrations.md) |

## Reading order

**Start with [Section 0](00-decisions.md)** — it records every finalized decision, the
verified 2026 tech stack, and the v1 scope. Sections 1–2 give the whole picture. Sections
3–5 are the runtime core. Sections 6–8 are the differentiators (memory, skills, multi-agent).
Sections 9–11 are the production fundamentals. Sections 12–13 are the substrate (data,
packaging). Section 14 ties every design choice to a sourced gap. Sections 15–21 are the
production-hardening concerns surfaced by adversarial review (governance, concurrency,
errors, testing, evolution, secrets/limits, and compatibility-safe security migrations).

## Status

All 22 sections (0–21) written and reconciled against two rounds of June-2026 deep research
plus an adversarial design review. Decisions are **finalized** (see Section 0). v1 scope is
sliced (Section 0, part E).

## Companion research

The design is grounded in five deep-research reports (June 2026) on existing frameworks,
infra primitives, and the developer pain-point survey.
Key citations appear inline in each section.
