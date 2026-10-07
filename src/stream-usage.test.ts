/**
 * Unit tests for the OpenRouter stream-chunk capture.
 *
 * Run: `npm run test` (part of `npm run check`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { StreamCallBuffer } from "./stream-usage.ts";

const chunk = (overrides: Record<string, unknown> = {}) => ({
  id: "gen-1",
  model: "deepseek/deepseek-v4.1-flash",
  provider: "Fireworks",
  ...overrides,
});

test("record: provider and response id come from any chunk", () => {
  const calls = new StreamCallBuffer();
  calls.record("model-a", chunk({ usage: undefined }));

  assert.deepEqual(calls.take("model-a"), {
    provider: "Fireworks",
    totalCost: null,
    upstreamCost: null,
    promptCost: null,
    completionsCost: null,
    byok: false,
    responseId: "gen-1",
  });
});

test("record: usage of the final chunk carries amount, split and BYOK", () => {
  const calls = new StreamCallBuffer();
  calls.record("model-a", chunk({
    usage: {
      cost: 0.00009032,
      is_byok: true,
      cost_details: {
        upstream_inference_cost: 0.00009032,
        upstream_inference_prompt_cost: 0.00008912,
        upstream_inference_completions_cost: 0.0000012,
      },
    },
  }));

  const call = calls.take("model-a");
  assert.ok(call);
  assert.equal(call.totalCost, 0.00009032);
  assert.equal(call.upstreamCost, 0.00009032);
  assert.equal(call.promptCost, 0.00008912);
  assert.equal(call.completionsCost, 0.0000012);
  assert.equal(call.byok, true);
});

test("record: later chunks only fill gaps, they never erase known values", () => {
  const calls = new StreamCallBuffer();
  calls.record("model-a", chunk({ provider: "Morph", usage: { cost: 0.5, is_byok: false } }));
  calls.record("model-a", chunk({ provider: undefined, id: undefined, usage: { cost_details: {} } }));

  const call = calls.take("model-a");
  assert.ok(call);
  assert.equal(call.provider, "Morph");
  assert.equal(call.responseId, "gen-1");
  assert.equal(call.totalCost, 0.5);
});

test("record: unusable chunks are ignored, models stay separate", () => {
  const calls = new StreamCallBuffer();
  calls.record("model-a", undefined);
  calls.record("model-a", { provider: "   " });
  assert.equal(calls.size(), 0, "nothing to store");

  calls.record("model-a", chunk());
  calls.record("model-b", chunk({ provider: "Novita" }));
  assert.equal(calls.size(), 2);
  assert.equal(calls.take("model-b")?.provider, "Novita");
  assert.equal(calls.take("model-a")?.provider, "Fireworks");
});

test("record: non-finite amounts are dropped", () => {
  const calls = new StreamCallBuffer();
  calls.record("model-a", chunk({ usage: { cost: Number.NaN, cost_details: { upstream_inference_cost: "0.1" } } }));

  const call = calls.take("model-a");
  assert.ok(call);
  assert.equal(call.totalCost, null);
  assert.equal(call.upstreamCost, null, "strings are not accepted");
});

test("take: consumes the entry, reset and clear drop it", () => {
  const calls = new StreamCallBuffer();
  calls.record("model-a", chunk());
  assert.ok(calls.take("model-a"), "first read returns the entry");
  assert.equal(calls.take("model-a"), null, "a consumed call is never reused");

  calls.record("model-a", chunk());
  calls.reset("model-a");
  assert.equal(calls.take("model-a"), null);

  calls.record("model-a", chunk());
  calls.clear();
  assert.equal(calls.size(), 0);
});
