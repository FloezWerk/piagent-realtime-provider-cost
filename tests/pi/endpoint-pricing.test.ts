/**
 * On-demand tests for the provider price lists (`npm run test:pi`): tier
 * selection, parsing of the OpenRouter endpoint answer, the 24h cache and the
 * failure handling. Requests are stubbed, nothing leaves the machine.
 *
 * The module caches the file in memory, so the order matters: the stale-cache
 * case comes first, everything else works with the cache afterwards.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { SKIP } from "./agent-dir.ts";

const dir = mkdtempSync(join(tmpdir(), "provider-cost-endpoints-"));
process.env.PI_CODING_AGENT_DIR = dir;
const FILE = join(dir, "realtime-provider-cost", "endpoint-pricing.json");
const DAY_MS = 24 * 60 * 60 * 1000;

// A stale cache: its entry is older than the TTL, so it must be refetched.
mkdirSync(dirname(FILE), { recursive: true });
writeFileSync(
  FILE,
  JSON.stringify({
    version: 3,
    models: { "stale/model": { fetchedAt: Date.now() - 2 * DAY_MS, providers: { Old: { prompt: 1, completion: 2 } } } },
  }),
  "utf8",
);

const pricing = await import("../../src/endpoint-pricing.ts").catch(() => null);

const readCache = () => JSON.parse(readFileSync(FILE, "utf8"));

/** The OpenRouter `/models/<slug>/endpoints` answer shape (per-token USD). */
const endpointsBody = {
  data: {
    endpoints: [
      {
        provider_name: "Fireworks",
        pricing: {
          prompt: "0.0000002",
          completion: "0.0000012",
          input_cache_read: "0.0000001",
          overrides: [
            { min_prompt_tokens: 32000, prompt: "0.0000004", completion: "0.0000024" },
            { min_prompt_tokens: 128000, prompt: "0.0000008", completion: "0.0000048", input_cache_read: "0.0000004" },
          ],
        },
      },
      { provider_name: "Morph", pricing: { prompt: 0.0000003, completion: 0.000001 } },
      { provider_name: "Fireworks", pricing: { prompt: 9, completion: 9 } },
      { provider_name: "", pricing: { prompt: 1, completion: 1 } },
      { provider_name: "Broken", pricing: { prompt: "nope" } },
    ],
  },
};

const stubFetch = (body: unknown, status = 200, calls: { url: string; auth?: string }[] = []) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") ?? undefined });
    return new Response(status === 200 ? JSON.stringify(body) : "nope", { status });
  }) as typeof fetch;

/** Prices travel as per-token strings: compare with a tolerance. */
function near(actual: number | undefined, expected: number): void {
  assert.ok(typeof actual === "number", `expected a number, got ${actual}`);
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
}

after(() => rmSync(dir, { recursive: true, force: true }));

test("pricingForPromptTokens: base prices, the reached tier, or the highest one", { skip: SKIP }, async () => {
  assert.ok(pricing);
  const base = pricing.pricingForPromptTokens(
    { prompt: 1, completion: 2, cacheRead: 0.5, cacheWrite: 1, overrides: [] },
    999_999,
  );
  assert.deepEqual(base, { prompt: 1, completion: 2, cacheRead: 0.5, cacheWrite: 1, overrides: [] });

  const tiered = {
    prompt: 0.2,
    completion: 1.2,
    cacheRead: 0.1,
    cacheWrite: 0.2,
    overrides: [
      { minPromptTokens: 32_000, prompt: 0.4, completion: 2.4, cacheRead: 0.1, cacheWrite: 0.2 },
      { minPromptTokens: 128_000, prompt: 0.8, completion: 4.8, cacheRead: 0.4, cacheWrite: 0.8 },
    ],
  };

  assert.equal(pricing.pricingForPromptTokens(tiered, 31_999).prompt, 0.2, "below the first threshold");
  assert.equal(pricing.pricingForPromptTokens(tiered, 32_000).prompt, 0.4, "threshold reached");
  assert.equal(pricing.pricingForPromptTokens(tiered, 200_000).prompt, 0.8, "highest reached tier wins");
  assert.deepEqual(pricing.pricingForPromptTokens(tiered, 200_000).overrides, [], "tiers are not nested");
});

