---
"@eidentic/types": minor
"@eidentic/model": minor
"@eidentic/cli": minor
"eidentic": minor
---

Bundled `defaultPrices` from LiteLLM + `cachedInputPerMTok` accurate cache pricing + opt-in `fetchLatestPrices()` + weekly CI refresh.

- **`@eidentic/types`**: `ModelPrice.cachedInputPerMTok` — optional price per million cached input tokens (KV-cache reads). When absent, cached tokens fall back to `inputPerMTok` (back-compat). `usdFor` now prices cached and non-cached input tokens separately.

- **`@eidentic/model`**: Ships a bundled, dated `defaultPrices: PriceTable` seeded from LiteLLM's `model_prices_and_context_window.json` (~550 entries across Anthropic, OpenAI, Gemini, DeepSeek, Mistral, xAI, Cohere). The library **never auto-fetches** at runtime — prices are static and offline-safe. Also exports `fetchLatestPrices(opts?)` (opt-in, schedule yourself), `mapLiteLLM(raw)` (pure mapping function), and `pricesUpdatedAt` (ISO date of last generation). A `gen:prices` package script + `scripts/gen-prices.ts` regenerate the table from LiteLLM.

- **`@eidentic/cli`**: The `eidentic init` scaffold now adds `prices: defaultPrices` to the generated Agent so `cost.usd` is populated out-of-the-box.

- **`eidentic`**: Re-exports `defaultPrices`, `pricesUpdatedAt`, `fetchLatestPrices`, `mapLiteLLM` from `@eidentic/model`.

Token counts are always exact; USD figures are estimates — verify against your provider's current pricing page.
