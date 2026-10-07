/**
 * Unit tests for the rate derivation from an OpenRouter response.
 *
 * Run: `npm run test` (part of `npm run check`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { EndpointPricing } from "./endpoint-pricing.ts";
import { deriveRealRates, effectiveBilledCost, ratesFromCostSplit } from "./rates.ts";

const pricing = (overrides: Partial<EndpointPricing> = {}): EndpointPricing => ({
  prompt: 0.05,
  completion: 1.2,
  cacheRead: 0.02,
  cacheWrite: 0.05,
  overrides: [],
  ...overrides,
});

test("effectiveBilledCost: credits use what OpenRouter charged", () => {
  assert.equal(effectiveBilledCost(0.5, 0.22, false), 0.5);
});

test("effectiveBilledCost: BYOK falls back to the provider invoice", () => {
  assert.equal(effectiveBilledCost(0, 0.22, true), 0.22, "OpenRouter charges nothing");
  assert.equal(effectiveBilledCost(null, 0.22, true), 0.22);
  assert.equal(effectiveBilledCost(0, null, true), 0, "nothing known but a valid free amount");
});

test("effectiveBilledCost: unusable input stays null", () => {
  assert.equal(effectiveBilledCost(null, null, false), null);
});

test("ratesFromCostSplit: exact rates without cached prompt tokens", () => {
  // 1000 uncached prompt tokens for $0.001, 200 completion tokens for $0.0004.
  const rates = ratesFromCostSplit(0.001, 0.0004, { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 }, null);
  assert.ok(rates);
  assert.equal(rates.input, 1, "0.001 USD per 1000 tokens = 1 USD per 1M");
  assert.equal(rates.output, 2);
  assert.equal(rates.factor, 1, "no price list -> no effective/listed factor");
});

test("ratesFromCostSplit: cached tokens are weighted by their price relation", () => {
  // cacheRead costs 0.4x the input price, cacheWrite 2x (pricing above).
  const tokens = { input: 500, output: 100, cacheRead: 1000, cacheWrite: 250 };
  const weighted = 500 + (0.02 / 0.05) * 1000 + (0.05 / 0.05) * 250;
  const promptCost = 0.002;

  const rates = ratesFromCostSplit(promptCost, 0.0002, tokens, pricing());
  assert.ok(rates);
  assert.equal(rates.input, (promptCost / weighted) * 1_000_000);
  assert.equal(rates.factor, rates.input / 0.05, "factor compares against the listed input price");
});

test("ratesFromCostSplit: cached tokens need prices to be weighted", () => {
  const tokens = { input: 10, output: 5, cacheRead: 100, cacheWrite: 0 };
  assert.equal(ratesFromCostSplit(0.001, 0.001, tokens, null), null);
  assert.equal(ratesFromCostSplit(0.001, 0.001, tokens, pricing({ prompt: 0 })), null);
});

test("ratesFromCostSplit: missing parts and empty buckets are rejected", () => {
  const tokens = { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 };
  assert.equal(ratesFromCostSplit(null, 0.001, tokens, null), null);
  assert.equal(ratesFromCostSplit(0.001, null, tokens, null), null);
  assert.equal(ratesFromCostSplit(0.001, 0.001, tokens, null), null, "no completion tokens");
  assert.equal(
    ratesFromCostSplit(0.001, 0.001, { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, null),
    null,
    "no prompt tokens",
  );
  assert.equal(ratesFromCostSplit(-1, 0.001, tokens, null), null);
});

test("deriveRealRates: splits the billed total by the endpoint prices", () => {
  const tokens = { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 };
  const modelled = 0.05 * 1 + 1.2 * 0.1; // = 0.17 USD
  const rates = deriveRealRates(modelled / 2, tokens, pricing());
  assert.ok(rates);
  assert.equal(rates.factor, 0.5);
  assert.equal(rates.input, 0.025, "half of the listed input price");
  assert.equal(rates.output, 0.6);
});

test("deriveRealRates: every billed bucket counts, cache included", () => {
  const tokens = { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 };
  const rates = deriveRealRates(0.01, tokens, pricing());
  assert.ok(rates);
  assert.equal(rates.factor, 0.5, "0.01 billed vs 0.02 modelled");
});

test("deriveRealRates: a free model with no charge is 0, not unknown", () => {
  const tokens = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 };
  assert.deepEqual(deriveRealRates(0, tokens, pricing({ prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 })), {
    input: 0,
    output: 0,
    factor: 1,
  });
});

test("deriveRealRates: without prices or with unusable input -> null", () => {
  const tokens = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 };
  assert.equal(deriveRealRates(0.01, tokens, null), null);
  assert.equal(deriveRealRates(null, tokens, pricing()), null);
  assert.equal(deriveRealRates(-1, tokens, pricing()), null);
  assert.equal(
    deriveRealRates(0.01, tokens, pricing({ prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0 })),
    null,
    "nothing modelled, but something was billed",
  );
});
