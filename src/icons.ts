/**
 * Icon set for the `realtime-provider-cost` extension.
 *
 * Input/output use plain arrows (`↑`/`↓`): they are rendered full size by every
 * font, unlike Nerd Font private-use glyphs which are drawn noticeably smaller.
 * The `ascii` mode keeps unambiguous text labels (`in:`/`out:`) instead.
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

/** Clear, full-size arrows - work in any font/terminal. */
const ARROW_ICONS: PriceIcons = {
  input: "\u2191", // ↑
  output: "\u2193", // ↓
};

const ASCII_ICONS: PriceIcons = {
  input: "in:",
  output: "out:",
};

/** "update in progress" indicator shown while the provider is being resolved. */
const PENDING_ICON = "\u27F3"; // ⟳
const PENDING_ICON_ASCII = "...";

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
  return resolveIconMode(mode) === "ascii" ? ASCII_ICONS : ARROW_ICONS;
}

/** Icon shown while the serving provider is still being resolved. */
export function getPendingIcon(mode: IconMode = "auto"): string {
  return resolveIconMode(mode) === "ascii" ? PENDING_ICON_ASCII : PENDING_ICON;
}
