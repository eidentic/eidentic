---
"@eidentic/a2a": minor
"@eidentic/convex": minor
"@eidentic/core": minor
"@eidentic/libsql": minor
"@eidentic/mcp": minor
"@eidentic/nextjs": minor
"@eidentic/postgres": minor
"@eidentic/server": minor
"@eidentic/skills": minor
"@eidentic/sqlite": minor
"@eidentic/types": minor
"@eidentic/workflow": minor
"@eidentic/pinecone": patch
"@eidentic/qdrant": patch
"@eidentic/model": patch
"@eidentic/react": patch
"@eidentic/studio": patch
---

Harden tenant identity propagation and modernize the release path.

- Session ownership now carries API-key principals through core, server, Next.js, A2A, MCP,
  workflow agent steps, and first-party durable store adapters.
- SQLite, LibSQL, Postgres, and Convex stores persist and filter sessions by `apiKey`.
- Output guardrails now block or redact before assistant events are persisted or ingested into memory.
- Pinecone and Qdrant vector adapters isolate logical IDs per scope, preventing cross-scope overwrite/delete.
- Optional Ollama support stays peer-only instead of pulling the provider into CI.
- Studio's Vite build now explicitly targets ES2022 to match the UI TypeScript target under the updated esbuild toolchain.
- Memory and graph mutation tools now provide scope-aware idempotency keys.
- Skills can pass cancellation signals into executable skills and configure sandbox timeouts.
- Workflow run registries expose `flush()` for deterministic durable write-through and crash-safety tests.
- Release automation now uses a single checked publish script with Changesets and npm Trusted Publishing/OIDC.
