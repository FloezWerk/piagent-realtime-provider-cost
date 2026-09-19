/**
 * Effective token-price extraction for the `realtime-provider-cost` extension.
 *
 * Instead of reading the static catalogue prices, the effective price of the
 * last API call is derived from the reported usage:
 *
 *   effectivePriceUsdPerMillion = usage.cost.<bucket> / usage.<bucket> * 1e6
 *
 * This automatically reflects pricing tiers, service-tier multipliers and
 * provider-specific rates, because Pi already folded all of those into
 * `usage.cost.*` (see `calculateCost` in pi-ai).
 */

/** Minimal structural view of a Pi assistant message. */
interface AssistantLike {
  role: "assistant";
  provider: string;
  model: string;
  responseModel?: string;
  stopReason?: string;
  responseId?: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens?: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
}

/** Minimal structural view of the model registry exposed to extensions. */
export interface ModelRegistryLike {
  find(provider: string, modelId: string): unknown;
  isUsingOAuth(model: unknown): boolean;
}

/** How the serving provider was determined. */
export type ProviderSource = "routing" | "generation";

export interface RateSnapshot {
  /** Effective input price in USD per 1M tokens, null when not computable. */
  inputUsdPerMillion: number | null;
  /** Effective output price in USD per 1M tokens, null when not computable. */
  outputUsdPerMillion: number | null;
  /**
   * Catalogue input price in USD per 1M tokens (`models-store.json`), used as
   * the reference for the deviation colouring. Null when unknown (then the
   * default colour is kept).
   */
  catalogueInputUsdPerMillion: number | null;
  /** Catalogue output price in USD per 1M tokens, see `catalogueInputUsdPerMillion`. */
  catalogueOutputUsdPerMillion: number | null;
  /** Provider id as configured in Pi (e.g. "openrouter"). */
  provider: string;
  /** Response model id (may be the concrete routed slug). */
  model: string;
  /** Model id that was sent with the request (stable cache/lookup key). */
  requestModel: string;
  /** Provider-side response/generation id (`gen-...` for OpenRouter). */
  responseId: string | null;
  /**
   * Serving provider as determined from the routing constraint or the generation
   * API, otherwise null (tag hidden).
   */
  upstreamProvider: string | null;
  /** Origin of `upstreamProvider`, or null when unknown. */
  providerSource: ProviderSource | null;
  /** OpenRouter provider is currently being resolved via the generation API. */
  providerPending: boolean;
  /**
   * Token buckets of the call, needed to split the real billed amount. For
   * OpenRouter `input` excludes the cached prompt tokens, which arrive in the
   * separate `cacheRead`/`cacheWrite` buckets.
   */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Rates come from the generation API + provider prices instead of the catalogue. */
  ratesFromApi: boolean;
  /**
   * Snapshot was built from the catalogue prices of a freshly selected model,
   * before its first API call. The serving provider is still unknown and is
   * rendered as `?`.
   */
  cataloguePreview: boolean;
  /** Model is subscription-backed -> the whole status item is hidden. */
  subscription: boolean;
}

/** Normalizes a provider name into a stable 3-char tag, e.g. `Fireworks` -> `Fir`. */
export function normalizeProviderTag(name: string): string {
  const lower = name.trim().toLowerCase();
  if (!lower) return "";

  return (lower.charAt(0).toUpperCase() + lower.slice(1)).slice(0, 3);
}

/**
 * Short provider tag for the status line, or null when it should be hidden.
 *
 * Only OpenRouter shows a tag, and only once the serving provider is actually
 * known (routing constraint or generation API). Otherwise it is omitted.
 */
