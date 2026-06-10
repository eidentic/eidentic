---
"@eidentic/core": minor
"@eidentic/studio": minor
"@eidentic/cli": minor
---

**Studio agent-detail view — tools, model, and instructions per agent.**

### `@eidentic/core`

New public members on `Agent`:

- `toolSchemas(): ToolSchema[]` — returns the effective tool set for a default agent-scoped turn: the configured `config.tools` plus all auto-added groups (`memory_*` when memory is editable, `graph_*` when a graph store is attached, `skill_*` when skills are configured, `spawn_agent` when sub-agents exist, lazy discovery tools when `lazyTools` is enabled). Safe to call without a live session; intended for introspection.
- `get modelId(): string | undefined` — the model id from `config.modelId ?? config.model.modelId`.
- `get instructions(): string` — the agent's system prompt.

### `@eidentic/studio`

Backend:

- `GET /api/agents/:id` — new detail endpoint returning `{ id, instructions, model, tools: ToolSchema[], hasMemory, hasSkills, hasGraph }`. Auth-gated like all other routes.
- `GET /api/agents` — each summary now includes `toolCount: number`.

UI (`packages/studio/ui`):

- New **Tools** tab (`ToolsView`) listing each tool's name, description, and expandable input schema.
- **Agent detail header** above tab content: agent id, model id, instructions snippet, and capability badges (tools count, memory, graph, skills).
- Tabs reordered: Tools is the default view when an agent is selected; Agents → Tools → Sessions → Memory → Skills → Run.
- Selecting a different agent switches back to the Tools tab automatically.

### `@eidentic/cli`

The `eidentic init`-generated `eidentic.config.ts` now includes a sample `get_time` tool so a freshly scaffolded agent immediately shows a tool in the Studio UI.
