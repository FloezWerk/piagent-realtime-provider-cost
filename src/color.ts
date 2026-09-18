/**
 * ANSI colouring for the `realtime-provider-cost` status text.
 *
 * The extension colours its own text (instead of relying on the host), because
 * the colour has to change dynamically: white by default, yellow briefly after a
 * detected serving-provider switch.
 *
 * When used inside pi-powerline-footer, the custom item needs
 * `"selfColorize": true` so Powerline keeps these escape codes instead of
 * stripping them and applying its own colour.
 */

export const COLOR_NAMES = [
  "white",
  "yellow",
  "red",
  "green",
  "cyan",
  "magenta",
  "blue",
  "gray",
  "none",
] as const;

export type ColorName = (typeof COLOR_NAMES)[number];

export const RESET = "\u001b[0m";

const SGR: Record<Exclude<ColorName, "none">, number> = {
  white: 97,
  yellow: 93,
  red: 91,
  green: 92,
  cyan: 96,
  magenta: 95,
  blue: 94,
  gray: 90,
};

export function normalizeColorName(value: unknown): ColorName | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim().toLowerCase();
  return (COLOR_NAMES as readonly string[]).includes(name) ? (name as ColorName) : undefined;
}

/** Wraps `text` in the SGR colour; `none` returns the text untouched. */
export function colorize(text: string, color: ColorName): string {
  if (color === "none") return text;
  return `\u001b[${SGR[color]}m${text}${RESET}`;
}
