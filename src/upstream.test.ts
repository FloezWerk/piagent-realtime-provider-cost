/**
 * Unit tests for the generation-API lookup (restored session only). The request
 * is stubbed, so nothing leaves the machine.
 *
 * Run: `npm run test` (part of `npm run check`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { lookupOpenRouterGeneration } from "./upstream.ts";

interface Call {
  url: string;
  authorization: string | undefined;
}

/** fetch stub that answers with `body`/`status` and records the request. */
function stubFetch(body: unknown, status = 200): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), authorization: headers.get("authorization") ?? undefined });
    return new Response(status === 200 ? JSON.stringify(body) : "nope", { status });
  }) as typeof fetch;
  return { impl, calls };
}

test("lookupOpenRouterGeneration: parses provider, costs and BYOK", async () => {
  const { impl, calls } = stubFetch({
    data: {
      provider_name: "Fireworks",
      total_cost: 0.00009032,
      upstream_inference_cost: 0.00009032,
      is_byok: false,
    },
  });

  const info = await lookupOpenRouterGeneration("gen-1", { apiKey: "test-key", fetchImpl: impl });
  assert.deepEqual(info, {
    providerName: "Fireworks",
    totalCost: 0.00009032,
    upstreamCost: 0.00009032,
    byok: false,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/generation\?id=gen-1$/);
  assert.equal(calls[0].authorization, "Bearer test-key");
});

test("lookupOpenRouterGeneration: encodes the id and reads the nested upstream cost", async () => {
  const { impl, calls } = stubFetch({
    data: { provider_name: "  Morph  ", cost_details: { upstream_inference_cost: 0.5 }, is_byok: true },
  });

  const info = await lookupOpenRouterGeneration("gen a/b", { apiKey: "k", fetchImpl: impl });
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/generation?id=gen%20a%2Fb");
  assert.equal(info?.providerName, "Morph");
  assert.equal(info?.upstreamCost, 0.5);
  assert.equal(info?.byok, true);
  assert.equal(info?.totalCost, null);
});

test("lookupOpenRouterGeneration: unusable answers are null", async () => {
  assert.equal(await lookupOpenRouterGeneration("gen-1", { apiKey: "k", fetchImpl: stubFetch({}).impl }), null);
  assert.equal(
    await lookupOpenRouterGeneration("gen-1", { apiKey: "k", fetchImpl: stubFetch({ data: "nope" }).impl }),
    null,
  );
  assert.equal(
    await lookupOpenRouterGeneration("gen-1", { apiKey: "k", fetchImpl: stubFetch({ data: {} }, 500).impl }),
    null,
    "HTTP errors are not fatal, they just yield nothing",
  );
});

test("lookupOpenRouterGeneration: network failures are swallowed", async () => {
  const throwing = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;

  assert.equal(await lookupOpenRouterGeneration("gen-1", { apiKey: "k", fetchImpl: throwing }), null);
});
