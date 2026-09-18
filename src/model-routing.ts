/**
 * Static provider resolution from OpenRouter routing constraints.
 *
 * `compat.openRouterRouting.only = ["fireworks"]` pins the model to one provider.
 * That is only *certain* while fallbacks are disabled: with
 * `allow_fallbacks: true` OpenRouter may still serve the request from another
 * (cheaper) provider, so the constraint is a preference, not a guarantee.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface RoutingConstraint {
  /** Single pinned provider, or null when routing is not pinned to one. */
  provider: string | null;
  /**
   * `true` (OpenRouter default) when the pinned provider may be bypassed by a
   * fallback - the provider then has to be confirmed via the generation API.
   */
  allowFallbacks: boolean;
}

/** Reads the OpenRouter routing constraint from a resolved Pi model. */
export function routingConstraintFromModel(model: unknown): RoutingConstraint | null {
  if (!isRecord(model)) return null;

  const compat = isRecord(model.compat) ? model.compat : undefined;
  const routing = compat && isRecord(compat.openRouterRouting) ? compat.openRouterRouting : undefined;
  if (!routing) return null;

  const only = routing.only;
  const provider =
    Array.isArray(only) && only.length === 1 && typeof only[0] === "string" ? only[0].trim() : "";

  return {
    provider: provider || null,
    allowFallbacks: routing.allow_fallbacks !== false,
  };
}

/**
 * Provider that is guaranteed without an API call: a single pinned provider with
 * fallbacks disabled. Otherwise null (the generation API has to confirm it).
 */
export function certainRoutingProvider(model: unknown): string | null {
  const constraint = routingConstraintFromModel(model);
  if (!constraint || !constraint.provider || constraint.allowFallbacks) return null;
  return constraint.provider;
}
