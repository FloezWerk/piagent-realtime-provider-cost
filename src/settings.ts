/**
 * Settings persistence for the `realtime-provider-cost` extension.
 *
 * Stored under the root key `realtime-provider-cost` in Pi's shared
 * `settings.json` (`~/.pi/agent/settings.json`). Only that key is touched -
 * all other keys (packages, powerline, ...) are preserved verbatim.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Root key inside settings.json, matching the extension name. */
export const SETTINGS_ROOT_KEY = "realtime-provider-cost";

/** Status channel used via `ctx.ui.setStatus(...)`. */
export const STATUS_KEY = "realtime-provider-cost";

/** Currencies mirrored from pi-powerline-footer (kept independent on purpose). */
export const SUPPORTED_CURRENCIES = [
  "USD",
  "CNY",
  "EUR",
  "GBP",
  "JPY",
  "CAD",
  "AUD",
  "CHF",
  "INR",
  "KRW",
] as const;

export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

export interface ExtensionSettings {
  /** Show the token prices next to the session cost. */
  enabled: boolean;
  /** Display currency (converted from USD like pi-powerline-footer). */
  currency: CurrencyCode;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: true,
  currency: "USD",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeCurrency(value: unknown): CurrencyCode | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim().toUpperCase();
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(code)
    ? (code as CurrencyCode)
    : undefined;
}

function settingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

async function readSettingsFile(): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(settingsPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Loads the extension settings, falling back to defaults for missing/invalid values. */
export async function loadSettings(): Promise<ExtensionSettings> {
  const root = await readSettingsFile();
  const section = isRecord(root[SETTINGS_ROOT_KEY]) ? root[SETTINGS_ROOT_KEY] : {};

  return {
    enabled: typeof section.enabled === "boolean" ? section.enabled : DEFAULT_SETTINGS.enabled,
    currency: normalizeCurrency(section.currency) ?? DEFAULT_SETTINGS.currency,
  };
}

/**
 * Merges a patch into the extension's settings section and persists it.
 * Read-modify-write of the whole file so unrelated keys survive.
 */
export async function saveSettings(patch: Partial<ExtensionSettings>): Promise<void> {
  const root = await readSettingsFile();
  const current = isRecord(root[SETTINGS_ROOT_KEY]) ? root[SETTINGS_ROOT_KEY] : {};

  root[SETTINGS_ROOT_KEY] = { ...current, ...patch };
  await writeFile(settingsPath(), `${JSON.stringify(root, null, 2)}\n`, "utf8");
}
