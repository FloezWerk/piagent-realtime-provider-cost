/**
 * Icon set for the `realtime-provider-cost` extension.
 *
 * Mirrors the input/output icons of pi-powerline-footer, but is kept local so
 * the extension has no dependency on it.
 *
 * Icon selection (highest precedence first):
 *   1. env `PROVIDER_COST_NERD_FONTS=1|0`
 *   2. config `realtime-provider-cost.icons` = "nerd" | "ascii"
 *   3. "auto": terminal heuristics (same as pi-powerline-footer)
 */

export const ICON_MODES = ["auto", "nerd", "ascii"] as const;
export type IconMode = (typeof ICON_MODES)[number];

export interface PriceIcons {
  input: string;
  output: string;
}

const NERD_ICONS: PriceIcons = {
  input: "\uF090", // nf-fa-sign_in
  output: "\uF08B", // nf-fa-sign_out
};

const ASCII_ICONS: PriceIcons = {
  input: "in:",
  output: "out:",
};

/** Nerd Font detection: explicit env override first, then terminal heuristics. */
export function hasNerdFonts(): boolean {
  if (process.env.PROVIDER_COST_NERD_FONTS === "1") return true;
  if (process.env.PROVIDER_COST_NERD_FONTS === "0") return false;

  if (process.env.GHOSTTY_RESOURCES_DIR) return true;

  const term = (process.env.TERM_PROGRAM ?? process.env.TERM ?? "").toLowerCase();
  const nerdTerms = ["iterm", "wezterm", "kitty", "ghostty", "alacritty", "kaku"];
  return nerdTerms.some((value) => term.includes(value));
}

export function normalizeIconMode(value: unknown): IconMode | undefined {
  if (value === "auto" || value === "nerd" || value === "ascii") return value;
  return undefined;
}

/** Resolves the effective icon variant for a given mode. */
export function resolveIconMode(mode: IconMode): "nerd" | "ascii" {
  if (process.env.PROVIDER_COST_NERD_FONTS === "1") return "nerd";
  if (process.env.PROVIDER_COST_NERD_FONTS === "0") return "ascii";

  if (mode === "nerd") return "nerd";
  if (mode === "ascii") return "ascii";
  return hasNerdFonts() ? "nerd" : "ascii";
}

export function getPriceIcons(mode: IconMode = "auto"): PriceIcons {
  return resolveIconMode(mode) === "nerd" ? NERD_ICONS : ASCII_ICONS;
}
