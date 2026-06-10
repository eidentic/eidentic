---
"@eidentic/core": minor
---

Lazy tool discovery (§5.4): context-cost control for large toolsets.

- **`search_tools(query, { topK? })`** — a read-only, deterministic keyword scorer (reuses `@eidentic/types` `tokenize` over each tool's name+description) returning the top-k tool **signatures** (name + one-line description only, never the input schema). Surfaces any registered tool, including not-yet-loaded ones.
- **`load_tool(name)`** — loads a tool's full schema into the manifest for the rest of the run. Idempotent; loading an unknown/unavailable tool returns a tool-error; loading an eager-core tool is a no-op success.
- **Threshold-based activation** via `AgentConfig.lazyTools?: boolean | { threshold?; eager?; topK? }`. Below the threshold (default 20), the per-turn manifest is **byte-identical** to today's full schema set. Above it, the model initially sees only the eager atomic core plus the two discovery meta-tools, and discovers the rest on demand.
- **Derived, resume-deterministic state:** the loaded-set is a pure function of the event log (prior successful `load_tool` results) plus config — it is never written as a new event kind, so durable resume reconstructs the identical manifest and the replay hash is unchanged.
- Discovery is a **context optimization, not a capability gate**: the registry remains the dispatch source of truth (an unloaded tool the model calls still dispatches), and statically-denied tools never surface in `search_tools` or any manifest.

Deferred: embedding-scored tool search (keyword-only for v1; `search_tools` can later accept an injected embedder), persistent learned tool-affinity, automatic eviction of loaded tools under a token budget (append-only for v1), and MCP-server-side dynamic registration.
