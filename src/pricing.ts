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
  return {
    inputUsdPerMillion: rate(message.usage.cost.input, message.usage.input),
    outputUsdPerMillion: rate(message.usage.cost.output, message.usage.output),
    provider: message.provider,
    model: modelId,
    requestModel,
    responseId: typeof message.responseId === "string" && message.responseId ? message.responseId : null,
    upstreamProvider: null,
    providerSource: null,
    subscription: isSubscription(message.provider, requestModel, registry),
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
