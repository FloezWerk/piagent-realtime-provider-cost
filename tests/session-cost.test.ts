/**
 * Unit tests for the session-cost correction (pure logic, no Pi, no network).
 *
 * Run: `npm run test` (part of `npm run check`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { effectiveBilledCost } from "../src/rates.ts";
import {
  normalizeSessionCostBasis,
  patchedCost,
  sessionCostAmount,
  sessionCostAmountFor,
  type SessionCostOptions,
} from "../src/session-cost.ts";
import type { StreamCallInfo } from "../src/stream-usage.ts";

function call(overrides: Partial<StreamCallInfo> = {}): StreamCallInfo {
  return {
    provider: "Fireworks",
    totalCost: 0.5,
    upstreamCost: 0.22,
    promptCost: 0.1,
    completionsCost: 0.12,
    byok: false,
    responseId: "gen-1",
    ...overrides,
  };
}

const OPEN: SessionCostOptions = { enabled: true, lookup: true, basis: "upstream" };
const target = (overrides: Partial<{ provider: string; subscription: boolean }> = {}) => ({
  provider: "openrouter",
  subscription: false,
  ...overrides,
});

test("sessionCostAmount: credits call uses what OpenRouter charged", () => {
  assert.equal(sessionCostAmount(call(), "upstream"), 0.5);
  assert.equal(sessionCostAmount(call(), "openrouter"), 0.5);
});

test("sessionCostAmount: BYOK depends on the basis", () => {
  const byok = call({ byok: true, totalCost: 0 });
  assert.equal(sessionCostAmount(byok, "upstream"), 0.22, "provider bills your key");
  assert.equal(sessionCostAmount(byok, "openrouter"), 0, "OpenRouter charges nothing");
});

test("sessionCostAmount: free model is 0, not null", () => {
  assert.equal(sessionCostAmount(call({ totalCost: 0, upstreamCost: 0 }), "upstream"), 0);
});

test("sessionCostAmount: unusable amounts are null", () => {
  const none = call({ totalCost: null, upstreamCost: null });
  assert.equal(sessionCostAmount(none, "upstream"), null);
  assert.equal(sessionCostAmount(none, "openrouter"), null);
  assert.equal(sessionCostAmount(call({ totalCost: -1, upstreamCost: null }), "openrouter"), null);
  assert.equal(sessionCostAmount(call({ totalCost: Number.NaN }), "openrouter"), null);
});

test("effectiveBilledCost: upstream wins for BYOK, credits otherwise", () => {
  assert.equal(effectiveBilledCost(0.5, 0.22, false), 0.5);
  assert.equal(effectiveBilledCost(0, 0.22, true), 0.22);
  assert.equal(effectiveBilledCost(null, 0.22, false), 0.22);
});

test("sessionCostAmountFor: corrects an OpenRouter call with stream data", () => {
  assert.equal(sessionCostAmountFor(target(), call(), OPEN), 0.5);
});

test("sessionCostAmountFor: settings off disable the correction", () => {
  assert.equal(sessionCostAmountFor(target(), call(), { ...OPEN, enabled: false }), null);
  assert.equal(sessionCostAmountFor(target(), call(), { ...OPEN, lookup: false }), null);
});

test("sessionCostAmountFor: only OpenRouter and non-subscription models", () => {
  assert.equal(sessionCostAmountFor(target({ provider: "google" }), call(), OPEN), null);
  assert.equal(sessionCostAmountFor(target({ subscription: true }), call(), OPEN), null);
});

test("sessionCostAmountFor: without stream data (restored session) nothing happens", () => {
  assert.equal(sessionCostAmountFor(target(), null, OPEN), null);
  assert.equal(sessionCostAmountFor(target(), undefined, OPEN), null);
});

test("patchedCost: scales every bucket and sets the exact total", () => {
  const catalogue = {
    input: 0.0000366,
    output: 0.0000036,
    cacheRead: 0.000047616,
    cacheWrite: 0.000002,
    total: 0.000089816,
  };
  const billed = 0.00009032;
  const patched = patchedCost(catalogue, billed);
  assert.ok(patched);

  const factor = billed / catalogue.total;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    assert.equal(patched[key], catalogue[key] * factor, `${key} is scaled by the same factor`);
  }
  assert.equal(patched.total, billed, "total is the real amount, not a scaled float");
  const sum = patched.input + patched.output + patched.cacheRead + patched.cacheWrite;
  assert.ok(Math.abs(sum - billed) < 1e-15, "buckets sum to the total");
});

test("patchedCost: zero catalogue total still gets the real sum", () => {
  const patched = patchedCost(
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    0.25,
  );
  assert.deepEqual(patched, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 });
});

test("patchedCost: free model becomes 0 everywhere", () => {
  const patched = patchedCost({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, 0);
  assert.deepEqual(patched, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
});

test("patchedCost: negative and non-finite amounts are rejected", () => {
  const cost = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 };
  assert.equal(patchedCost(cost, -0.5), null);
  assert.equal(patchedCost(cost, Number.NaN), null);
  assert.equal(patchedCost(cost, Number.POSITIVE_INFINITY), null);
});

test("normalizeSessionCostBasis: accepts the two bases, case-insensitive", () => {
  assert.equal(normalizeSessionCostBasis("upstream"), "upstream");
  assert.equal(normalizeSessionCostBasis(" OpenRouter "), "openrouter");
  assert.equal(normalizeSessionCostBasis("bogus"), undefined);
  assert.equal(normalizeSessionCostBasis(undefined), undefined);
  assert.equal(normalizeSessionCostBasis(42), undefined);
});
