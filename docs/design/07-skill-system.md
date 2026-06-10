# 7. Skill System

[← 6. Memory Engine](06-memory-engine.md) · [Index](master-design.md) · Next: [8. Multi-Agent →](08-multi-agent.md)

Skills are reusable, discoverable capabilities an agent can *use, develop, and improve*.
Eidentic unifies two skill kinds under one model: **interop skills** (agentskills.io
`SKILL.md`, for ecosystem compatibility) and **executable skills** (test-gated code, for
genuine self-evolution) — each with its **own per-skill memory** (the untapped 2026 idea)
and **provenance/security** built into the lifecycle (the gap that blocks all self-evolving
agents from enterprise use).

## 7.1 Two kinds, one model

| | Interop skill (`SKILL.md`) | Executable skill (code) |
|---|---|---|
| Form | Markdown instructions + optional `scripts/`,`references/`,`assets/` | Typed function/tool implementation |
| Authored by | human or agent | agent (or human) |
| Runs | guides the model; bundled scripts run deterministically | sandboxed execution (§10) |
| Interop | works in compatible agent tools (agentskills.io format) | Eidentic-native (exportable) |
| Self-evolution | description/instruction refinement | code + tests evolve, test-gated |

Both share: a manifest, progressive disclosure, per-skill memory, versioning, provenance,
and the same discovery/invocation API. A skill can be *both* (a `SKILL.md` whose `scripts/`
include test-gated executable helpers).

## 7.2 Format (agentskills.io-compatible)

```
my-skill/
  SKILL.md            # required
  scripts/            # optional executable helpers (deterministic, sandboxed)
  references/         # optional docs loaded on demand
  assets/             # optional templates
  .memory.md          # Eidentic extension: per-skill episodic memory (§7.5)
  skill.lock          # Eidentic extension: provenance + test-gate record (§7.6)
```

`SKILL.md` frontmatter follows the open standard (so our skills run elsewhere and theirs
run here):

```yaml
---
name: db-migration          # ≤64 chars, kebab-case
description: |              # ≤1024 chars — THE trigger signal
  Use when generating database migrations from a schema change...
allowed-tools: [bash, read, write]   # optional capability scope (§7.6)
---
# Instructions (markdown body, recommended <5k tokens)
```

## 7.3 Progressive disclosure (3-tier loading)

The Anthropic-proven loading model, which keeps 100 skills at ~5k tokens of startup cost:

1. **Tier 1 (always):** `name` + `description` for every installed skill (~100 tokens each)
   in the skill catalog (stable region of the window, §4.2).
2. **Tier 2 (on relevance):** the model reads the full `SKILL.md` body when it judges the
   skill relevant (via `skill_use`).
3. **Tier 3 (on need):** bundled `references/`/`scripts/` are read/run only for the specific
   subtask.

Skills not relevant to the current task consume zero context.

## 7.4 Lifecycle (five stages)

Executable skills are long-lived assets, not disposable snippets (research shows a
generated skill costs ~383k tokens once but saves ~122k tokens *per use*):

```
create → evaluate → register → maintain(refine|merge|prune) → use
```

1. **Create.** The agent authors a skill (code + auto-generated unit tests + `SKILL.md`).
2. **Evaluate.** Tests run in the sandbox. **A skill only registers if all tests pass.**
   Failures trigger a bounded `refine` loop.
3. **Register.** Added to the Skill Bank with a version + provenance record.
4. **Maintain.** Consolidation (§6.5) refines (from `.memory.md` lessons), merges
   near-duplicate skills, and prunes unused/low-value ones.
5. **Use.** Discovered and invoked (§7.7); usage logs feed `.memory.md`.

## 7.5 Per-skill memory (the differentiator)

Each skill carries `.memory.md` — its own episodic notes accumulated across uses (edge
cases, failure modes, gotchas, parameter tips). No shipping framework has per-skill
episodic accumulation; it makes a skill *get better at being itself*. On `skill_use`, the
relevant slice of `.memory.md` is loaded (Tier 3). After use, outcomes append to it;
consolidation periodically distills it (and rolls lessons up to refine the skill code/instructions).

This binds the two differentiators: skills are where **procedural** memory lives, and the
memory engine (§6) curates them.

## 7.6 Security & provenance (the enterprise unlock)

Self-evolving agents are blocked from regulated use because the security architecture
doesn't exist (Snyk: 36% of community skills have flaws; arXiv: tool-evolving agents
produce vulnerable tools 76% of the time and accept malicious tools 93% of the time;
one injection can write a permanent backdoor to disk). Eidentic bakes defense into the lifecycle:

