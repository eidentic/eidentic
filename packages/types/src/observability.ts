import type { Usage } from "./protocol.js";

// --- Cost accounting (§11.2) ---

/**
 * Transparent per-run cost accounting. `foreground` is the interactive loop's token usage;
 * `background` is reserved for memory consolidation / skill evolution (§6.5/§7.7) — always
 * {0,0} from the v1 loop. `cachedInputTokens` is provider-reported KV-cached input (0 when the
 * model does not report it). `usd` is computed only when a `PriceTable` is configured.
 */
export interface CostBreakdown {
  foreground: Usage;
  background: Usage;
  cachedInputTokens: number;
  /**
   * Aggregated token usage of all spawned sub-agents in this run's tree (§8.6). Absent for
   * single-agent runs. Kept separate from `foreground` so tree cost is transparent and the
   * parent's own usage stays distinguishable from delegated work (Constitution #5).
   */
  children?: Usage;
  usd?: number;
}

/** USD price per 1,000,000 tokens, by direction. */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  /**
   * Price per 1,000,000 CACHED input tokens (provider KV-cache reads).
   * Typically ~10% of inputPerMTok. When absent, cached tokens are billed at inputPerMTok.
   */
  cachedInputPerMTok?: number;
}

/** Price table keyed by model id (e.g. "claude-haiku-4"). */
export type PriceTable = Record<string, ModelPrice>;

/**
 * Hard ceilings + a soft cap, enforced by the governor *before each model call* (§11.2).
 * Any hard ceiling met-or-exceeded aborts the run with the matching `TerminationSubtype`.
 * `softCostUsd`, once crossed, fires `onCostThreshold` exactly once and does NOT abort.
 * `maxCostUsd` / `softCostUsd` require a `PriceTable` to be meaningful (usd is undefined otherwise).
 */
export interface CostPolicy {
  /** Model round-trips. Defaults to 16 when neither this nor the legacy `maxTurns` arg is set. */
  maxTurns?: number;
  /** Total input+output tokens across the run. */
  maxTokens?: number;
  /** Total spend in USD; requires a PriceTable. */
  maxCostUsd?: number;
  /** Elapsed wall-clock in milliseconds (uses the injected monotonic clock). */
  maxWallClockMs?: number;
  /** Soft cap: crossing it fires onCostThreshold once; does NOT abort. Requires a PriceTable. */
  softCostUsd?: number;
}

/** Payload handed to the soft-cap hook when `softCostUsd` is first crossed. */
export interface CostThresholdInfo {
  usd: number;
  cost: CostBreakdown;
  numTurns: number;
}

// --- Tracing (§11.1) — minimal, OTel-shaped, swappable ---

export interface Span {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: "ok" | "error", message?: string): void;
  end(): void;
}

export interface TracerPort {
  startSpan(name: string, attributes?: Record<string, string | number | boolean>): Span;
}
