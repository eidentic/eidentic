# @eidentic/model

## 0.2.1

### Patch Changes

- cba3409: Docs fix: correct the README code examples to the real (async factory) API.

  - `@eidentic/model`: `new AIEmbedder(model, { dim })` → `await AIEmbedder.create(model)`. The
    constructor is private and the embedding dimension is probed automatically — the old example did
    not compile.
  - `@eidentic/e2b`: `E2BSandbox.create(...)` → `await E2BSandbox.create(...)` (it returns a Promise).

## 0.2.0

### Minor Changes

- bb46351: `AIEmbedder.create` accepts a `maxRetries` option, forwarded to the AI SDK's `embed`/`embedMany`.
  The AI SDK retries transient failures (including provider rate limits / 429s) with exponential
  backoff and honours `retry-after`, so high-volume ingest against a rate-limited embedding provider
  no longer fails after the default 2 attempts. The LongMemEval harness caps over-long embedding
  inputs below the typical 8192-token embedder window.

### Patch Changes

- Updated dependencies
- Updated dependencies [7c454e5]
- Updated dependencies [de07ecc]
  - @eidentic/types@0.2.0

## 0.1.1

### Patch Changes

- Republish all packages via GitHub Actions trusted publishing (OIDC). This is the
  first release with provenance attestation — every package now carries a verifiable
  build provenance statement linking it to its source commit and workflow.
- Updated dependencies
  - @eidentic/types@0.1.1

## 0.1.0

### Minor Changes

- 3a605b5: `AIModel` now accepts generation settings as an optional second constructor argument —
  `new AIModel(model, { temperature, maxOutputTokens, topP, topK, stopSequences, seed,
presencePenalty, frequencyPenalty, maxRetries, providerOptions, headers })`. They are
  forwarded to every `generateText`/`streamText` call. Backward compatible: the single-arg
  form sends no settings (provider defaults).
