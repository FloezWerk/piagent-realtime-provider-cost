/**
 * Icon set for the `realtime-provider-cost` extension.
 *
 * Mirrors the input/output icons and Nerd-Font detection of pi-powerline-footer,
 * but is kept local so the extension has no dependency on it.
 */

export interface PriceIcons {
  input: string;
  output: string;
}

const NERD_ICONS: PriceIcons = {
  input: "\uF090",  // nf-fa-sign_in
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

export function getPriceIcons(): PriceIcons {
  return hasNerdFonts() ? NERD_ICONS : ASCII_ICONS;
}
