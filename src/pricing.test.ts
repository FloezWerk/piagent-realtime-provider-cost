/**
 * Unit tests for the snapshot extraction and the deviation colouring.
 *
 * Run: `npm run test` (part of `npm run check`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_DEVIATION_THRESHOLDS,
  deviationColorSpec,
  normalizeProviderTag,
  snapshotFromBranch,
  snapshotFromMessage,
  snapshotFromModel,
  upstreamTag,
  type ModelRegistryLike,
} from "./pricing.ts";

/** Registry facade stub: `find` returns the entry for `provider/model`. */
function registry(
  models: Record<string, unknown> = {},
  oauth: string[] = [],
): ModelRegistryLike {
  return {
    find: (provider: string, modelId: string) => models[`${provider}/${modelId}`],
    isUsingOAuth: (model: unknown) => oauth.includes(String(model)),
  };
}

function assistant(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    provider: "openrouter",
    model: "deepseek/deepseek-v4.1-flash",
    usage: {
      input: 1000,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0.05, output: 0.24, cacheRead: 0, cacheWrite: 0, total: 0.29 },
    },
    ...overrides,
  };
}

test("snapshotFromMessage: derives effective rates from the message cost", () => {
  const snapshot = snapshotFromMessage(assistant(), registry());
  assert.ok(snapshot);
  assert.equal(snapshot.inputUsdPerMillion, 50, "0.05 USD per 1000 tokens = 50 per 1M");
  assert.equal(snapshot.outputUsdPerMillion, 1200);
  assert.equal(snapshot.requestModel, "deepseek/deepseek-v4.1-flash");
  assert.equal(snapshot.providerSource, null, "the serving provider is resolved later");
  assert.equal(snapshot.ratesFromApi, false);
  assert.equal(snapshot.cataloguePreview, false);
});

test("snapshotFromMessage: response model wins for display, request model for lookups", () => {
  const snapshot = snapshotFromMessage(
    assistant({ responseModel: "deepseek/deepseek-v4.1-flash-20260101" }),
    registry(),
  );
  assert.ok(snapshot);
  assert.equal(snapshot.model, "deepseek/deepseek-v4.1-flash-20260101");
  assert.equal(snapshot.requestModel, "deepseek/deepseek-v4.1-flash");
});

test("snapshotFromMessage: catalogue prices come from the registry", () => {
  const snapshot = snapshotFromMessage(
    assistant(),
    registry({
      "openrouter/deepseek/deepseek-v4.1-flash": { cost: { input: 0.05, output: 1.2 } },
    }),
  );
  assert.ok(snapshot);
  assert.equal(snapshot.catalogueInputUsdPerMillion, 0.05);
  assert.equal(snapshot.catalogueOutputUsdPerMillion, 1.2);
});

test("snapshotFromMessage: a registry that throws does not break the snapshot", () => {
  const broken: ModelRegistryLike = {
    find: () => {
      throw new Error("registry unavailable");
    },
    isUsingOAuth: () => false,
  };
  const snapshot = snapshotFromMessage(assistant(), broken);
  assert.ok(snapshot);
  assert.equal(snapshot.catalogueInputUsdPerMillion, null);
});

test("snapshotFromMessage: unusable messages are rejected", () => {
  assert.equal(snapshotFromMessage(undefined, registry()), null);
  assert.equal(snapshotFromMessage({ role: "user" }, registry()), null);
  assert.equal(snapshotFromMessage(assistant({ stopReason: "error" }), registry()), null);
  assert.equal(snapshotFromMessage(assistant({ stopReason: "aborted" }), registry()), null);
  assert.equal(
    snapshotFromMessage(assistant({
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }), registry()),
    null,
    "no tokens billed",
  );
});

test("snapshotFromMessage: subscription providers are flagged", () => {
  const kimi = snapshotFromMessage(assistant({ provider: "kimi-coding" }), registry());
  assert.equal(kimi?.subscription, true, "kimi-coding is subscription-backed");

  const oauth = snapshotFromMessage(
    assistant({ provider: "anthropic", model: "claude" }),
    registry({ "anthropic/claude": { id: "claude" } }, ["[object Object]"]),
  );
  assert.equal(oauth?.subscription, true, "OAuth model is subscription-backed");

  const plain = snapshotFromMessage(assistant(), registry());
  assert.equal(plain?.subscription, false);
});

test("snapshotFromModel: catalogue preview without a serving provider", () => {
  const snapshot = snapshotFromModel(
    { provider: "openrouter", id: "z-ai/glm-5.3-flash", cost: { input: 0.06, output: 0.4 } },
    registry(),
  );
  assert.ok(snapshot);
  assert.equal(snapshot.cataloguePreview, true);
  assert.equal(snapshot.inputUsdPerMillion, 0.06);
  assert.equal(snapshot.responseId, null);
  assert.equal(upstreamTag(snapshot), null, "no tag while the provider is unknown");

  assert.equal(snapshotFromModel({ provider: "openrouter" }, registry()), null);
  assert.equal(snapshotFromModel(undefined, registry()), null);
});

test("snapshotFromBranch: scans backwards for the last usable assistant message", () => {
  const entries = [
    { type: "message", message: { role: "user" } },
    { type: "message", message: assistant({ stopReason: "aborted" }) },
    { type: "message", message: assistant({ model: "z-ai/glm-5.3-flash" }) },
    { type: "message", message: { role: "user" } },
  ];
  const snapshot = snapshotFromBranch(entries, registry());
  assert.ok(snapshot);
  assert.equal(snapshot.requestModel, "z-ai/glm-5.3-flash");
  assert.equal(snapshotFromBranch([], registry()), null);
  assert.equal(snapshotFromBranch([{ type: "message", message: { role: "user" } }], registry()), null);
});

test("normalizeProviderTag: three letters, capitalised", () => {
  assert.equal(normalizeProviderTag("Fireworks"), "Fir");
  assert.equal(normalizeProviderTag("  novita "), "Nov");
  assert.equal(normalizeProviderTag("Sail Research"), "Sai");
  assert.equal(normalizeProviderTag(""), "");
});

test("upstreamTag: only OpenRouter with a known provider", () => {
  const base = snapshotFromMessage(assistant(), registry());
  assert.ok(base);
  assert.equal(upstreamTag(base), null, "provider still unknown");

  base.upstreamProvider = "Fireworks";
  assert.equal(upstreamTag(base), "Fir");

  base.provider = "google";
  assert.equal(upstreamTag(base), null, "other providers show no tag");
});

test("deviationColorSpec: colours by deviation from the catalogue price", () => {
  const catalogue = 1;
  assert.equal(deviationColorSpec(1, catalogue), null, "same price keeps the base colour");
  assert.equal(deviationColorSpec(0.5, catalogue), "green", "much cheaper");
  assert.equal(deviationColorSpec(1.05, catalogue), "yellow");
  assert.equal(deviationColorSpec(1.15, catalogue), "orange");
  assert.equal(deviationColorSpec(1.5, catalogue), "red");
});

test("deviationColorSpec: unknown prices and thresholds", () => {
  assert.equal(deviationColorSpec(null, 1), null);
  assert.equal(deviationColorSpec(1, null), null);
  assert.equal(deviationColorSpec(1, 0), null, "no catalogue price to compare with");
  assert.equal(deviationColorSpec(Number.NaN, 1), null);

  assert.equal(deviationColorSpec(0.95, 1, { ...DEFAULT_DEVIATION_THRESHOLDS, green: 0 }), "green");
  assert.equal(deviationColorSpec(1.5, 1, { green: 10, yellow: 100, orange: 200 }), "yellow");
});
