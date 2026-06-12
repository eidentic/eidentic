# @eidentic/mcp

## 0.1.4

### Patch Changes

- Updated dependencies [9d3b98d]
  - @eidentic/core@0.2.2
  - @eidentic/types@0.2.1

## 0.1.3

### Patch Changes

- Updated dependencies [39137dd]
  - @eidentic/core@0.2.1

## 0.1.2

### Patch Changes

- Updated dependencies
- Updated dependencies [7c454e5]
- Updated dependencies [de07ecc]
  - @eidentic/core@0.2.0
  - @eidentic/types@0.2.0

## 0.1.1

### Patch Changes

- Republish all packages via GitHub Actions trusted publishing (OIDC). This is the
  first release with provenance attestation — every package now carries a verifiable
  build provenance statement linking it to its source commit and workflow.
- Updated dependencies
  - @eidentic/core@0.1.1
  - @eidentic/types@0.1.1

## 0.1.0

### Minor Changes

- 3a605b5: Launch-readiness + capability wave (PRs #164–#175).

  New packages: @eidentic/prompts (immutable prompt versioning, tags, canary, rollback), @eidentic/browser (sealed browser tools over injected Playwright-like page).

  Memory: extraction reject gate, recall-loop prevention, write dedup, transient TTL, entity fusion signal; state-transition timelines (Fact.supersedes, factTimeline), corroboration/staleness tiers, ConsentManifest enforcement + retroactive applyConsent, exportScope portability, mergeScopes identity upgrade. Store migrations: sqlite/libsql v11, postgres v9.

  Model: withFallback / routeModel / cachedModel composable ModelPort wrappers. MCP: per-call OTel spans + audit events (host + server). Eval/CLI: compareReports baselines, markdown reports, eval-CI workflow template. Bench: write-quality + temporal point-in-time benchmarks.

  Hygiene: per-package READMEs/metadata/LICENSE, SECURITY.md, STABILITY.md, real CI badge, deterministic durability ordering, landing/doc refresh (25 docs pages).

- 3a605b5: Close MCP server authorization gap (security hardening).

  **Finding #5 High — per-call authorization & destructive-tool opt-in:**

  - `serveTools`, `mcpServer`, and `createMcpServer` now accept an `authorize?(toolName, input): boolean | Promise<boolean>` hook. When set, it is called before every `tools/call` dispatch; returning `false` (or throwing) yields `isError: true` without executing the tool. Default behaviour (hook absent) is unchanged for back-compat.

  - Tools with `sideEffect: "destructive"` (e.g. `bashTool`, agent-as-tool) are **skipped by default** — they will not appear in `tools/list` and cannot be called. A `console.warn` is emitted for each skipped tool. Opt in explicitly via `allowDestructive: true` or by providing an `authorize` hook. This is a **safe-by-default breaking change** for callers that pass destructive tools: add `allowDestructive: true` (or an `authorize` hook) to restore the previous behaviour.

  - Added `allowDestructive?: boolean` to `McpServerOptions` (inherited by all builders).

  **Finding #5 Low — agent error terminals:**

  - `serveAgent`: when the final streamed event is `{ type: "result", subtype: <non-success> }` (e.g. `"error"`, `"aborted"`, `"guardrail"`, `"max_turns"`, etc.), the MCP response is now returned with `isError: true` instead of a normal content block. In `mcpServer({agent})`, the synthesized agent tool throws for non-success terminals so the common handler surfaces them as `isError: true`.

  **Restrictive ctx & loud docs:**

  - `ctxFactory` JSDoc updated to clearly state that the default empty context `{}` grants no permissions, no scope, no secrets, and no sandbox — callers must override to inject security context.
  - JSDoc on all public server functions (`serveTools`, `serveAgent`, `mcpServer`, `createMcpServer`) now prominently states: no authentication, no per-call authorization by default, and that the HTTP transport must be placed behind the caller's own auth middleware.

- 3a605b5: New `@eidentic/mcp` package (design §5.5, host side): connect to external MCP servers and expose
  their tools as first-class Eidentic `Tool`s, so the existing `ToolRegistry` / agent loop dispatch
  them unchanged. `mcpTools(client, opts?)` takes an already-connected client (injected-client
  pattern — it opens no connection itself), lists the server's tools, and wraps each: the MCP
  `inputSchema` passes through as the Eidentic `jsonSchema`, `parse` is a pass-through (the server
  validates args), and `execute` calls `callTool` and maps the result. The §5.5 annotation invariant
  is enforced: a server's `readOnlyHint:true` → `"read-only"` (parallelizable); any unannotated
  remote tool → `"destructive"` (safe default — deny-by-default + human-gate). An MCP `isError:true`
  is surfaced as a Eidentic tool error. Ergonomic transport helpers `streamableHttpClient(url, opts?)`
  (default; static auth headers via `requestInit`) and `stdioClient({ command, args, env })` (local
  dev) construct + connect a real client. Conformance runs in CI against a faithful in-memory fake
  (incl. end-to-end dispatch through a real `ToolRegistry`); a gated live test
  (`EIDENTIC_TEST_MCP_STDIO_COMMAND`) covers a real stdio server. Runtime deps are only `@eidentic/core`

  - `@eidentic/types`; `@modelcontextprotocol/sdk` is an optional peer dependency.

  Deferred (not in this release): the MCP **server** side (exposing a Eidentic agent as an MCP server);
  OAuth 2.1 + PKCE + Resource Indicators auth for remote servers (the Streamable HTTP transport
  accepts static auth headers, but the full OAuth flow is deferred); lazy tool discovery
  (`search_tools` / `load_tool`, §5.4); the legacy SSE transport.

- 3a605b5: OAuth 2.1 + PKCE client auth for connecting to protected MCP servers.

  **New API (`src/oauth.ts`):**

  - `generateCodeVerifier()` — cryptographically-random PKCE code_verifier (48 bytes → 64-char base64url).
  - `deriveCodeChallenge(verifier)` — `BASE64URL(SHA256(verifier))` per RFC 7636 §4.2 (S256 method). Uses `globalThis.crypto.subtle` — zero-config on Node 18+, Bun, Deno, and Cloudflare Workers.
  - `base64urlEncode(bytes)` — RFC 4648 §5 base64url with no padding.
  - `generateState()` — 32-byte CSRF state token.
  - `beginAuthorizationFlow(config)` — builds the authorization URL with PKCE challenge, state, redirect_uri, and scope, and returns `{ authorizationUrl, state, codeVerifier }`.
  - `completeAuthorizationFlow(config, code, verifier, returnedState, expectedState)` — validates state (CSRF guard, constant-time comparison), then exchanges the code + verifier for tokens at the token endpoint.
  - `refreshAccessToken(config, refreshToken)` — RFC 6749 §6 refresh grant.
  - `OAuthConnection` — manages in-memory bearer tokens; `setTokens()` / `hasTokens()` / `getAuthorizationHeader()` (auto-refreshes when expired with 30-second buffer) / `loadFromStore()`. Accepts an optional `OAuthTokenStore` hook for persist/restore across process restarts.
  - `OAuthStateError` — thrown on state mismatch (CSRF).
  - `OAuthTokenError` — thrown on token exchange/refresh failure.

  **`streamableHttpClient` updated:** new `opts.oauth?: OAuthConnection` — `getAuthorizationHeader()` is called and injected before each connection; merged with static `opts.headers`.

  **Security:**

  - Tokens and code_verifiers are never logged.
  - `state` is validated with a constant-time XOR comparison before the token exchange.
  - Only authorization-code + PKCE flow — no implicit flow.
  - Discovery (`/.well-known/oauth-protected-resource`) deferred — explicit endpoints required.

- 3a605b5: MCP server side (§5.5 inverse): expose Eidentic tools and agents AS an MCP server so any MCP client
  can call them via `tools/list` + `tools/call`.

  `serveTools(server, tools, opts?)` — structural seam (takes `McpServerLike`, not the raw SDK `Server`)
  that registers handlers onto any compatible server instance. The `McpServerLike` interface is
  satisfied by the real SDK `Server` and by the faithful in-memory fake used in CI, keeping the module
  SDK-free at import time. Each Eidentic tool is advertised as `{ name: tool.id, description,
inputSchema: tool.jsonSchema }` — the JSON Schema is the one `createTool` already computes via
  `z.toJSONSchema`, so no re-conversion is needed. `tools/call` validates arguments through the tool's
  own `parse`, executes via `tool.execute({ input, ctx })`, and returns the result as
  `{ content: [{ type:"text", text: JSON.stringify(result) }] }`. All error paths (unknown tool, parse
  failure, thrown error) return `{ isError: true }` — the handler never throws.

  `serveAgent(server, agentId, agent, description?)` — expose a Eidentic `Agent` as a single MCP tool
  whose call runs `agent.query(input)` to completion and returns the final output text.

  `mcpServer(opts)` (§5.5 D4) — primary entry-point with opts-style API: `opts.tools` (required)
  plus optional `agent`/`agentId`/`agentDescription` to expose an agent as an extra MCP tool. Returns
  an `McpServerHandle` with `serveStdio()` and `serveHttp()` transport helpers.

  `createMcpServer(tools, opts?)` — positional-args builder (kept for back-compat); `mcpServer` is
  preferred for new code. Both dynamically import the SDK `Server` and expose `serveStdio()` (for
  MCP stdio clients) and `serveHttp(opts?)` (Streamable HTTP, stateless or stateful).
  Dynamic import + actionable error if the SDK peer is missing, mirroring the host-side helpers.

  Conformance: faithful in-memory `FakeMcpServer` in `test/server.test.ts` covers `tools/list`,
  `tools/call` (happy + error paths), `serveAgent`, and verifies no handler ever throws. Full SDK
  round-trip in `test/inmemory-roundtrip.test.ts` uses `InMemoryTransport.createLinkedPair()` from
  `@modelcontextprotocol/sdk/inMemory.js` to wire a real Client ↔ Server in-process — covering
  `listTools`, `callTool` (success + error + unknown tool), and the opts-style `mcpServer` API
  including agent exposure. A gated live-SDK test is included but skipped unless
  `EIDENTIC_TEST_MCP_SERVER_LIVE=1`.

  Runtime deps unchanged (`@eidentic/core` + `@eidentic/types` only); `@modelcontextprotocol/sdk`
  stays an optional peer dependency. OAuth/full-transport hardening deferred.

### Patch Changes

- 3a605b5: Full-audit remediation + feature wave (PRs #143–#162).

  Security: A2A task ownership + bounded store; per-tenant workflow runs (owner + UUID ids); pre-auth rate limiting + per-client anon buckets; apiKey session ownership; MCP transport auth hook; chunked body cap; prompt-injection escapes (skill_reference/user_input); web_fetch oversize + URL secret stripping; timing-safe OAuth compare; langfuse redaction hooks.

  Correctness: single-connection pg.Pool transactions; atomic libsql upsert; FTS5 quote escaping; pgvector composite (id,scope_key) key; lancedb filter hardening; workflow failed-run recording + composite map errors + abort propagation; react unmount/polling fixes; persisted structured-output retries; sandbox timeouts/abort.

  Features: workflow durable run store + suspend/resume (deterministic replay) + per-step retry + versioning + map collect mode; HMAC-signed webhooks; CORS + graceful drain; onPostToolUse hook; typed terminal result details; per-turn context injection; persistent memory ingest metadata (sqlite/libsql v10, postgres v8 migrations); Bun template; typed useAsyncRun + stream retry; studio share links.

- 3a605b5: Pre-publish audit fixes (packaging, correctness, security, quality).

  - **Packaging (all 21 packages)**: add `"files": ["dist"]` so npm publish ships only `dist/` and not `src/`, `test/`, or `.turbo/`.
  - **Cost governor (core)**: fold each reflection/planAndExecute sub-run's own-foreground spend into the shared budget after `drainReact`, mirroring `spawn_agent`'s double-count-safe accounting. Previously `policy.maxCostUsd` was enforced per-pass, not cumulatively.
  - **Umbrella strategy exports (eidentic)**: re-export `react`, `reflection`, `planAndExecute` values and `AgentStrategy`, `StrategyContext`, `GroundSignal` types from `@eidentic/core`.
  - **LIMIT parameterization (sqlite, libsql, postgres)**: bind `LIMIT` as a parameter in `listSessions` and `queryFacts` instead of string-interpolating.
  - **SSRF defense-in-depth (tools)**: `isBlockedHost` now catches non-dotted IPv4 encodings (decimal `2130706433`, hex `0x7f...`, octal).
  - **Recall denominator (bench)**: filter blank gold facts from the denominator in `recallAtK`; upgrade the `[0,1]` range assertion to a precise exact-value gate.
  - **Resume IDOR doc note (core, server)**: JSDoc and route comment clarify that `resume` does not verify session ownership per-principal; multi-tenant deployments must add an ownership layer.

- 3a605b5: Security hardening: SSRF redirect-chain bypass in `ingestDocument`, OAuth refresh-token loss, and OAuth endpoint scheme validation.

  **@eidentic/rag — FIX 1 (A-P1, SSRF): Redirect-chain bypass in `ingestDocument`.** Previously, after validating and following the first redirect, subsequent hops were issued with `redirect:"follow"` — the platform transparently followed any further redirects (including to internal/metadata addresses) without re-running `assertFetchableUrl`. Now every hop in the redirect chain is issued with `redirect:"manual"` and each `Location` header is re-validated before following, up to a bounded hop count of 5. A redirect to `169.254.169.254`, `127.0.0.1`, or any other blocked address on hop 2+ is now rejected. Exceeding the hop limit also rejects to prevent redirect-loop DoS.

  **@eidentic/rag — FIX 4 (C-P2): Plain string `ingestDocument` URL misuse warning.** A plain `string` source is raw text — no fetch occurs. A `console.warn` is now emitted when the string starts with `http://` or `https://`, since this is almost certainly a misuse (caller probably meant `{ url: "..." }`). Existing behavior is unchanged.

  **@eidentic/mcp — FIX 2 (A-P2): OAuth refresh token dropped on refresh.** When the authorization server's refresh response omits `refresh_token` (permitted by RFC 6749 §6), the prior refresh token is now preserved: `this.tokens = { ...fresh, refreshToken: fresh.refreshToken ?? this.tokens.refreshToken }`. Without this fix, a user was silently logged out when the next expiry cycle triggered a refresh against a now-dropped token. Token rotation (server provides a new refresh token) continues to work correctly.

  **@eidentic/mcp — FIX 3 (A-P2): OAuth endpoint scheme validation.** `beginAuthorizationFlow` and `OAuthConnection` constructor now validate that `authorizationEndpoint` and `tokenEndpoint` use `https:` (OAuth 2.1 mandates HTTPS for all server endpoints) and that `redirectUri` is `https:` or a loopback `http:` address (`localhost`, `127.0.0.1`, `[::1]` — the OAuth 2.1 native-app exception). An `http://evil.com` token endpoint or redirect URI is now rejected at configuration time with a clear error message.

- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
  - @eidentic/core@0.1.0
  - @eidentic/types@0.1.0
