/**
 * Currency conversion for the `realtime-provider-cost` extension.
 *
 * Independent re-implementation of the logic used by pi-powerline-footer:
 * USD rates from the same free CDN API, cached on disk for 24h. No import from
 * pi-powerline-footer is used, so the extension works standalone.
 *
 * Effective token prices are USD-based (`usage.cost.*`), so converting for
 * display is a simple multiplication by the USD rate.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { SUPPORTED_CURRENCIES, type CurrencyCode } from "./settings.ts";

export const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = {
  USD: "$",
  CNY: "¥",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CAD: "CA$",
  AUD: "A$",
  CHF: "CHF ",
  INR: "₹",
  KRW: "₩",
};

const RATE_URL =
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json";
const RATE_TTL_MS = 24 * 60 * 60 * 1000;

type RateTable = Partial<Record<CurrencyCode, number>>;

interface CachedRates {
  timestamp: number;
  rates: RateTable;
}

let cachedRates: CachedRates | null = null;
let pendingFetch: Promise<void> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cachePath(): string {
  return join(getAgentDir(), "realtime-provider-cost", "currency-rates.json");
}

function parseCachedRates(value: unknown): CachedRates | null {
  if (!isRecord(value) || typeof value.timestamp !== "number" || !isRecord(value.rates)) {
    return null;
  }

  const rates: RateTable = { USD: 1 };
  for (const currency of SUPPORTED_CURRENCIES) {
    const rate = value.rates[currency.toLowerCase()] ?? value.rates[currency];
    if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
      rates[currency] = rate;
    }
  }

  return { timestamp: value.timestamp, rates };
}

async function readCachedRatesFromDisk(): Promise<CachedRates | null> {
  try {
    return parseCachedRates(JSON.parse(await readFile(cachePath(), "utf8")));
  } catch {
    return null;
  }
}

async function writeCachedRatesToDisk(rates: CachedRates): Promise<void> {
  try {
    await mkdir(dirname(cachePath()), { recursive: true });
    await writeFile(cachePath(), JSON.stringify(rates), "utf8");
  } catch {
    // In-memory rates are still usable when the cache file cannot be written.
  }
}

async function fetchLatestRates(): Promise<CachedRates> {
  const response = await fetch(RATE_URL);
  if (!response.ok) {
    throw new Error(`currency rate fetch failed with HTTP ${response.status}`);
  }

  const body: unknown = await response.json();
  if (!isRecord(body) || !isRecord(body.usd)) {
    throw new Error("currency rate response did not include USD rates");
  }

  const rates: RateTable = { USD: 1 };
  for (const currency of SUPPORTED_CURRENCIES) {
    if (currency === "USD") continue;
    const rate = body.usd[currency.toLowerCase()];
    if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
      rates[currency] = rate;
    }
  }

  return { timestamp: Date.now(), rates };
}

/** Loads the on-disk cache once (used at session start / before first render). */
export async function ensureRatesLoaded(): Promise<void> {
  if (cachedRates) return;
  cachedRates = await readCachedRatesFromDisk();
}

function ensureRatesRefreshing(): void {
  if (pendingFetch) return;
  if (cachedRates && Date.now() - cachedRates.timestamp < RATE_TTL_MS) return;

  pendingFetch = (async () => {
    if (!cachedRates) cachedRates = await readCachedRatesFromDisk();
    if (cachedRates && Date.now() - cachedRates.timestamp < RATE_TTL_MS) return;
    if (typeof fetch !== "function") return;

    try {
      const rates = await fetchLatestRates();
      cachedRates = rates;
      void writeCachedRatesToDisk(rates);
    } catch {
      if (!cachedRates) cachedRates = await readCachedRatesFromDisk();
    }
  })().finally(() => {
    pendingFetch = null;
  });
}

/**
 * Returns the units-per-USD rate for a currency, or null when it is still
 * unknown (the caller then renders `?`). Kicks off a background refresh.
 */
export function getRate(currency: CurrencyCode): number | null {
  if (currency === "USD") return 1;

  const rate = cachedRates?.rates[currency];
  ensureRatesRefreshing();

  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** Forces a fresh fetch (used by the `/provider-cost refresh` command). */
export async function refreshRates(): Promise<boolean> {
  try {
    const rates = await fetchLatestRates();
    cachedRates = rates;
    await writeCachedRatesToDisk(rates);
    return true;
  } catch {
    if (!cachedRates) cachedRates = await readCachedRatesFromDisk();
    return false;
  }
}
