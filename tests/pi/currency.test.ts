/**
 * On-demand tests for the currency conversion (`npm run test:pi`): the disk cache,
 * the fetch path (stubbed, nothing leaves the machine) and the failure handling.
 *
 * The module keeps the loaded rates in memory, so the tests run in a fixed order:
 * disk cache first, then the refresh paths.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { SKIP } from "./agent-dir.ts";

const dir = mkdtempSync(join(tmpdir(), "provider-cost-currency-"));
process.env.PI_CODING_AGENT_DIR = dir;
const FILE = join(dir, "realtime-provider-cost", "currency-rates.json");

// A fresh cache on disk, so the first load has something to read.
mkdirSync(dirname(FILE), { recursive: true });
writeFileSync(FILE, JSON.stringify({ timestamp: Date.now(), rates: { usd: 1, eur: 0.8 } }), "utf8");

const currency = await import("../../src/currency.ts").catch(() => null);

const readCache = () => JSON.parse(readFileSync(FILE, "utf8"));

/** fetch stub answering with the currency API shape. */
const ratesFetch = (usd: Record<string, number>) =>
  (async () => new Response(JSON.stringify({ usd }), { status: 200 })) as typeof fetch;

after(() => rmSync(dir, { recursive: true, force: true }));

test("ensureRatesLoaded + getRate: reads the disk cache once", { skip: SKIP }, async () => {
  assert.ok(currency);
  assert.equal(currency.getRate("EUR"), null, "nothing loaded yet");

  await currency.ensureRatesLoaded();
  assert.equal(currency.getRate("EUR"), 0.8);
  assert.equal(currency.getRate("USD"), 1, "USD needs no rate at all");
  assert.equal(currency.getRate("JPY"), null, "unknown currency stays unknown");
});

test("refreshRates: fetches, updates the memory and the cache file", { skip: SKIP }, async (t) => {
  assert.ok(currency);
  const mock = t.mock.method(globalThis, "fetch", ratesFetch({ eur: 0.95, jpy: 150 }));

  assert.equal(await currency.refreshRates(), true);
  assert.equal(mock.mock.callCount(), 1);
  assert.equal(currency.getRate("EUR"), 0.95);
  assert.equal(currency.getRate("JPY"), 150);

  const cached = readCache();
  assert.equal(cached.rates.EUR, 0.95);
  assert.ok(typeof cached.timestamp === "number");
});

test("refreshRates: a failing fetch keeps the last known rates", { skip: SKIP }, async (t) => {
  assert.ok(currency);
  t.mock.method(globalThis, "fetch", (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch);

  assert.equal(await currency.refreshRates(), false);
  assert.equal(currency.getRate("EUR"), 0.95, "the previous value stays");
});

test("refreshRates: an HTTP error and a malformed body are not fatal", { skip: SKIP }, async (t) => {
  assert.ok(currency);
  t.mock.method(globalThis, "fetch", (async () => new Response("nope", { status: 500 })) as typeof fetch);
  assert.equal(await currency.refreshRates(), false);

  t.mock.method(globalThis, "fetch", (async () => new Response(JSON.stringify({ nope: true }), { status: 200 })) as typeof fetch);
  assert.equal(await currency.refreshRates(), false);
  assert.equal(currency.getRate("EUR"), 0.95);
});

test("ensureRatesLoaded: never overwrites already loaded rates", { skip: SKIP }, async () => {
  assert.ok(currency);
  writeFileSync(FILE, JSON.stringify({ timestamp: Date.now(), rates: { usd: 1, eur: 0.5 } }), "utf8");

  await currency.ensureRatesLoaded();
  assert.equal(currency.getRate("EUR"), 0.95, "the in-memory value wins");
});

test("CURRENCY_SYMBOLS: every supported currency has a symbol", { skip: SKIP }, async () => {
  assert.ok(currency);
  const settings = await import("../../src/settings.ts");
  for (const code of settings.SUPPORTED_CURRENCIES) {
    assert.equal(typeof currency.CURRENCY_SYMBOLS[code], "string", code);
  }
});