test("getProviderPricing: a stale cache entry is refetched", { skip: SKIP }, async () => {
  assert.ok(pricing);
  const calls: { url: string; auth?: string }[] = [];
  const map = await pricing.getProviderPricing("stale/model", undefined, stubFetch(endpointsBody, 200, calls));
  assert.ok(map);

  assert.equal(calls.length, 1, "the cached entry was too old");
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/models/stale/model/endpoints");
  assert.equal(calls[0].auth, undefined, "the endpoint list is public: no key is resolved for it");
  assert.deepEqual([...map.keys()], ["Fireworks", "Morph"], "first entry per provider wins, invalid ones are skipped");
});

test("getProviderPricing: per-token prices become per-1M, cache prices fall back", { skip: SKIP }, async () => {
  assert.ok(pricing);
  const map = await pricing.getProviderPricing("stale/model", undefined, stubFetch(endpointsBody));
  assert.ok(map);

  const fireworks = map.get("Fireworks");
  assert.ok(fireworks);
  near(fireworks.prompt, 0.2);
  near(fireworks.completion, 1.2);
  near(fireworks.cacheRead, 0.1);
  near(fireworks.cacheWrite, 0.2);
  assert.deepEqual(fireworks.overrides.map((tier) => tier.minPromptTokens), [32_000, 128_000]);
  near(fireworks.overrides[1].cacheWrite, 0.2);

  const morph = map.get("Morph");
  near(morph?.prompt, 0.3);
  near(morph?.cacheRead, 0.3);
});

test("getProviderPricing: the answer is persisted and reused", { skip: SKIP }, async () => {
  assert.ok(pricing);
  await pricing.getProviderPricing("stale/model", undefined, stubFetch(endpointsBody));
  await new Promise((done) => setTimeout(done, 50));

  const cached = readCache();
  assert.equal(cached.version, 3);
  assert.ok(cached.models["stale/model"].providers.Fireworks);
  assert.ok(Date.now() - cached.models["stale/model"].fetchedAt < DAY_MS);

  const calls: { url: string }[] = [];
  const offline = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  const reused = await pricing.getProviderPricing("stale/model", "test-key", offline);
  assert.equal(calls.length, 0);
  near(reused?.get("Fireworks")?.prompt, 0.2);
});

test("getProviderPricing: unusable answers fall back to the cache, unknown models are null", { skip: SKIP }, async () => {
  assert.ok(pricing);
  const cached = await pricing.getProviderPricing("stale/model", undefined, stubFetch({ data: { endpoints: [] } }));
  assert.equal(cached?.size, 2, "an empty answer keeps the cached price list");

  assert.equal(
    await pricing.getProviderPricing("third/model", undefined, stubFetch(endpointsBody, 500)),
    null,
    "no cache entry and a failing request",
  );

  const calls: { url: string; auth?: string }[] = [];
  const withKey = await pricing.getProviderPricing("other/model", "test-key", stubFetch(endpointsBody, 200, calls));
  assert.equal(calls[0].auth, "Bearer test-key", "a key is sent when the caller already has one");
  assert.equal(withKey?.size, 2);

  assert.equal(
    await pricing.getProviderPricing("fourth/model", undefined, stubFetch({ nope: true })),
    null,
    "malformed body without a cache entry",
  );
});

test("clearPricingCache: empties the cache and persists it", { skip: SKIP }, async () => {
  assert.ok(pricing);
  pricing.clearPricingCache();
  await new Promise((done) => setTimeout(done, 50));
  assert.deepEqual(readCache().models, {});

  const offline = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  assert.equal(await pricing.getProviderPricing("stale/model", undefined, offline), null);
});