- **`skill.lock` provenance.** Records author (human/agent + session), creation trace, test
  results, content hash, and a signature. Every skill has a verifiable origin.
- **Signing & verification.** Skills can be signed; the loader can be configured to run only
  signed skills (or warn). Imported third-party skills are verified against a registry.
- **Capability scoping.** `allowed-tools` is enforced: a skill runs with *only* its declared
  tool/permission set (deny-by-default, §10). A skill can't quietly gain network or fs access.
- **Sandboxed execution.** All executable-skill code runs in the sandbox (§10) — never in
  the host process.
- **Injection-poisoning defense.** Agent-authored skills are quarantined: they require
  passing tests *and* (configurably) human approval before entering the trusted bank. A
  prompt-injection-produced skill cannot silently become trusted.
- **Human-gated self-modification.** Persisting an evolved skill is an approvable action
  (§3.5 `ask`), with diff review.

## 7.7 Self-evolution (that actually persists)

Self-evolution loops are criticized when the mutation loop *doesn't persist changes*
and *"the meta-cognition bill exceeds the work bill."* Eidentic's loop:

```
use skill → log trace + outcome to .memory.md
   → (scheduled) consolidation proposes a mutation
        (instruction tweak | code refactor | merged skill)  ← cost-bounded, optional prompt-optimization
   → generate/augment unit tests for the change
   → run tests in sandbox (test-gate)
   → human-gate (diff review; configurable auto for low-risk)
   → COMMIT new version to Skill Bank (persisted, provenance updated)
```

Key fixes: changes **persist** (versioned in the bank, not lost), are **test-gated** (don't
ship regressions), are **cost-bounded** (the optimizer respects a budget; transparent in
`cost.background`), and are **human-gateable** (don't auto-trust). Evolution is **off by
default** and opt-in.

**Implementation (locked, §0-B1):** the optimizer uses an external prompt-optimization library (pure-TS, opt-in).
Default mode uses bounded ADD/UPDATE/REMOVE edits to a
structured skill "playbook", wired so the **unit-test pass/fail is the reflection signal**.
Multi-objective Pareto optimization is deferred until skills have accumulated enough usage data to
define stable metrics.

**Positioning (correction from review §0-C12):** v1 ships the durable substrate — per-skill memory
(§7.5), test-gated versioning, provenance (§7.6) — and treats **self-evolving executable skills as
a research bet, off by default**, not a load-bearing flagship. The near-term differentiation leads
with memory-as-a-drop-in; skills earn their flagship status once the loop is proven safe.

## 7.8 Discovery & invocation

- **`skill_search(query)`** → relevant skills by description (Tier 1 catalog scoring).
- **`skill_use(name, input)`** → loads Tier 2/3, executes (sandboxed for code), returns result.
- Catalog injection is deterministic and append-only (KV-cache friendly, §4.3).

## 7.9 Per-agent skill sets & sharing

Skills are scoped like memory (§6.7): an agent has its **own** skill set, but skills can be
shared at `org` scope or imported from a registry. This satisfies the requirement that
*skills and memories can differ per agent*. A shared skill carries its own provenance; a fork
gets a new lineage entry.

## 7.10 Cross-agent portability

Because the format is agentskills.io-compatible, a skill authored in Eidentic runs in compatible
agent tools and vice-versa — the addressable skill library is the whole
ecosystem from day one. Eidentic's extensions (`.memory.md`, `skill.lock`) are additive and
ignored by other runtimes, preserving interop.

## 7.11 API sketch

```ts
const agent = new Agent({
  skills: skillSet({
    sources: ['./skills', registry('@eidentic/skills-core')],
    evolution: { enabled: false, optimizer: 'ace', budgetUsd: 0.1, humanGate: true }, // off by default
    security: { requireSigned: false, sandbox: true, quarantineAgentAuthored: true },
  }),
})
```

## 7.12 Traceability

- Self-evolution doesn't persist → §7.7 versioned commit to bank.
- "Meta-cognition > work" cost → §7.7 cost-bounded, transparent.
- Skill poisoning / 76–93% vuln rates → §7.6 quarantine + sign + capability scope + sandbox.
- No per-skill memory → §7.5 `.memory.md`.
- "skills per agent" requirement → §7.9 scoped skill sets.
- Ecosystem lock-in → §7.10 agentskills.io interop.
