/**
 * Session-cost correction for the `realtime-provider-cost` extension.
 *
 * Pi sums `usage.cost.total` of every session entry for the footer cost sum,
 * `/session`, the `/cost` breakdown, the cache-miss notices and the HTML export;
 * pi-powerline-footer sums the same values for its `cost` segment. All of them
 * come from Pi's catalogue prices (`models-store.json`) and therefore ignore the
 * provider OpenRouter actually routed the call to.
 *
 * `message_end` may return a replacement message and Pi applies it **in place,
 * before persisting the entry and before its own listeners run** - so the
 * corrected amount is what every consumer and the session file see.
 *
 * Only the *amount* is authoritative (every consumer sums `cost.total`). The four
 * buckets are scaled by the same factor, which keeps their relation intact for the
 * consumers that read them (cache statistics); the real in/out *split* stays this
 * extension's own display, which derives it from the provider-side invoice.
 */

import { effectiveBilledCost } from "./rates.ts";
import type { StreamCallInfo } from "./stream-usage.ts";

/** Which amount the session cost uses for a call on your own provider key. */
export const SESSION_COST_BASES = ["upstream", "openrouter"] as const;
export type SessionCostBasis = (typeof SESSION_COST_BASES)[number];

export function normalizeSessionCostBasis(value: unknown): SessionCostBasis | undefined {
  if (typeof value !== "string") return undefined;
  const basis = value.trim().toLowerCase();
  return (SESSION_COST_BASES as readonly string[]).includes(basis)
    ? (basis as SessionCostBasis)
    : undefined;
}

/** Minimal structural view of a message's cost breakdown. */
export interface UsageCostLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/**
 * Amount that belongs into `usage.cost.total` of this call, in USD:
 *
 * - `upstream` (default) - what the call actually cost you. For BYOK OpenRouter
 *   charges nothing and your provider bills the key directly, so the upstream
 *   amount is the spend.
 * - `openrouter` - what OpenRouter itself charged (`0` for BYOK).
 *
 * `null` when the call reported no usable amount (then the catalogue value stays).
 */
export function sessionCostAmount(
  call: StreamCallInfo,
  basis: SessionCostBasis,
): number | null {
  if (basis === "openrouter") {
    return call.totalCost !== null && Number.isFinite(call.totalCost) && call.totalCost >= 0
      ? call.totalCost
      : null;
  }

  const billed = effectiveBilledCost(call.totalCost, call.upstreamCost, call.byok);
  return billed !== null && Number.isFinite(billed) && billed >= 0 ? billed : null;
}

/**
 * The catalogue cost with the real billed amount, or null when it cannot be
 * applied.
 *
 * `total` becomes exactly `billedUsd`; the buckets are scaled by the same factor.
 * When the catalogue total is zero (free model, model without catalogue prices)
 * there is nothing to scale and only the sum is set.
 */
export function patchedCost(cost: UsageCostLike, billedUsd: number): UsageCostLike | null {
  if (!Number.isFinite(billedUsd) || billedUsd < 0) return null;

  if (!(cost.total > 0)) return { ...cost, total: billedUsd };

  const factor = billedUsd / cost.total;
  return {
    input: cost.input * factor,
    output: cost.output * factor,
    cacheRead: cost.cacheRead * factor,
    cacheWrite: cost.cacheWrite * factor,
    total: billedUsd,
  };
}
