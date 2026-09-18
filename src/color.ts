/**
 * ANSI colouring for the `realtime-provider-cost` status text.
 *
 * The extension colours its own text (instead of relying on the host), because
 * the colour has to change dynamically: normal by default, highlighted briefly
 * after a detected serving-provider switch.
 *
 * Supported colour specs (`color` / `switchColor`):
 *   - palette names:  white, yellow, orange, red, green, cyan, magenta, blue, gray, none
 *   - hex:            #ffd700, #fd0        (truecolor)
 *   - 256-colour:     226                  (0-255)
 *   - `bold:` prefix: bold:yellow, bold:#ffd700, bold:226
 *   - `reverse:` prefix: reverse:red       (colour becomes the background)
 *   - combinable:     bold:reverse:red
 *
 * When used inside pi-powerline-footer, the custom item needs
 * `"selfColorize": true` so Powerline keeps these escape codes instead of
 * stripping them and applying its own colour.
 */

export const COLOR_NAMES = [
  "white",
  "yellow",
  "orange",
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

/**
 * SGR parameter lists per palette name. Bright variants are used for the basic
 * colours; `orange` has no ANSI palette entry and uses 256-colour 208.
 */
const SGR: Record<Exclude<ColorName, "none">, string> = {
  white: "97",
  yellow: "93",
  orange: "38;5;208",
  red: "91",
  green: "92",
  cyan: "96",
  magenta: "95",
  blue: "94",
  gray: "90",
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

/** Attribute prefixes parsed from a colour spec, e.g. `bold:reverse:red`. */
interface ColorAttrs {
  bold: boolean;
  reverse: boolean;
}

const ATTR_PREFIX = /^(bold|reverse):(.*)$/i;

/** Strips all leading `bold:`/`reverse:` prefixes; null when only prefixes remain. */
function splitAttrs(spec: string): { attrs: ColorAttrs; body: string } | null {
  const attrs: ColorAttrs = { bold: false, reverse: false };
  let rest = spec.trim();

  for (;;) {
    const match = ATTR_PREFIX.exec(rest);
    if (!match) break;
    if (match[1].toLowerCase() === "bold") attrs.bold = true;
    else attrs.reverse = true;
    rest = match[2].trim();
  }

  return rest ? { attrs, body: rest } : null;
}

/** SGR parameter list for the parsed attributes, e.g. `1;7`. */
function attrSgr(attrs: ColorAttrs): string {
  return [attrs.bold ? "1" : "", attrs.reverse ? "7" : ""].filter(Boolean).join(";");
}

function withAttrs(sgr: string, attrs: ColorAttrs): ResolvedColor {
  const prefix = attrSgr(attrs);
  return { sgr: prefix ? `${prefix};${sgr}` : sgr, none: false };
}

/** Parses a colour spec; null when invalid. */
export function resolveColorSpec(spec: string): ResolvedColor | null {
  const parsed = splitAttrs(spec);
  if (!parsed) return null;

  const { attrs, body } = parsed;
  const lower = body.toLowerCase();
  if (lower === "none") return attrSgr(attrs) ? null : { sgr: "", none: true };

  const name = SGR[lower as Exclude<ColorName, "none">];
  if (typeof name === "string") return withAttrs(name, attrs);

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(body);
  if (hex) return withAttrs(`38;2;${hexToRgb(hex[1]).join(";")}`, attrs);

  if (/^\d{1,3}$/.test(body)) {
    const code = Number(body);
    if (code >= 0 && code <= 255) return withAttrs(`38;5;${code}`, attrs);
  }

  return null;
}

/** Validates and canonicalises a colour spec for persistence in settings. */
export function normalizeColorSpec(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!resolveColorSpec(value.trim())) return undefined;

  const parsed = splitAttrs(value.trim());
  if (!parsed) return undefined;

  const prefixes: string[] = [];
  if (parsed.attrs.bold) prefixes.push("bold");
  if (parsed.attrs.reverse) prefixes.push("reverse");

  let body = parsed.body;
  if ((COLOR_NAMES as readonly string[]).includes(body.toLowerCase())) body = body.toLowerCase();
  else if (/^\d{1,3}$/.test(body)) body = String(Number(body));

  return [...prefixes, body].join(":");
}

/** Wraps `text` in the SGR colour; `none` returns the text untouched. */
export function colorize(text: string, spec: string): string {
  const resolved = resolveColorSpec(spec);
  if (!resolved || resolved.none) return text;
  return `\u001b[${resolved.sgr}m${text}${RESET}`;
}
