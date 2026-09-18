/**
 * Compact status-bar rendering for the `realtime-provider-cost` extension.
 */

import { CURRENCY_SYMBOLS, type CurrencyCode } from "./currency.ts";
import { getPendingIcon, getPriceIcons, type IconMode } from "./icons.ts";
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
 * Format: `<in-icon><out-icon>` arrows plus an optional trailing
 * ` (<provider>)` tag, e.g. `↑$2/↓$12 (Fir)`.
 * The tag is only appended for OpenRouter. While the generation-API lookup is
 * running, a "update in progress" icon is shown instead of hiding the tag;
 * if the provider stays unknown, the tag is omitted entirely.
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

  const tag = snapshot.providerPending ? getPendingIcon(iconMode) : upstreamTag(snapshot);
  return tag ? `${base} (${tag})` : base;
}
