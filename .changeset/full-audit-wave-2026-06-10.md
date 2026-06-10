---
"@eidentic/a2a": minor
"@eidentic/core": minor
"@eidentic/types": minor
"@eidentic/server": minor
"@eidentic/workflow": minor
"@eidentic/react": minor
"@eidentic/memory": minor
"@eidentic/langfuse": minor
"@eidentic/cli": minor
"create-eidentic": minor
"@eidentic/studio": minor
"@eidentic/tools": patch
"@eidentic/mcp": patch
"@eidentic/nextjs": patch
"@eidentic/postgres": patch
"@eidentic/libsql": patch
"@eidentic/sqlite": patch
"@eidentic/lancedb": patch
"@eidentic/pgvector": patch
"@eidentic/qdrant": patch
"@eidentic/pinecone": patch
"@eidentic/model": patch
"@eidentic/e2b": patch
"@eidentic/skills": patch
"@eidentic/rag": patch
"@eidentic/bench": patch
"@eidentic/transformers": patch
---

Full-audit remediation + feature wave (PRs #143–#162).

Security: A2A task ownership + bounded store; per-tenant workflow runs (owner + UUID ids); pre-auth rate limiting + per-client anon buckets; apiKey session ownership; MCP transport auth hook; chunked body cap; prompt-injection escapes (skill_reference/user_input); web_fetch oversize + URL secret stripping; timing-safe OAuth compare; langfuse redaction hooks.

Correctness: single-connection pg.Pool transactions; atomic libsql upsert; FTS5 quote escaping; pgvector composite (id,scope_key) key; lancedb filter hardening; workflow failed-run recording + composite map errors + abort propagation; react unmount/polling fixes; persisted structured-output retries; sandbox timeouts/abort.

Features: workflow durable run store + suspend/resume (deterministic replay) + per-step retry + versioning + map collect mode; HMAC-signed webhooks; CORS + graceful drain; onPostToolUse hook; typed terminal result details; per-turn context injection; persistent memory ingest metadata (sqlite/libsql v10, postgres v8 migrations); Bun template; typed useAsyncRun + stream retry; studio share links.
