---
"@eidentic/types": minor
"@eidentic/core": minor
---

Add `topicGuardrail` (LLM-judge scope enforcement) and `AgentConfig.greeting` (static opening message).

**`topicGuardrail`** — new factory in `@eidentic/core` that returns a `GuardrailPort` whose `checkInput` uses a provided `ModelPort` to classify whether the user's input is within a declared scope, blocking off-topic requests before the main model is called. Accepts `model` (cheap classifier), `description` (what the agent IS allowed to help with), `blockMessage` (custom block reason), and `allowOnUncertain` (default `false` → fail-safe block on ambiguous/error). The classification prompt is minimal (system + user, no tools) and parses ALLOW/BLOCK case-insensitively. Defense-in-depth: complements system-prompt scoping with an independent LLM check on the raw, unprocessed input.

**`AgentConfig.greeting`** — optional static string shown to the user before the first turn. Never sent to the model, never persisted as an event, costs no tokens. Exposed via `agent.greeting` getter and included in the `session.init` stream event payload as `greeting` so front-ends can render it immediately as an initial assistant bubble. The `StreamEvent["session.init"]` type in `@eidentic/types` gains an optional `greeting?: string` field (backward-compatible — absent when unset).
