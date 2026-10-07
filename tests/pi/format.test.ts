/**
 * On-demand tests for the status text (`npm run test:pi`): the module renders the
 * currency symbols of `currency.ts`, which needs the Pi packages.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { SKIP, cleanup } from "./agent-dir.ts";

const format = await import("../../src/format.ts").catch(() => null);
const pricing = await import("../../src/pricing.ts").catch(() => null);

after(() => cleanup());

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 12,
    catalogueInputUsdPerMillion: 2,
    catalogueOutputUsdPerMillion: 12,
    provider: "openrouter",
    model: "deepseek/deepseek-v4.1-flash",
    requestModel: "deepseek/deepseek-v4.1-flash",
    responseId: null,
    upstreamProvider: null,
    providerSource: null,
    byok: false,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ratesFromApi: false,
    cataloguePreview: false,
    subscription: false,
    ...overrides,
  } as never;
}

test("formatPrice: currency symbols, trailing zeros and unknown values", { skip: SKIP }, async () => {
  assert.ok(format);
  assert.equal(format.formatPrice(2, "USD", 1), "$2");
  assert.equal(format.formatPrice(12.5, "USD", 1), "$12.5");
  assert.equal(format.formatPrice(0.2896123, "USD", 1), "$0.2896", "at most 4 decimals");
  assert.equal(format.formatPrice(0.0000001, "USD", 1), "$0", "tiny values round to 0");
  assert.equal(format.formatPrice(2, "EUR", 0.8), "€1.6");
  assert.equal(format.formatPrice(2, "JPY", 150), "¥300");
  assert.equal(format.formatPrice(2, "CHF", 0.9), "CHF 1.8");
  assert.equal(format.formatPrice(null, "USD", 1), "?");
  assert.equal(format.formatPrice(2, "USD", null), "?", "no FX rate");
  // Non-finite rates never reach this point (`rate()` in pricing.ts filters them);
  // if one does, the number renders as `?` behind the symbol.
  assert.equal(format.formatPrice(Number.NaN, "USD", 1), "$?");
});

test("roundToDisplay: absorbs float noise at the displayed precision", { skip: SKIP }, async () => {
  assert.ok(format);
  assert.equal(format.roundToDecimals(0.20000000000000004), 0.2);
  assert.equal(format.roundToDecimals(1.00004), 1.0);

  assert.equal(format.roundToDisplay(0.20000000000000004, 1), 0.2);
  assert.equal(format.roundToDisplay(0.20000000000000004, null), 0.20000000000000004, "no rate: untouched");
  assert.equal(format.roundToDisplay(0.20000000000000004, 0), 0.20000000000000004, "invalid rate: untouched");
  assert.equal(format.roundToDisplay(Number.NaN, 1), Number.NaN);
});

test("composeStatus: icons, numbers and the provider tag", { skip: SKIP }, async () => {
  assert.ok(format);
  assert.equal(format.composeStatus(snapshot(), "USD", 1, "nerd"), "\u2191$2/\u2193$12");
  assert.equal(format.composeStatus(snapshot(), "USD", 1, "ascii"), "in:$2/out:$12");

  const withProvider = snapshot({ upstreamProvider: "Fireworks" });
  assert.equal(format.composeStatus(withProvider, "USD", 1, "nerd"), "\u2191$2/\u2193$12 (Fir)");
  assert.equal(
    format.composeStatus(snapshot({ upstreamProvider: "Fireworks", byok: true }), "USD", 1, "nerd"),
    "\u2191$2/\u2193$12 (Fir\u{1F511})",
    "BYOK marker inside the tag",
  );
  assert.equal(
    format.composeStatus(snapshot({ upstreamProvider: "Fireworks", byok: true }), "USD", 1, "ascii"),
    "in:$2/out:$12 (Fir*)",
  );
});

test("composeStatus: catalogue preview shows `?`, other providers no tag", { skip: SKIP }, async () => {
  assert.ok(format);
  assert.equal(
    format.composeStatus(snapshot({ cataloguePreview: true }), "USD", 1, "nerd"),
    "\u2191$2/\u2193$12 (?)",
    "model just switched: the serving provider is unknown",
  );
  assert.equal(
    format.composeStatus(snapshot({ provider: "google" }), "USD", 1, "nerd"),
    "\u2191$2/\u2193$12",
    "no tag outside OpenRouter",
  );
  assert.equal(
    format.composeStatus(snapshot({ provider: "google", cataloguePreview: true }), "USD", 1, "nerd"),
    "\u2191$2/\u2193$12",
  );
});

test("composeStatus: uncomputable prices render as `?` per side", { skip: SKIP }, async () => {
  assert.ok(format);
  assert.equal(
    format.composeStatus(snapshot({ inputUsdPerMillion: null }), "USD", 1, "nerd"),
    "\u2191?/\u2193$12",
  );
  assert.equal(
    format.composeStatus(snapshot({ inputUsdPerMillion: null, outputUsdPerMillion: null }), "USD", 1, "nerd"),
    "\u2191?/\u2193?",
  );
});

test("composeStatus: colours the icons, not the numbers", { skip: SKIP }, async () => {
  assert.ok(format);
  assert.ok(pricing);

  const catalogue = snapshot({ catalogueInputUsdPerMillion: 1, catalogueOutputUsdPerMillion: 1 });
  const colors = {
    base: "white",
    input: pricing.deviationColorSpec(2, 1),
    output: pricing.deviationColorSpec(12, 1),
  };
  assert.equal(colors.input, "red");

  const text = format.composeStatus(catalogue, "USD", 1, "nerd", colors);
  assert.equal(text, "\u001b[91m\u2191\u001b[0m\u001b[97m$2\u001b[0m/\u001b[91m\u2193\u001b[0m\u001b[97m$12\u001b[0m");
});

test("composeStatus: `none` colours leave the text plain", { skip: SKIP }, async () => {
  assert.ok(format);
  assert.equal(
    format.composeStatus(snapshot(), "USD", 1, "nerd", { base: "none", input: "none", output: "none" }),
    "\u2191$2/\u2193$12",
  );
});
