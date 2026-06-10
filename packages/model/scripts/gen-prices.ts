/**
 * Script: generate packages/model/src/prices.ts from LiteLLM pricing JSON.
 * Run via: pnpm --filter @eidentic/model gen:prices
 */

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "../src/prices.ts");

// Reuse mapLiteLLM from the shared module — but we can't import src directly
// (types not built yet in CI), so we inline the same logic here and keep it in sync.
// The canonical reusable version is exported from packages/model/src/prices.ts.

const TARGET_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "gemini",
  "deepseek",
  "mistral",
  "xai",
  "cohere",
  "vertex_ai-anthropic_models",
  "vertex_ai-language-models",
  "vertex_ai-mistral_models",
]);

const STRIP_PREFIXES = [
  "gemini/",
  "vertex_ai/",
  "anthropic/",
  "openai/",
  "xai/",
  "cohere/",
  "mistral/",
  "deepseek/",
];

function roundPrice(v: number): number {
  if (v === 0) return 0;
  const mag = Math.floor(Math.log10(Math.abs(v)));
  const factor = Math.pow(10, 5 - mag);
  return Math.round(v * factor) / factor;
}

type RawEntry = {
  litellm_provider?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  [k: string]: unknown;
};

type PriceEntry = { inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok?: number };

function mapJson(raw: Record<string, unknown>): Record<string, PriceEntry> {
  const out: Record<string, PriceEntry> = {};

  for (const [key, val] of Object.entries(raw)) {
    if (!val || typeof val !== "object") continue;
    const entry = val as RawEntry;
    const prov = entry.litellm_provider ?? "";
    if (!TARGET_PROVIDERS.has(prov)) continue;

    const inputCost = entry.input_cost_per_token;
    const outputCost = entry.output_cost_per_token;
    if (inputCost == null || outputCost == null) continue;

    const priceEntry: PriceEntry = {
      inputPerMTok: roundPrice(inputCost * 1_000_000),
      outputPerMTok: roundPrice(outputCost * 1_000_000),
    };
    if (entry.cache_read_input_token_cost != null) {
      priceEntry.cachedInputPerMTok = roundPrice(entry.cache_read_input_token_cost * 1_000_000);
    }

    out[key] = priceEntry;

    // Also store provider-stripped bare key for easy modelId matching
    for (const prefix of STRIP_PREFIXES) {
      if (key.startsWith(prefix)) {
        const bare = key.slice(prefix.length);
        if (!(bare in out)) out[bare] = priceEntry;
        break;
      }
    }
  }

  return out;
}

function renderTs(entries: Record<string, PriceEntry>, updatedAt: string): string {
  const lines: string[] = [];
  for (const [key, val] of Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))) {
    const safeKey = key.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const parts = [`inputPerMTok: ${val.inputPerMTok}`, `outputPerMTok: ${val.outputPerMTok}`];
    if (val.cachedInputPerMTok !== undefined) parts.push(`cachedInputPerMTok: ${val.cachedInputPerMTok}`);
    lines.push(`  "${safeKey}": { ${parts.join(", ")} },`);
  }

  return [
    "// Generated from LiteLLM model_prices_and_context_window.json. Approximate — verify against your",
    "// provider's current pricing. Token usage is always exact; USD is an estimate.",
    "// Do not edit by hand — run `pnpm --filter @eidentic/model gen:prices` to regenerate.",
    "",
    'import type { PriceTable } from "@eidentic/types";',
    "",
    `export const pricesUpdatedAt = "${updatedAt}";`,
    "",
    "export const defaultPrices: PriceTable = {",
    ...lines,
    "};",
    "",
  ].join("\n");
}

async function main() {
  console.log(`Fetching ${LITELLM_URL} ...`);
  const res = await fetch(LITELLM_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const raw = (await res.json()) as Record<string, unknown>;

  const entries = mapJson(raw);
  const updatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");

  console.log(`Mapped ${Object.keys(entries).length} entries`);

  const ts = renderTs(entries, updatedAt);
  writeFileSync(OUT, ts, "utf8");
  console.log(`Written ${ts.length} bytes → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