- 3a605b5: §16.4 cooperative query cancellation — `aborted` result subtype producer, checkpoint-on-abort, child teardown, model `abortSignal` forwarding.

  - **`QueryOptions.signal?: AbortSignal`** (existed) is now threaded all the way through `runTurn` → `runLoop` via the new `RunTurnArgs.signal` field, closing the gap where a long model call or the loop itself would never stop on abort.
  - **Loop boundary checks:** `signal?.aborted` is tested at three points per turn — (1) top of the turn before the model call, (2) immediately after the model call + usage accounting, (3) after each tool batch. On abort the loop emits a terminal `result{subtype:"aborted"}` with the partial `usage`/`cost` accumulated so far and returns.
  - **Checkpoint-on-abort:** when `durable` mode is on, `writeCheckpoint` is called before emitting the `aborted` terminal, reusing the existing incremental rolling-hash mechanism so the aborted run is auditable and resumable.
  - **Mid-model-call abort:** `args.signal` is forwarded to the model request as `ModelRequest.signal` (new optional field on `@eidentic/types` `ModelRequest`). `AIModel.complete`/`stream` in `@eidentic/model` pass it to AI SDK v6 `generateText`/`streamText` as `abortSignal`. For the stream path, the delta iteration `break`s when `signal.aborted`; if no final response was accumulated, an `aborted` terminal is emitted rather than an error.
  - **Child teardown:** `buildSpawnTool` now accepts an optional `signal` argument (captured from `runReact`'s `opts.signal`) and threads it into each child `agent.query(input, { ..., signal })` so the entire sub-agent tree aborts cooperatively with the same semantics.
  - **No-signal path byte-identical:** all boundary checks are `signal?.aborted` which is `undefined`→falsy when no signal is supplied; zero overhead for callers that do not pass a signal.

- 3a605b5: Add `AIEmbedder` — a provider-agnostic, bring-your-own-key hosted `EmbeddingPort` over AI SDK v6. Use any `@ai-sdk/*` embedding model (OpenAI, Cohere, Google, Mistral, …) with your own API key and chosen model: `await AIEmbedder.create(openai.embedding("text-embedding-3-small"))`. It is a first-class peer to the local `@eidentic/transformers` embedder — both implement `EmbeddingPort` and are interchangeable in `FullMemory`. Dimension is discovered automatically via a one-shot probe at construction.
- 3a605b5: Launch-readiness + capability wave (PRs #164–#175).

  New packages: @eidentic/prompts (immutable prompt versioning, tags, canary, rollback), @eidentic/browser (sealed browser tools over injected Playwright-like page).

  Memory: extraction reject gate, recall-loop prevention, write dedup, transient TTL, entity fusion signal; state-transition timelines (Fact.supersedes, factTimeline), corroboration/staleness tiers, ConsentManifest enforcement + retroactive applyConsent, exportScope portability, mergeScopes identity upgrade. Store migrations: sqlite/libsql v11, postgres v9.

  Model: withFallback / routeModel / cachedModel composable ModelPort wrappers. MCP: per-call OTel spans + audit events (host + server). Eval/CLI: compareReports baselines, markdown reports, eval-CI workflow template. Bench: write-quality + temporal point-in-time benchmarks.

  Hygiene: per-package READMEs/metadata/LICENSE, SECURITY.md, STABILITY.md, real CI badge, deterministic durability ordering, landing/doc refresh (25 docs pages).

- 3a605b5: Add Ollama (local/offline) model support and multimodal image input.

  **Feature 1 — Ollama helper (`@eidentic/model`)**

  `createOllamaModel(modelId, opts?)` returns a Vercel AI SDK `LanguageModel` backed by a locally-running [Ollama](https://ollama.com) instance. No API key required — works fully offline.

  ```ts
  import { AIModel, createOllamaModel } from "@eidentic/model";

  const model = new AIModel(createOllamaModel("llama3.2"));
  // or with a custom server URL:
  const model2 = new AIModel(
    createOllamaModel("mistral", { baseURL: "http://192.168.1.10:11434/api" }),
  );
  ```

  `ollama-ai-provider` is an **optional peer dependency** — install it separately when you need local inference:

  ```sh
  npm install ollama-ai-provider
  # or
  pnpm add ollama-ai-provider
  ```

  **Feature 2 — Multimodal image input (`@eidentic/types`, `@eidentic/model`, `@eidentic/core`)**

  Added an `"image"` variant to `ContentBlock` (input-only / vision):

  ```ts
  import { textBlock, imageBlock } from "@eidentic/types";

  // base64 data:
  imageBlock({ data: "<base64>", mediaType: "image/jpeg" });
  // or URL:
  imageBlock({ url: "https://example.com/photo.jpg" });
  ```

  `Agent.query` now accepts `ContentBlock[]` in addition to `string`:

  ```ts
  for await (const ev of agent.query(
    [textBlock("What is in this image?"), imageBlock({ url: "https://..." })],
    { sessionId: "s1" },
  )) { ... }
  ```

  Image blocks are forwarded to vision-capable models (e.g. `llava`, `claude-3-5-sonnet`, `gpt-4o`) as AI SDK `ImagePart` objects. `query(string)` is unchanged — fully backward-compatible.

  New helpers exported from `@eidentic/types`: `imageBlock`, `isImage`, `ImageInput`, `encodeMultimodalInput`, `decodeMultimodalInput`, `MULTIMODAL_INPUT_PREFIX`, `extractTextFromBlocks`.

- 3a605b5: Bundled `defaultPrices` from LiteLLM + `cachedInputPerMTok` accurate cache pricing + opt-in `fetchLatestPrices()` + weekly CI refresh.

  - **`@eidentic/types`**: `ModelPrice.cachedInputPerMTok` — optional price per million cached input tokens (KV-cache reads). When absent, cached tokens fall back to `inputPerMTok` (back-compat). `usdFor` now prices cached and non-cached input tokens separately.

  - **`@eidentic/model`**: Ships a bundled, dated `defaultPrices: PriceTable` seeded from LiteLLM's `model_prices_and_context_window.json` (~550 entries across Anthropic, OpenAI, Gemini, DeepSeek, Mistral, xAI, Cohere). The library **never auto-fetches** at runtime — prices are static and offline-safe. Also exports `fetchLatestPrices(opts?)` (opt-in, schedule yourself), `mapLiteLLM(raw)` (pure mapping function), and `pricesUpdatedAt` (ISO date of last generation). A `gen:prices` package script + `scripts/gen-prices.ts` regenerate the table from LiteLLM.

  - **`@eidentic/cli`**: The `eidentic init` scaffold now adds `prices: defaultPrices` to the generated Agent so `cost.usd` is populated out-of-the-box.

  - **`eidentic`**: Re-exports `defaultPrices`, `pricesUpdatedAt`, `fetchLatestPrices`, `mapLiteLLM` from `@eidentic/model`.

  Token counts are always exact; USD figures are estimates — verify against your provider's current pricing page.

- 3a605b5: Add opt-in prompt caching (`AgentConfig.promptCache`). When `true`, each model call marks
  the stable system-prompt prefix as cacheable via the AI SDK's provider-options mechanism —
  Anthropic receives `cacheControl: { type: "ephemeral" }` on the system message; other
  providers ignore the hint gracefully. Cache hits are observable via `Usage.cachedInputTokens`
  and the OTel `kv_cache_hit_rate` attribute. Off by default; requests are byte-identical when
  the option is absent.
- 3a605b5: Add `@eidentic/model`: a `ModelPort` adapter over Vercel AI SDK v6 (non-streaming) that runs the agent loop against real Anthropic/OpenAI/Google models, plus `modelFromString("provider/model")`. Thread `toolName` through tool-result events/messages in `@eidentic/core` and `@eidentic/types` (required by AI SDK tool results).
- 3a605b5: Remove `modelFromString` / `parseModelString`. Construct models explicitly and bring your own provider package: `new AIModel(openai("gpt-4o"))`, `new AIModel(anthropic("claude-sonnet-4-5"))`, `new AIModel(deepseek("deepseek-chat"))` — any `@ai-sdk/*` provider works, with no hardcoded provider list. This is the canonical, fully provider-agnostic path (mirrors `AIEmbedder`). The optional `@ai-sdk/*` peerDependencies are dropped since the resolver no longer imports providers.
- 3a605b5: Token streaming: `ModelPort.stream()` (optional), `stream.delta` events from the agent loop, and `AIModel.stream()` over AI SDK v6 `streamText`. The loop prefers streaming when the model supports it and falls back to `complete()` otherwise.
- 3a605b5: Structured / schema-constrained output (D2): get a typed, validated object out of an agent.

  Pass `agent.query(input, { outputSchema })` a Zod schema (same convention as `createTool`'s `inputSchema`). The agent still runs its full multi-turn tool loop — only the **final** (tool-less) turn is constrained to the schema. The parsed, validated value is surfaced on the terminal `result` event as `result.object` (the raw text answer stays on `result.output`). If the model's structured answer fails validation, the run terminates with `subtype: "error"` describing the mismatch. Fully backward-compatible: omitting `outputSchema` leaves `query()` byte-identical.

  - **`@eidentic/types`**: `ModelRequest.outputSchema?` (JSON Schema over the port boundary) + `ModelResponse.object?`; the terminal `result` `StreamEvent` gains an optional `object?`.
  - **`@eidentic/model`**: `AIModel` forwards the schema to AI SDK v6 `generateText`/`streamText` via `experimental_output: Output.object(...)` (sets a JSON `responseFormat`) and returns the parsed object on `ModelResponse.object`.
  - **`@eidentic/core`**: `QueryOptions.outputSchema?` (Zod); the loop forwards the JSON Schema each turn and validates the final object against the source schema. Validation is authoritative (the JSON Schema is only a provider hint); when the port did not pre-parse, core parses the final text as JSON.

  Note (v1): structured output composes with the default ReAct loop; reasoning strategies and `resume()` do not thread `outputSchema` yet.

- 3a605b5: Fix studio Sessions/Trace view always showing "unknown" for every event; surface real model id in session.init.

  **Studio fix**: `SessionsView` was reading `event.type`/`event.content`/`event.output` — the stream-event shape — but the events endpoint returns `StoredEvent` objects (`{ id, sessionId, seq, kind, schemaVersion, payload, meta?, createdAt }`). Updated the component (and the local `StoredEvent` type in `api.ts`) to read `event.kind` for the label and `event.payload`/`event.meta` for per-kind summaries (user string, assistant text/tool_use blocks, tool_result toolName+output, other kinds as JSON snippet). `seq` is now shown in the row header.

  **ModelId flow**: `ModelPort` gains an optional `modelId?: string` field. `AIModel` sets `this.modelId` from the wrapped AI SDK `LanguageModel.modelId` (available when a static model is passed; undefined for resolver-based construction). `Agent` now resolves `config.modelId ?? config.model.modelId` for the `modelId` arg passed to `runTurn`/`resumeTurn`, so `session.init.model` carries the real provider model id (e.g. `"claude-sonnet-4-5"`) with zero config. When neither is set, behavior is byte-identical to before (`""`).

### Patch Changes

- 3a605b5: `AIModelOptions` is now derived from the AI SDK's `generateText` parameters via
  `Pick<Parameters<typeof generateText>[0], …>` instead of being hand-typed. Every exposed
  setting name (temperature, maxOutputTokens, topP, …) must exist on the installed SDK or it
  is a compile error — eliminating any chance of a renamed/removed setting being silently
  ignored at runtime. Public shape is unchanged.
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
  - @eidentic/types@0.1.0
