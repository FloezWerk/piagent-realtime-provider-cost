/**
 * Static provider resolution from OpenRouter routing constraints.
 *
 * When `models.json` pins a model to a single provider via
 * `compat.openRouterRouting.only = ["fireworks"]`, the serving provider is known
 * without any API call. Multi-provider or `auto` routing returns null.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extracts a single pinned provider from a resolved Pi model, or null. */
export function routingProviderFromModel(model: unknown): string | null {
  if (!isRecord(model)) return null;

  const compat = isRecord(model.compat) ? model.compat : undefined;
  const routing = compat && isRecord(compat.openRouterRouting) ? compat.openRouterRouting : undefined;
  const only = routing?.only;

  if (!Array.isArray(only) || only.length !== 1) return null;

  const provider = only[0];
  if (typeof provider !== "string") return null;

  const trimmed = provider.trim();
  return trimmed || null;
}
