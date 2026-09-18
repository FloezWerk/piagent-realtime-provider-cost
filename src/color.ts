/**
 * ANSI colouring for the `realtime-provider-cost` status text.
 *
 * The extension colours its own text (instead of relying on the host), because
 * the colour has to change dynamically: normal by default, highlighted briefly
 * after a detected serving-provider switch.
 *
 * Supported colour specs (`color` / `switchColor`):
 *   - palette names:  white, yellow, red, green, cyan, magenta, blue, gray, none
 *   - hex:            #ffd700, #fd0        (truecolor)
 *   - 256-colour:     226                  (0-255)
 *   - `bold:` prefix: bold:yellow, bold:#ffd700, bold:226
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

/** Bright variants: `white` is bright white, `yellow` bright yellow. */
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

interface ResolvedColor {
  /** SGR parameter list, e.g. `1;93`. */
  sgr: string;
  /** Explicitly disabled colour. */
  none: boolean;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function withBold(sgr: string, bold: boolean): ResolvedColor {
  return { sgr: bold ? `1;${sgr}` : sgr, none: false };
}

/** Parses a colour spec; null when invalid. */
export function resolveColorSpec(spec: string): ResolvedColor | null {
  let rest = spec.trim();
  if (!rest) return null;

  const boldMatch = /^bold:(.*)$/i.exec(rest);
  const bold = Boolean(boldMatch);
  if (boldMatch) {
    rest = boldMatch[1].trim();
    if (!rest) return null;
  }

  const lower = rest.toLowerCase();
  if (lower === "none") return bold ? null : { sgr: "", none: true };

  const name = SGR[lower as Exclude<ColorName, "none">];
  if (typeof name === "number") return withBold(String(name), bold);

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(rest);
  if (hex) return withBold(`38;2;${hexToRgb(hex[1]).join(";")}`, bold);

  if (/^\d{1,3}$/.test(rest)) {
    const code = Number(rest);
    if (code >= 0 && code <= 255) return withBold(`38;5;${code}`, bold);
  }

  return null;
}

/** Validates and canonicalises a colour spec for persistence in settings. */
export function normalizeColorSpec(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const spec = value.trim();
  if (!resolveColorSpec(spec)) return undefined;

  const boldMatch = /^bold:(.*)$/i.exec(spec);
  const bold = boldMatch ? "bold:" : "";
  let body = (boldMatch ? boldMatch[1] : spec).trim();

  if ((COLOR_NAMES as readonly string[]).includes(body.toLowerCase())) body = body.toLowerCase();
  else if (/^\d{1,3}$/.test(body)) body = String(Number(body));

  return `${bold}${body}`;
}

/** Wraps `text` in the SGR colour; `none` returns the text untouched. */
export function colorize(text: string, spec: string): string {
  const resolved = resolveColorSpec(spec);
  if (!resolved || resolved.none) return text;
  return `\u001b[${resolved.sgr}m${text}${RESET}`;
}
