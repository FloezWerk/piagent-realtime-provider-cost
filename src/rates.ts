/**
 * Derives the effective per-1M-token rates of an OpenRouter call from the
 * *actually billed* amount.
 *
 * Two sources, preferred in this order:
 *
 * 1. `ratesFromCostSplit` - the prompt/completion split the response itself
 *    reports (`usage.cost_details.upstream_inference_prompt_cost` /
 *    `_completions_cost`). It is the provider-side invoice, so the rates are
 *    exact and available with the response; only cached prompt tokens need the
 *    provider's cache prices (as a relation, not as an absolute level).
 * 2. `deriveRealRates` - the billed total, split by the serving provider's
 *    endpoint prices. Needed for responses without that split (generation API,
 *    older Pi) and for cached prompt tokens without known cache prices.
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

/**
 * Amount a generation actually cost *you*, in USD.
 *
 * OpenRouter bills two disjoint ways:
 * - credits: `totalCost` is the amount charged by OpenRouter (its own price for
 *   the routed provider, including discounts and tiers).
 * - BYOK (`is_byok`): the request runs on your own provider key, so OpenRouter
 *   charges nothing (`totalCost === 0`) and the provider bills you directly -
 *   the amount is `upstreamCost` (`upstream_inference_cost`, nested under
 *   `cost_details` in the streamed usage).
 *
 * Without this split every BYOK generation resolves to a factor of 0 and is
 * displayed as `$0/$0`. `0` is a valid amount for free models, hence the
 * fallbacks instead of a plain null.
 */
export function effectiveBilledCost(
  totalCost: number | null,
  upstreamCost: number | null,
  byok: boolean,
): number | null {
  if (byok && upstreamCost !== null) return upstreamCost;
  if (totalCost !== null && totalCost > 0) return totalCost;
  return upstreamCost ?? totalCost;
}

/**
 * Rates from the prompt/completion split of a response.
 *
 * `promptCost` covers *every* prompt token (a cache read is already priced into
 * it), so cached tokens are weighted by their price relation to the input price
 * before the uncached input rate can be divided out. Only those *relations* come
 * from `pricing` - the level itself is the invoice, so discounts, tiers and BYOK
 * pricing need no correction factor here.
 *
 * `pricing` may be null while no cached prompt token was billed: both rates are
 * then exact without any price list. Returns null when the split is unusable
 * (missing part, no tokens to divide by, cached tokens without prices to weight
 * them) - the caller then falls back to `deriveRealRates`.
 */
export function ratesFromCostSplit(
  promptCost: number | null,
  completionsCost: number | null,
  tokens: TokenBuckets,
  pricing: EndpointPricing | null,
): RealRates | null {
  if (!finite(promptCost) || !finite(completionsCost)) return null;
  if (!finite(tokens.input) || !finite(tokens.output)) return null;
  if (!finite(tokens.cacheRead) || !finite(tokens.cacheWrite)) return null;
  if (!(tokens.output > 0)) return null;

  // Weights of the cached buckets relative to one uncached prompt token.
  let weightedPrompt = tokens.input;
  if (tokens.cacheRead > 0 || tokens.cacheWrite > 0) {
    if (!pricing || !(pricing.prompt > 0)) return null;
    weightedPrompt += (pricing.cacheRead / pricing.prompt) * tokens.cacheRead;
    weightedPrompt += (pricing.cacheWrite / pricing.prompt) * tokens.cacheWrite;
  }
  if (!(weightedPrompt > 0)) return null;

  const input = (promptCost / weightedPrompt) * 1_000_000;
  const output = (completionsCost / tokens.output) * 1_000_000;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;

  return {
    input,
    output,
    // Effective vs. listed input price (1 = the invoice matched the price list).
    factor: pricing && pricing.prompt > 0 ? input / pricing.prompt : 1,
  };
}

/**
 * Rates from a billed total, split by the serving provider's endpoint prices.
 *
 * Needed when a response carries no prompt/completion split (generation API,
 * older Pi, session restore): such a call reports one total amount only
 * (OpenRouter credits or, for BYOK, the upstream invoice - see
 * `effectiveBilledCost`). The absolute level of the endpoint prices may differ
 * from what was charged (discounts, peak overrides, price changes), which is
 * expressed as a single factor between modelled and billed total. That factor is
 * applied to both displayed buckets, so the display reproduces the real invoice
 * while keeping the correct in/out ratio.
 */
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
