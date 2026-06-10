import type { PriceTable, ModelPrice } from "@eidentic/types";

export const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

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
] as const;

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

/**
 * Map a raw LiteLLM model_prices_and_context_window.json object to a PriceTable.
 * Pure function — usable in tests without any network calls.
 */
export function mapLiteLLM(raw: Record<string, unknown>): PriceTable {
  const out: PriceTable = {};

  for (const [key, val] of Object.entries(raw)) {
    if (!val || typeof val !== "object") continue;
    const entry = val as RawEntry;
    const prov = entry.litellm_provider ?? "";
    if (!TARGET_PROVIDERS.has(prov)) continue;

    const inputCost = entry.input_cost_per_token;
    const outputCost = entry.output_cost_per_token;
    if (inputCost == null || outputCost == null) continue;

    const priceEntry: ModelPrice = {
      inputPerMTok: roundPrice(inputCost * 1_000_000),
      outputPerMTok: roundPrice(outputCost * 1_000_000),
    };
    if (entry.cache_read_input_token_cost != null) {
      priceEntry.cachedInputPerMTok = roundPrice(entry.cache_read_input_token_cost * 1_000_000);
    }

    out[key] = priceEntry;

    // Also store a provider-stripped bare key so a bare modelId (e.g. "gemini-1.5-pro") matches.
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

/**
 * Fetch the latest prices live from LiteLLM (opt-in — schedule it yourself;
 * the library never auto-fetches at runtime).
 */
export async function fetchLatestPrices(opts?: {
  fetchImpl?: typeof fetch;
  url?: string;
}): Promise<PriceTable> {
  const fetchFn = opts?.fetchImpl ?? fetch;
  const url = opts?.url ?? LITELLM_URL;

  let res: Response;
  try {
    res = await fetchFn(url);
  } catch (e) {
    throw new Error(
      `fetchLatestPrices: network request to ${url} failed — ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`fetchLatestPrices: HTTP ${res.status} ${res.statusText} from ${url}`);
  }

  let raw: Record<string, unknown>;
  try {
    raw = (await res.json()) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `fetchLatestPrices: failed to parse JSON from ${url} — ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return mapLiteLLM(raw);
}
