/**
 * Compact status-bar rendering for the `realtime-provider-cost` extension.
 */

import { colorize } from "./color.ts";
import { CURRENCY_SYMBOLS, type CurrencyCode } from "./currency.ts";
import { getPendingIcon, getPriceIcons, type IconMode } from "./icons.ts";
import { upstreamTag, type RateSnapshot } from "./pricing.ts";

/**
 * Per-segment colour specs. `input`/`output` colour the section icon (arrow) and
 * fall back to `base` when unset; `base` colours the numbers and the provider tag.
 * Keeping the numbers in the base colour preserves readability on dark
 * backgrounds - only the icon carries the deviation signal.
 */
export interface PriceColors {
  base?: string;
  input?: string | null;
  output?: string | null;
}

function paint(text: string, spec: string | null | undefined): string {
  return spec ? colorize(text, spec) : text;
}

/** Decimals rendered by `formatPrice`; also the resolution of `roundToDisplay`. */
export const DISPLAY_DECIMALS = 4;

/** Rounds a value exactly like it is rendered (see `DISPLAY_DECIMALS`). */
export function roundToDecimals(value: number): number {
  const factor = 10 ** DISPLAY_DECIMALS;
  return Math.round(value * factor) / factor;
}

/**
 * Rounds a USD-per-1M rate down to the precision it is displayed with (display
 * currency, `DISPLAY_DECIMALS` decimals). Two rates that round to the same value
 * are rendered identically, so they must also get the same deviation colour -
 * this absorbs the binary-float noise of the invoice-derived rates.
 *
 * Without a usable FX rate the value stays untouched (`formatPrice` shows `?`).
 */
export function roundToDisplay(amountUsd: number, rate: number | null): number {
  if (!Number.isFinite(amountUsd)) return amountUsd;
  if (rate === null || !Number.isFinite(rate) || rate <= 0) return amountUsd;

  return roundToDecimals(amountUsd * rate) / rate;
}

/** Rounds to at most 4 decimals and trims trailing zeros for a compact look. */
function formatNumber(value: number): string {
  const rounded = roundToDecimals(value);
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
 * running, a "update in progress" icon is shown instead of hiding the tag; for a
 * mere catalogue preview (model just switched) it is `?`; if the provider stays
 * unknown after the call, the tag is omitted entirely.
 */
export function composeStatus(
  snapshot: RateSnapshot,
  currency: CurrencyCode,
  rate: number | null,
  iconMode: IconMode = "auto",
  colors: PriceColors = {},
): string {
  const icons = getPriceIcons(iconMode);
  const input = paint(formatPrice(snapshot.inputUsdPerMillion, currency, rate), colors.base);
  const output = paint(formatPrice(snapshot.outputUsdPerMillion, currency, rate), colors.base);
  const base = `${paint(icons.input, colors.input ?? colors.base)}${input}/`
    + `${paint(icons.output, colors.output ?? colors.base)}${output}`;

  const tag = snapshot.providerPending
    ? getPendingIcon(iconMode)
    : upstreamTag(snapshot) ?? previewTag(snapshot);
  return tag ? `${base} ${paint(`(${tag})`, colors.base)}` : base;
}

/**
 * `?` while a freshly selected OpenRouter model has not been served yet: the
 * catalogue prices are shown, but the serving provider is still unknown.
 */
function previewTag(snapshot: RateSnapshot): string | null {
  if (!snapshot.cataloguePreview) return null;
  if (snapshot.provider !== "openrouter") return null;
  return "?";
}
