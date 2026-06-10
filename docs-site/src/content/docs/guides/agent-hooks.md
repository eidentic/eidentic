---
title: Agent Hooks
description: Intercept tool use, enforce permissions, track cost thresholds, and type terminal results with AgentConfig hooks.
---

`AgentConfig` exposes several hooks for observability, access control, and lifecycle management. All hooks are optional and composable.

## `onPreToolUse`

Called before every tool dispatch. Return `"allow"` or `"deny"` to override the permission policy, or return nothing to let the policy decide.

```ts
import { Agent } from "@eidentic/core";

const agent = new Agent({
  id: "assistant",
  model,
  store,
  onPreToolUse: async (toolId, input) => {
    if (toolId === "bash" && (input as { command: string }).command.includes("rm -rf")) {
      return "deny";
    }
    // Return undefined → policy continues normally
  },
});
```

| Parameter | Type | Description |
|---|---|---|
| `toolId` | `string` | Registered tool id |
| `input` | `unknown` | Parsed, validated input the model passed |
| Return | `"allow" \| "deny" \| void` | Override decision, or `void`/`undefined` to continue |

## `onPostToolUse`

Called after every tool dispatch — both on success and on error. Throwing inside the hook is **swallowed** (logged at warn level) so observability code can never kill a run.

```ts
const agent = new Agent({
  id: "assistant",
  model,
  store,
  onPostToolUse: async ({ toolId, input, output, isError, durationMs, sessionId }) => {
    await auditLog.record({ toolId, input, output, isError, durationMs, sessionId });
  },
});
```

| Field | Type | Description |
|---|---|---|
| `toolId` | `string` | Tool id |
| `input` | `unknown` | Parsed input |
| `output` | `unknown` | Return value or error object |
| `isError` | `boolean` | `true` when the tool threw or produced an error result |
| `durationMs` | `number` | Wall-clock time from dispatch start to completion |
| `sessionId` | `string` | Current session id (empty string when not set) |

## `onPermissionRequest`

Required when any tool has `sideEffect: "ask"`. The hook receives the call and must return `"allow"` or `"deny"` — it is the resolution point for human-in-the-loop tool approval.

```ts
const agent = new Agent({
  id: "assistant",
  model,
  store,
  onPermissionRequest: async (toolId, input) => {
    const approved = await humanApprovalQueue.ask({ toolId, input });
    return approved ? "allow" : "deny";
  },
});
```

If a tool with `sideEffect: "ask"` is dispatched and no `onPermissionRequest` is provided, the dispatch is denied automatically.

## `onCostThreshold`

Fired once when cumulative USD spend for the run first crosses `policy.softCostUsd`. Does not abort the run — use it to warn users or update UI.

```ts
const agent = new Agent({
  id: "assistant",
  model,
  store,
  prices: defaultPrices,       // enables USD accounting
  policy: { softCostUsd: 0.05, maxCostUsd: 0.20 },
  onCostThreshold: (info) => {
    console.warn(`Cost threshold crossed: $${info.usd.toFixed(4)} (soft cap $${info.softCapUsd})`);
    notifyUser(info);
  },
});
```

`info` shape:
| Field | Type | Description |
|---|---|---|
| `usd` | `number` | Accumulated cost at threshold crossing |
| `softCapUsd` | `number` | The configured soft cap |
| `sessionId` | `string` | Current session |

## `onTurnStart`

Called at the start of each model turn. Return a string (or array of strings) to inject ephemeral context into that turn's system prompt. The injection is NOT persisted to the event log.

```ts
const agent = new Agent({
  id: "assistant",
  model,
  store,
  onTurnStart: async ({ turn, sessionId }) => {
    const userPrefs = await prefs.load(sessionId);
    return `User preferences: ${JSON.stringify(userPrefs)}`;
  },
});
```

Return `void` or `undefined` to suppress injection for a given turn. Multiple strings are concatenated with a newline.

## Typed terminal result (`ResultDetails`)

The terminal `result` event from `agent.query()` carries a `details` field typed as a `ResultDetails` union. Narrow on `subtype` to access subtype-specific fields:

```ts
for await (const ev of agent.query("Summarise this.", { sessionId })) {
  if (ev.type === "result") {
    switch (ev.subtype) {
      case "success":
        console.log("Output:", ev.output);
        console.log("Cost:", ev.cost?.usd);
        break;
      case "max_cost":
        console.warn("Run stopped at cost ceiling");
        break;
      case "suspended":
        console.log("Waiting for approval:", ev.callId);
        break;
      case "guardrail":
        console.warn("Guardrail blocked output");
        break;
      case "error":
        // output is sanitized; real error is server-side
        break;
    }
  }
}
```

All subtypes: `"success"`, `"error"`, `"max_tokens"`, `"max_cost"`, `"aborted"`, `"suspended"`, `"max_wall_clock"`, `"guardrail"`.

## Putting it together

```ts
import { Agent, AIModel, SqliteStore } from "eidentic";
import { defaultPrices } from "@eidentic/model";

const agent = new Agent({
  id: "assistant",
  model: new AIModel(provider("model-id")),
  store: new SqliteStore("./eidentic.sqlite"),
  prices: defaultPrices,
  policy: { softCostUsd: 0.10, maxCostUsd: 0.50 },

  onPreToolUse: (toolId, input) => {
    if (isDenied(toolId)) return "deny";
  },

  onPostToolUse: ({ toolId, isError, durationMs }) => {
    metrics.record("tool_call", { toolId, isError, durationMs });
  },

  onPermissionRequest: async (toolId, input) => {
    return await approvalQueue.ask(toolId, input) ? "allow" : "deny";
  },

  onCostThreshold: (info) => {
    alerting.warn(`Cost ceiling approach: $${info.usd.toFixed(3)}`);
  },
});
```

## Gotchas

- `onPostToolUse` fires for every dispatch including sub-agent runs that share the same `ToolRegistry`. It does NOT fire for permission-denied or parse-error short-circuits.
- A throwing `onPostToolUse` is swallowed — wrap in try/catch if you need to guarantee your hook logic runs to completion.
- `onPreToolUse` returning `"allow"` does NOT bypass the permission policy entirely — it only overrides the hook's own decision point. Statically-denied tools are removed from the schema before the model ever sees them.
