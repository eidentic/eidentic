---
"@eidentic/skills": minor
---

§7.7 skill self-evolution: agentic-context-engineering optimization pattern, native over ModelPort — test-gated, cost-bounded,
human-gated, persisted, OFF BY DEFAULT.

**Architecture decision:** the design references an external prompt-optimization library as the optimizer. That library ships
its own model-client layer that conflicts with Eidentic's BYO-`ModelPort` architecture. The
optimization algorithm is therefore implemented natively over `ModelPort` (the test-gate IS the reflection
signal) and an `Optimizer` seam is exposed so an external optimizer can be plugged in later. No external optimizer library
is added as a dependency.

**New exports from `@eidentic/skills`:**

- **`evolveSkill(skill, opts)`** — the optimization loop: establishes a baseline via the shared
  test-gate, then for up to `maxRounds` calls the proposer model with a `propose_skill_edit`
  tool (ADD/UPDATE/REMOVE on the skill's `instructions`/`description`). Each candidate is run
  through the real test-gate. The first candidate that passes all tests becomes `result.evolved`.
  Malformed proposer output (no tool call / unchanged instructions) skips the round without
  crashing. The loop stops on first passing candidate, round exhaustion, or `maxUsd` cost ceiling.
  `evolveSkill` NEVER auto-registers — the caller decides.

- **`EvolveOptions`** — `model`, `maxRounds` (default 3), `maxUsd` (optional cost ceiling),
  `optimizer` (override the default `ModelOptimizer`), `now`.

- **`EvolveResult`** — `evolved` (passing candidate or null), `baselinePassed`, `rounds`,
  `usage` (total proposer tokens, surface to `cost.background`), `history`.

- **`Optimizer`** interface — the seam for a future external-optimizer adapter:
  `propose({ instructions, failures, tests }) → { instructions, usage }`.

- **`ModelOptimizer`** — default `Optimizer` implementation using `ModelPort`. Builds a
  structured system+user prompt with the failing test names as the reflection signal, calls
  the model with the `propose_skill_edit` tool, and applies ADD/UPDATE/REMOVE semantics.

- **`runSkillTests(def, callTool?, invoker?)`** — shared test-gate helper extracted from
  `SkillBank`. Both `SkillBank.register` and `evolveSkill` call this; test-gate logic is NOT
  duplicated. `SkillBank` passes its sandbox invoker for code-string skills; `evolveSkill` uses
  the default (typed-function skills only in the evolution surface).

**Properties:**
- **OFF BY DEFAULT:** `evolveSkill` is an opt-in function, never auto-runs in the Agent loop.
- **Test-gated:** no candidate is returned unless it passes ALL declared `SkillTest`s.
- **Cost-bounded:** `maxRounds` (default 3) + optional `maxUsd` ceiling stop the loop.
- **Human-gated:** `evolveSkill` never calls `SkillBank.register`. The caller registers with
  `author: "agent"` → SkillBank quarantines it until `approve()` (the existing human gate).
- **Persisted:** once the caller registers the evolved skill, `SkillBank` writes a versioned
  `skill.lock` with provenance (same as any other skill registration).
