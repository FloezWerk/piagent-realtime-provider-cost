/**
 * Compact status-bar rendering for the `realtime-provider-cost` extension.
 */

import { CURRENCY_SYMBOLS, type CurrencyCode } from "./currency.ts";
import { getPriceIcons, type IconMode } from "./icons.ts";
import { upstreamTag, type RateSnapshot } from "./pricing.ts";

/** Rounds to at most 4 decimals and trims trailing zeros for a compact look. */
function formatNumber(value: number): string {
  const rounded = Math.round(value * 10_000) / 10_000;
  if (!Number.isFinite(rounded)) return "?";

  const fixed = rounded.toFixed(4);
  const trimmed = fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
  return trimmed === "" ? "0" : trimmed;
}

/**
 * Formats one USD-per-million rate in the display currency.
 * Returns `?` when the rate is not computable or the FX rate is unknown.
 */
export function formatPrice(amountUsd: number | null, currency: CurrencyCode, rate: number | null): string {
  if (amountUsd === null) return "?";
  if (rate === null) return "?";

  return `${CURRENCY_SYMBOLS[currency]}${formatNumber(amountUsd * rate)}`;
}

/**
 * Builds the status text. Values are per 1M tokens.
 *
 * Format: `<in-icon><in>/<out-icon><out>` plus an optional trailing
 * ` (<provider>)` tag, e.g. `<in>$2/<out>$12 (Fir)`.
 * The tag is only appended for OpenRouter once its serving provider is known;
 * otherwise it is omitted entirely.
 */
export function composeStatus(
  snapshot: RateSnapshot,
  currency: CurrencyCode,
  rate: number | null,
  iconMode: IconMode = "auto",
): string {
  const icons = getPriceIcons(iconMode);
  const input = formatPrice(snapshot.inputUsdPerMillion, currency, rate);
  const output = formatPrice(snapshot.outputUsdPerMillion, currency, rate);
  const base = `${icons.input}${input}/${icons.output}${output}`;

  const tag = upstreamTag(snapshot);
  return tag ? `${base} (${tag})` : base;
}
