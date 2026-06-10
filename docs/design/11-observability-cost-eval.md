# 11. Observability + Cost Governor + Eval

[← 10. Security & Sandbox](10-security-sandbox.md) · [Index](master-design.md) · Next: [12. Persistence & Data Model →](12-persistence-data-model.md)

Three cross-cutting fundamentals that the research shows are *the* differentiators between
demos and production: you cannot operate what you cannot see, cannot afford what you cannot
cap, and cannot trust what you cannot test. All three are on-by-default and free (no paid
add-on, no lock-in) — Constitution #3, #5, #8.

---

## 11.1 Observability

### Trace = the session event log, emitted as OTel

The session's append-only event log (§9.1) *is* the trace. The engine emits **OpenTelemetry
GenAI semantic-convention** spans for every stage boundary (§2.6), so any OTLP backend works
and there is zero proprietary format:

- `gen_ai.invoke_agent` (agent run) → children: `gen_ai.chat` (model calls),
  `gen_ai.execute_tool` (tool calls), plus Eidentic spans for `memory.retrieve`,
  `memory.consolidate`, `context.compact`, `skill.use`, `spawn_agent`.
- Standard attributes: model, `gen_ai.usage.input_tokens`/`output_tokens`, tool name/args/
  result, agent id/name, plus Eidentic extensions: **`eidentic.kv_cache_hit_rate`** (Manus's #1
  metric), `eidentic.cost_usd`, `eidentic.scope`, `eidentic.checkpoint_id`.

### What it enables

- **Time-to-root-cause < 4 min.** Full reasoning chain (not just inputs/outputs) is visible;
  spans capture the *commands executed*, not just their output (the postmortem gap).
- **No truncation in primary storage.** Span payloads are stored complete; UI may elide, storage never does.
- **Replay / time-travel.** Because state is event-sourced and forkable (§9.7), any run replays
  from any checkpoint — built in and free.
- **Default exporter:** OTLP → any OTLP-compatible backend via config (a self-hostable open-source
  UI is the recommended default). On by default with an in-memory tracer
  (zero-config dev); production points at an OTLP endpoint.

### Stability promise (honest version)

Our **own event/stream types (§3.2) are the stable contract** users code against — no "OTel
deprecated with 28 days notice." We emit OTel GenAI spans via
`@opentelemetry/semantic-conventions/incubating`. *Correction from review: the GenAI conventions
are still **"Development"** status as of June 2026 (not Stable), so the OTel attribute names may
evolve.* We shield users from that churn: our emitted attributes track the conventions and may
gain fields, but the user-facing event types do not break. Opt into newer conventions via
`OTEL_SEMCONV_STABILITY_OPT_IN`.

---

## 11.2 Cost Governor

### Enforcement, not alerts

The $47K and $500M incidents happened with *alerting* in place — alerts fire *after* spend.
The governor **enforces before each model/tool call**, in the critical path, *outside* agent
code (so a task-motivated agent can't circumvent it):

```
preflight(run):
  if spend.usd      >= policy.maxCostUsd      → abort('max_cost')
  if spend.tokens   >= policy.maxTokens       → abort
  if elapsed        >= policy.maxWallClock    → abort
  if iterations     >= policy.maxTurns        → abort
  if softThreshold crossed → onCostThreshold hook (e.g. force cheaper model)
```

- **Hard ceilings** on $, tokens, wall-clock, and iterations — per run *and* per agent-tree
  (a multi-agent fan-out shares one budget, §8.6).
- **Progress-gated retries** (the $47K lesson): a retry requires evidence of progress (changed
  state/error), not just remaining budget. Primary control; caps are the backstop.
- **Typical production config:** soft cap forces a cheaper model; hard cap aborts; monthly
  ceiling requires human approval to exceed.

### Cost-reduction levers (built in)

- **Model routing / cascade.** Send to a cheap model first; escalate on low confidence.
  Structurally supported by `prepareStep` (per-step model choice) and the plan-execute strategy
  (1× strong + N× cheap). Moving 70% of calls to cheap models ≈ 60% cost cut.
- **Prompt/KV caching.** The context engine's append-only, stable-prefix discipline (§4.3) is
  what makes provider caching effective (Manus's entire 10× win). The governor reports cache
  hit-rate and cached-token savings.

### Transparent accounting (Constitution #5)

`CostBreakdown` separates `foreground`, `background` (memory consolidation §6.5, skill
evolution §7.7), and `cached` tokens, per model, in dollars. **Every** LLM call is counted —
no hidden background-model calls. Background work also respects the governor's budget.

---

## 11.3 Eval (first-class, not bolted on)

No major framework ships a test harness, yet 17% of agent failures are step-repetitions and
14% are reasoning/action mismatches — both invisible to final-output checks. `@eidentic/eval`
ships in-repo.

### Three levels

1. **End-to-end** — did the task succeed? (deterministic assertion or LLM-judge)
2. **Trajectory** — right steps, right order? Score tool sequence, retries, step-efficiency
   (watch "verifier stall": >10 same-name tool spans). Needs multiple samples for stable metrics.
3. **Component** — test individual tools, retrievers, sub-agents, memory recall in isolation.

### Metrics

- **Deterministic** (no judge): tool-correctness, required-param presence, schema validity,
  idempotency-key presence — fast and cheap.
- **LLM-as-judge** (subjective): task completion, plan quality, faithfulness, answer relevancy.
  Judge is a *different* model than the agent (no self-bias, Constitution #6).

### The regression-from-failure loop

A first-class operation: `eval.captureFailure(session)` turns any production failure into a
dataset case + regression test. *"Your dataset grows every time the agent embarrasses you."*
The agent never writes its own ground truth (the locked-in-bugs anti-pattern).

### Memory & skill evals

The memory benchmark harness (§6.10, LongMemEval/LoCoMo/temporal) and skill test-gates (§7.4)
are eval consumers — memory and skills are continuously scored, with published baselines and CI
regression tracking.

### Tooling interop

Emits OTel + standard eval datasets; integrates with external eval/observability
backends rather than locking to one. The pattern of eval-tool acquisitions is a cautionary
note motivating vendor-neutrality.

---

## 11.4 API sketch

```ts
new Agent({
  policy: {
    maxTurns: 16, maxCostUsd: 0.5, maxWallClock: '60s',
    routing: cascade(['haiku', 'sonnet', 'opus']),
    onCostThreshold: forceModel('haiku'),
  },
  observability: otel({ exporter: 'otlp', endpoint: process.env.OTLP_URL }), // default in-memory
})

// eval
import { evaluate, trajectory, llmJudge } from '@eidentic/eval'
await evaluate(agent, dataset, { scorers: [trajectory.toolCorrectness, llmJudge.taskCompletion('opus')] })
```

## 11.5 Traceability

- 27% of failures = no observability → §11.1 on-by-default OTel + replay, free.
- $47K/$500M runaway costs → §11.2 enforcement (not alerts) + progress-gated retries.
- Hidden costs / OTel deprecation → §11.2 transparent accounting + §11.1 OTel-native stability.
- "Can't test my agent" → §11.3 trajectory eval + failure-to-regression loop.
- Span truncation → §11.1 complete payload storage.
