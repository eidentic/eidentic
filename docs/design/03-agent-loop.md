# 3. Core: Agent Loop

[← 2. Architecture](02-architecture-overview.md) · [Index](master-design.md) · Next: [4. Context Engine →](04-context-engine.md)

The agent loop is the heartbeat. Per Addy Osmani's harness research: *"a decent model
with a great harness beats a great model with a bad harness"* — moving the same model
between harnesses swings performance 30+ percentile points. This section specifies that
harness.

## 3.1 Build our own loop (don't outsource it)

**Decision:** Eidentic owns the agentic loop. AI SDK v6 is used *only* as the `ModelPort`
transport — `streamText`/`generateText` for a single model round-trip with tool-call
parsing and structured output. We do **not** delegate the multi-step loop to AI SDK's
`ToolLoopAgent`.

Rationale: the loop is where context engineering, cost enforcement, durable
checkpointing, permission gating, memory hooks, and error recovery all interleave (see
[2.6](02-architecture-overview.md#26-data-flow-of-a-single-agent-turn)). These are exactly
the cross-cutting concerns we refuse to bolt on. Owning the loop is the only way to put a
checkpoint after every tool call and a cost check before every model call. AI SDK's loop
is a convenience we'd have to fight. We still benefit from AI SDK's provider breadth,
streaming normalization, and tool-call/JSON parsing.

## 3.2 The canonical message & streaming protocol

The protocol is the API contract; design it before the loop. Defined in `@eidentic/types`.
Five outbound event kinds (modeled on the proven shape of production agent SDKs, adapted):

```ts
type EidenticEvent =
  | { type: 'session.init';   sessionId: string; agentId: string; tools: string[]; model: string }
  | { type: 'assistant';      content: ContentBlock[]; /* text + toolUse blocks */ }
  | { type: 'tool.result';    callId: string; toolName: string; output: unknown; isError: boolean }
  | { type: 'stream.delta';   delta: StreamDelta /* token-level, when streaming */ }
  | { type: 'result';         subtype: TerminationSubtype; output?: unknown;
                              usage: Usage; cost: CostBreakdown; numTurns: number; sessionId: string }

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; callId: string; name: string; input: unknown }
  | { type: 'thinking'; text: string }     // extended-thinking models

type TerminationSubtype =
  | 'success'                 // model produced a final answer with no tool calls
  | 'max_turns'               // hit the turn cap
  | 'max_cost'                // cost governor hard cap
  | 'max_wallclock'
  | 'stop_condition'          // a user stopWhen predicate fired
  | 'aborted'                 // AbortSignal
  | 'permission_denied'       // a required tool was denied and the model could not proceed
  | 'error'                   // adapter/model failure after retries
```

`CostBreakdown` separates foreground, background (memory/consolidation), and cached
tokens, with per-model dollar amounts — Constitution #5 (transparent cost). Every
`result` carries usage/cost even on error subtypes (a Claude-SDK lesson: error paths must
still report cost).

The same event stream is what the SDK `query()` async-iterates, what the server streams
over SSE, and what the tracer consumes. One protocol, three consumers.

## 3.3 The loop (pseudocode)

```ts
async function* runTurn(agent, session, input, opts): AsyncIterable<EidenticEvent> {
  yield emitInit(session, agent)
  session.append(userEvent(input))                  // checkpoint
  let turn = 0

  while (true) {
    cost.preflight(session)                          // throws → 'max_cost'
    stop.check(turn, session, opts.stopWhen)         // throws → 'max_turns' | 'stop_condition'

    // §6 memory hooks — push (always-in-context blocks) + pull (volatile recall); DTOs, not Session
    const blocks = await agent.memory.getAlwaysInContext(scope)
    const recall = await agent.memory.retrieve(toRetrievalQuery(session, scope))
    const window = contextEngine.assemble({                    // §4
      agent, session, blocks, recall, toolManifest: perms.visibleTools(agent, session)
    })

    // single model-selection point (§0-C8 precedence): cascade routing → prepareStep → cost-threshold downgrade
    const model = resolveModel(agent, turn, session, cost)
    const completion = model.stream(window)          // AI SDK v6 single round-trip
    const { text, toolCalls, usage } = yield* relay(completion)   // emits assistant/delta
    cost.record(usage)

    if (toolCalls.length === 0) {                    // final answer
      await agent.memory.write(session, { kind: 'episodic' })    // async, §6
      maybeScheduleConsolidation(agent)
      return yield emitResult('success', text, session)
    }

    // dispatch: read-only in parallel, mutating serialized (§5)
    for await (const r of dispatchToolCalls(toolCalls, { agent, session, perms, sandbox })) {
      session.append(r)                              // checkpoint per tool result
      yield toolResultEvent(r)
    }
    turn++
  }
}
```

`relay()` forwards token deltas and assembles the assistant message. `dispatchToolCalls()`
is detailed in [Section 5](05-tool-system.md); it enforces permissions, sandboxing,
idempotency, and parallel/serial scheduling. The loop body is small on purpose — the
intelligence is in the ports it calls.

## 3.4 Termination & guards (no runaway loops)

The $47K / $500M incidents were unbounded loops. Guards, all enforced *outside* model
reasoning (so the model cannot talk its way past them):

- **`maxTurns`** — global turn cap (default **16**; examples throughout use this default).
- **`maxCostUsd` / `maxTokens`** — hard ceiling via cost governor (§11); soft threshold
  can force a cheaper model via `prepareStep`.
- **`maxWallClock`** — wall-clock budget.
- **Per-tool call cap** — caps repeated calls to the *same* tool (defeats "verifier
  stall", where an agent loops re-calling a check tool with reworded args — a documented
  ReAct failure mode). Healthy runs show 3–6 tool spans; >10 same-name calls trips the guard.
- **Progress-gated retries** — a retry of a failing tool/step requires evidence of
  progress (changed error/state), not just remaining budget. Primary control; budget caps
  are the backstop (the $47K postmortem's core lesson).
- **`stopWhen`** — user predicates: `stepCountIs(n)`, `hasToolCall(name)`, `outputMatches(schema)`.
- **`AbortSignal`** — cooperative cancellation; emits `aborted` with partial cost.

## 3.5 Hooks & middleware (the extensibility lever)

A typed lifecycle hook system (18 events, the most sophisticated in the research). Hooks can
observe, mutate inputs, block, or run fire-and-forget side effects. Conflict resolution:
**deny > defer > ask > allow**.

```ts
interface Hooks {
  onSessionStart?:  (ctx) => void | Promise<void>
  onUserPrompt?:    (ctx, input)  => HookResult            // inject/augment context
  onPreModel?:      (ctx, window) => HookResult            // last chance to edit the window
  onPreToolUse?:    (ctx, call)   => HookResult            // block | modify input | ask
  onPostToolUse?:   (ctx, result) => HookResult            // transform | audit
  onToolFailure?:   (ctx, error)  => HookResult            // recovery strategy
  onPreCompact?:    (ctx, plan)   => HookResult            // archive before compaction (§4)
  onCostThreshold?: (ctx, spend)  => HookResult            // react to soft budget breach
  onStop?:          (ctx, result) => void | Promise<void>
}

type HookResult =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }      // shown to the model
  | { decision: 'ask' }                       // route to human gate
  | { decision: 'defer' }
  | { updatedInput?: unknown; systemMessage?: string; async?: boolean }
```

Matchers select which tools/events a hook applies to (exact name, regex, or `*`). Hooks
are the user's seam for guardrails, approvals, redaction, and policy — without forking the loop.

## 3.6 Reasoning patterns as composable strategies (not the loop itself)

The base loop is **ReAct** (reason → act → observe), the battle-tested default. But
plan-and-execute and reflection are not separate loops — they are **strategies layered via
the same primitives**:

- **ReAct** (default): the §3.3 loop. For interactive, state-dependent tasks (coding, support).
- **Plan-and-Execute:** a `Planner` produces a typed step list; the executor runs each step
  as a ReAct sub-run with a cheap model — structurally "1× strong + N× cheap" (cost-optimal
  when N>3). Implemented as a strategy that wraps the loop + the multi-agent agent-as-tool
  primitive (§8). Guard: replanning gate after K steps or on low-confidence output (defeats
  "brittle plan").
- **Reflection:** a draft → critic → revise wrapper. The critic **must** be a different
  model or grounded in external signals (test runs, schema validation) — never same-model
  self-critique (Constitution #6; the research is unambiguous that intrinsic self-correction
  fails). Reflection is a strategy that re-enters the loop with critic feedback in context.

```ts
const agent = new Agent({
  // ...
  strategy: reflection({ critic: 'openai/gpt-5.5', ground: ['tests', 'schema'], maxRevisions: 2 }),
  // or: planAndExecute({ planner: 'opus', executor: 'haiku', replanEvery: 5 }),
  // or: react()   // default
})
```

This keeps the harness modular: patterns compose rather than fork. Choosing a pattern is
configuration, not a rewrite.

## 3.7 Error recovery

Tool-calling reliability is 85–97% in production; the loop must degrade gracefully.
Cautionary patterns to avoid: looping 5 identical tool calls, or silently removing
`repairToolCall` from a framework:

- **Malformed/hallucinated tool calls** → a built-in repair pass: re-prompt the model with
  the schema and the validation error (one bounded retry) before surfacing an error. The
  invalid call and its error stay in context (preserve failure evidence) so the model adapts.
- **Tool execution failure** → `onToolFailure` hook decides retry (with backoff +
  idempotency check via §9), substitute, or surface-to-model.
- **Unknown tool name** → never a hard crash; returned to the model as a typed error result
  listing valid tools.
- **Model/provider outage** → `ModelPort` retries with backoff, then fails over to a
  configured backup model; exhausted → `error` subtype with full cost reported.

## 3.8 Public API surface (embedded mode)

```ts
import { Agent } from '@eidentic/core'

const agent = new Agent({
  id: 'support',
  instructions: '…',
  model: 'anthropic/claude-sonnet-4-6',
  tools: { lookupOrder, refund },
  memory: memory({ scope: 'user' }),       // §6
  skills: ['triage'],                       // §7
  policy: { maxTurns: 16, maxCostUsd: 0.5, permissions: 'deny-by-default' },
  store, vector, durable, tracer,           // adapters (defaults if omitted)
})

// One-shot, streaming events
for await (const ev of agent.query('Where is order 123?', { sessionId, userId })) {
  if (ev.type === 'result') console.log(ev.output, ev.cost)
}

// Multi-turn client with mid-session control
const s = agent.session({ sessionId, userId })
await s.send('…'); await s.setPermissionMode('acceptEdits'); await s.send('…')
```

The `query()` generator *is* the contract; the CLI and server are thin wrappers over it.
Sessions resume/fork by id (§9, §12).

## 3.9 How this answers the gaps (traceability)

- Runaway-cost incidents → §3.4 guards enforced outside model reasoning.
- "Can't tell why my agent did X" → every stage is an OTel span; full event log is the session.
- Tool-loop flakiness → §3.7 repair + per-tool caps + progress-gated retries.
- Framework churn → the §3.2 protocol is the stable contract; internals can change beneath it.