export function upstreamTag(snapshot: RateSnapshot): string | null {
  if (snapshot.provider !== "openrouter") return null;

  const name = snapshot.upstreamProvider?.trim();
  if (!name) return null;

  return normalizeProviderTag(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Base catalogue rates (USD per 1M tokens) of a registry model entry. */
function catalogueRates(model: unknown): { input: number | null; output: number | null } {
  if (!isRecord(model)) return { input: null, output: null };

  const cost = isRecord(model.cost) ? model.cost : {};
  return {
    input: typeof cost.input === "number" ? cost.input : null,
    output: typeof cost.output === "number" ? cost.output : null,
  };
}

/** Percentage thresholds behind the deviation colouring. */
export interface DeviationThresholds {
  /** Deviation below `-green` percent -> green (cheaper than catalogue). */
  green: number;
  /** Deviation above 0 up to `yellow` percent -> yellow. */
  yellow: number;
  /** Deviation above `yellow` up to `orange` percent -> orange; above -> red. */
  orange: number;
}

export const DEFAULT_DEVIATION_THRESHOLDS: DeviationThresholds = {
  green: 10,
  yellow: 10,
  orange: 20,
};

/**
 * Deviation of the effective price from the catalogue price, in percent
 * (negative = cheaper than the catalogue).
 */
function deviationPercent(effectiveUsd: number | null, catalogueUsd: number | null): number | null {
  if (effectiveUsd === null || catalogueUsd === null) return null;
  if (!Number.isFinite(effectiveUsd) || !Number.isFinite(catalogueUsd)) return null;
  if (!(catalogueUsd > 0)) return null;

  return ((effectiveUsd - catalogueUsd) / catalogueUsd) * 100;
}

/**
 * Colour spec for a deviation, or null when the default colour should apply.
 *
 * The caller passes the rates rounded to the display precision (see
 * `roundToDisplay` in `format.ts`): "same as displayed" must mean "same colour",
 * otherwise binary-float noise colours the arrows (the invoice-derived rates are
 * off by a few ULP from the catalogue price, e.g. 0.20000000000000004 vs 0.2).
 */
export function deviationColorSpec(
  effectiveUsd: number | null,
  catalogueUsd: number | null,
  thresholds: DeviationThresholds = DEFAULT_DEVIATION_THRESHOLDS,
): string | null {
  const deviation = deviationPercent(effectiveUsd, catalogueUsd);
  if (deviation === null) return null;

  if (deviation < -thresholds.green) return "green"; // cheaper than catalogue
  if (deviation > thresholds.orange) return "red";
  if (deviation > thresholds.yellow) return "orange";
  if (deviation > 0) return "yellow";
  return null; // 0% or within the discount threshold -> default colour
}

function isAssistantLike(value: unknown): value is AssistantLike {
  if (!isRecord(value) || value.role !== "assistant") return false;
  if (typeof value.provider !== "string" || typeof value.model !== "string") return false;

  const usage = value.usage;
  if (!isRecord(usage)) return false;
  if (typeof usage.input !== "number" || typeof usage.output !== "number") return false;

  const cost = usage.cost;
  if (!isRecord(cost)) return false;

  return typeof cost.input === "number" && typeof cost.output === "number";
}

function isUsable(message: AssistantLike): boolean {
  if (message.stopReason === "error" || message.stopReason === "aborted") return false;
  return message.usage.input > 0 || message.usage.output > 0;
}

function rate(amountUsd: number, tokens: number): number | null {
  if (!(tokens > 0) || !Number.isFinite(amountUsd)) return null;
  const perMillion = (amountUsd / tokens) * 1_000_000;
  return Number.isFinite(perMillion) ? perMillion : null;
}

/** `kimi-coding` is subscription-backed despite using API-key authentication. */
const SUBSCRIPTION_PROVIDERS = new Set(["kimi-coding"]);

function isSubscription(provider: string, modelId: string, registry: ModelRegistryLike | undefined): boolean {
  if (SUBSCRIPTION_PROVIDERS.has(provider)) return true;
  if (!registry) return false;

  try {
    const model = registry.find(provider, modelId);
    return model ? registry.isUsingOAuth(model) === true : false;
  } catch {
    return false;
  }
}

/** Builds a snapshot from a single finalized assistant message. */
export function snapshotFromMessage(
  message: unknown,
  registry: ModelRegistryLike | undefined,
): RateSnapshot | null {
  if (!isAssistantLike(message) || !isUsable(message)) return null;

  const requestModel = message.model;
  const modelId = message.responseModel ?? message.model;

  let catalogue: { input: number | null; output: number | null } = { input: null, output: null };
  try {
    catalogue = catalogueRates(registry?.find(message.provider, requestModel));
  } catch {
    catalogue = { input: null, output: null };
  }

  return {
    inputUsdPerMillion: rate(message.usage.cost.input, message.usage.input),
    outputUsdPerMillion: rate(message.usage.cost.output, message.usage.output),
    catalogueInputUsdPerMillion: catalogue.input,
    catalogueOutputUsdPerMillion: catalogue.output,
    provider: message.provider,
    model: modelId,
    requestModel,
    responseId: typeof message.responseId === "string" && message.responseId ? message.responseId : null,
    upstreamProvider: null,
    providerSource: null,
    providerPending: false,
    tokens: {
      input: message.usage.input,
      output: message.usage.output,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
    },
    ratesFromApi: false,
    cataloguePreview: false,
    subscription: isSubscription(message.provider, requestModel, registry),
  };
}

/**
 * Builds a preview snapshot from the catalogue prices (`models-store.json`) of a
 * model that was just selected.
 *
 * Until the first API call of the new model completes there is no serving
 * provider - the tag therefore shows `?` (see `composeStatus`). Tiered pricing
 * is not applied yet either: without token counts only the base rates are known.
 * Returns null when the model has no provider/id; missing prices render as `?`.
 */
export function snapshotFromModel(
  model: unknown,
  registry: ModelRegistryLike | undefined,
): RateSnapshot | null {
  if (!isRecord(model)) return null;

  const provider = typeof model.provider === "string" ? model.provider.trim() : "";
  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (!provider || !id) return null;

  const cost = isRecord(model.cost) ? model.cost : {};
  const input = typeof cost.input === "number" ? cost.input : null;
  const output = typeof cost.output === "number" ? cost.output : null;

  return {
    inputUsdPerMillion: input,
    outputUsdPerMillion: output,
    catalogueInputUsdPerMillion: input,
    catalogueOutputUsdPerMillion: output,
    provider,
    model: id,
    requestModel: id,
    responseId: null,
    upstreamProvider: null,
    providerSource: null,
    providerPending: false,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ratesFromApi: false,
    cataloguePreview: true,
    subscription: isSubscription(provider, id, registry),
  };
}

/** Scans a session branch backwards for the most recent usable assistant message. */
export function snapshotFromBranch(
  entries: readonly unknown[],
  registry: ModelRegistryLike | undefined,
): RateSnapshot | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "message") continue;

    const snapshot = snapshotFromMessage(entry.message, registry);
    if (snapshot) return snapshot;
  }
  return null;
}
