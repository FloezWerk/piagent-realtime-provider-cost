/**
 * Derives the effective per-1M-token rates of an OpenRouter call from the
 * *actually billed* amount.
 *
 * The generation API reports only the total cost, so the split between the
 * buckets comes from the serving provider's endpoint prices. Their absolute
 * level may differ from what was charged (discounts, peak overrides, price
 * changes), which is expressed as a single factor between modelled and billed
 * total. That factor is applied to both displayed buckets (input/output), so the
 * display reproduces the real invoice while keeping the correct in/out ratio.
 *
 * The modelled total must cover *every* billed bucket: cached prompt tokens are
 * billed too and dominate the invoice when the prompt is mostly a cache write
 * (first call after a context change). Leaving them out inflates the factor by
 * orders of magnitude - the cache buckets therefore count towards `modelled`
 * even though they are not displayed themselves.
 */

import type { EndpointPricing } from "./endpoint-pricing.ts";

export interface TokenBuckets {
  /** Uncached prompt tokens (OpenRouter: excludes cache read/write). */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface RealRates {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** Billed / modelled ratio (1 = prices matched the invoice exactly). */
  factor: number;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function deriveRealRates(
  totalCost: number | null,
  tokens: TokenBuckets,
  pricing: EndpointPricing | null,
): RealRates | null {
  if (!finite(totalCost) || !pricing) return null;
  if (!finite(tokens.input) || !finite(tokens.output)) return null;
  if (!finite(tokens.cacheRead) || !finite(tokens.cacheWrite)) return null;

  // Prices are USD per 1M tokens, the cost is USD for the actual token counts.
  // Every billed bucket (input, cache write, cache read, output) counts, even
  // though only input/output are displayed.
  const modelled =
    (pricing.prompt / 1e6) * tokens.input
    + (pricing.cacheWrite / 1e6) * tokens.cacheWrite
    + (pricing.cacheRead / 1e6) * tokens.cacheRead
    + (pricing.completion / 1e6) * tokens.output;

  if (!(modelled > 0)) {
    // Free model: the endpoint prices are 0, so there is no in/out ratio to
    // derive. When nothing was billed either, the effective rates are simply 0
    // (a missing rate would otherwise trigger a generation request per prompt).
    return totalCost === 0 ? { input: 0, output: 0, factor: 1 } : null;
  }

  const factor = totalCost / modelled;
  if (!Number.isFinite(factor) || factor < 0) return null;

  return {
    input: pricing.prompt * factor,
    output: pricing.completion * factor,
    factor,
  };
}
