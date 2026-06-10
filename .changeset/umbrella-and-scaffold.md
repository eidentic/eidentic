---
"eidentic": minor
"create-eidentic": minor
---

Add a convenience umbrella package and a project scaffold.

- **`eidentic`** — a single-install umbrella that re-exports the common path (`@eidentic/core` + `@eidentic/types` + `@eidentic/model` + `@eidentic/sqlite` + `@eidentic/memory`). Beginners run `npm i eidentic ai @ai-sdk/anthropic` and get the agent loop, persistence, model adapter, and memory engine from one package. Optional adapters (vector stores, sandbox, MCP, eval, skills) stay à la carte.
- **`create-eidentic`** — `npm create eidentic@latest <dir>` scaffolds a runnable agent project (package.json, tsconfig, a minimal `src/agent.ts` using the umbrella, `.env.example`, README). Zero runtime dependencies.
