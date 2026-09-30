/**
 * Per-provider price list for an OpenRouter model (endpoint prices).
 *
 * Used only as the *split basis* for the real billed amount: the generation API
 * gives the exact total cost but no input/output breakdown, so the provider's
 * prices supply the ratio between the buckets. Any deviation (discount, peak
 * override, price change) shows up as a uniform factor between the modelled and
 * the billed total, which is applied to both buckets - so the displayed rates
 * stay consistent with what was actually charged.
 *
 *   GET https://openrouter.ai/api/v1/models/{author}/{slug}/endpoints
 *
 * Endpoints also declare **long-context price tiers** (`pricing.overrides` with
 * `min_prompt_tokens`): above the threshold a higher rate applies, e.g.
 * `qwen/qwen3.7-flash` on Alibaba jumps from $0.03 to $0.10 per 1M input tokens
 * above 32k prompt tokens. `pricingForPromptTokens` picks the tier that applies
 * to a call, so the split basis uses the same level that was billed.
 *
 * Cached on disk for 24h (prices change rarely), refreshed via
 * `/provider-cost lookup refresh`.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const ENDPOINTS_URL = "https://openrouter.ai/api/v1/models";
const TTL_MS = 24 * 60 * 60 * 1000;

export interface EndpointPricing {
  /** USD per 1M tokens. */
  prompt: number;
  /** USD per 1M tokens. */
  completion: number;
  /** USD per 1M tokens (cached prompt tokens, cache hit). */
  cacheRead: number;
  /** USD per 1M tokens (cached prompt tokens, cache write). */
  cacheWrite: number;
  /** Long-context tiers of this endpoint, ascending by threshold. */
  overrides: PricingTier[];
}

/** Long-context price tier of one endpoint. */
export interface PricingTier {
  /** Tier applies once the prompt has at least this many tokens. */
  minPromptTokens: number;
  /** USD per 1M tokens. */
  prompt: number;
  /** USD per 1M tokens. */
  completion: number;
  /** USD per 1M tokens (cached prompt tokens, cache hit). */
  cacheRead: number;
  /** USD per 1M tokens (cached prompt tokens, cache write). */
  cacheWrite: number;
}

export type ProviderPricingMap = Map<string, EndpointPricing>;

interface CacheEntry {
  fetchedAt: number;
  providers: Record<string, EndpointPricing>;
}

/**
 * Bumped to 2: v1 entries were written per-million but re-scaled by 1e6 on every
 * load, so their values (and, after a few restarts, the factor derived from
 * them) are unusable and must be discarded.
 *
 * Bumped to 3: v2 entries carry no long-context tiers (`overrides`), so a
 * long-context call would be split with base prices until the next refresh.
 */
interface CacheFile {
  version: 3;
  models: Record<string, CacheEntry>;
}

const CACHE_VERSION = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cachePath(): string {
  return join(getAgentDir(), "realtime-provider-cost", "endpoint-pricing.json");
}

/** Endpoint prices arrive as USD-per-token strings, e.g. "0.00000022". */
function perMillion(value: unknown): number | null {
  const raw = typeof value === "string" ? Number(value) : value;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  return raw * 1_000_000;
}

function parsePricing(value: unknown): EndpointPricing | null {
  if (!isRecord(value)) return null;

  const prompt = perMillion(value.prompt);
  const completion = perMillion(value.completion);
  if (prompt === null || completion === null) return null;

  return {
    prompt,
    completion,
    cacheRead: perMillion(value.input_cache_read) ?? prompt,
    cacheWrite: perMillion(value.input_cache_write) ?? prompt,
    overrides: parseOverrides(value.overrides, { prompt, completion }),
  };
}

/**
 * Parses the long-context tiers of an endpoint. A tier without a usable input
 * price is skipped; missing cache prices fall back to the endpoint's base price
 * (the API omits them when they equal the base).
 */
function parseOverrides(value: unknown, base: { prompt: number; completion: number }): PricingTier[] {
  if (!Array.isArray(value)) return [];

  const tiers: PricingTier[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;

    const minPromptTokens = entry.min_prompt_tokens;
    const prompt = perMillion(entry.prompt);
    const completion = perMillion(entry.completion);
    if (typeof minPromptTokens !== "number" || !Number.isFinite(minPromptTokens)) continue;
    if (prompt === null || completion === null) continue;

    tiers.push({
      minPromptTokens,
      prompt,
      completion,
      cacheRead: perMillion(entry.input_cache_read) ?? base.prompt,
      cacheWrite: perMillion(entry.input_cache_write) ?? base.prompt,
    });
  }

  return tiers.sort((a, b) => a.minPromptTokens - b.minPromptTokens);
}

/** Numbers already stored in USD per 1M tokens (no per-token scaling). */
function storedPricing(value: Record<string, unknown>): EndpointPricing | null {
  const prompt = numberOrNull(value.prompt);
  const completion = numberOrNull(value.completion);
  if (prompt === null || completion === null) return null;

  return {
    prompt,
    completion,
    cacheRead: numberOrNull(value.cacheRead) ?? prompt,
    cacheWrite: numberOrNull(value.cacheWrite) ?? prompt,
    overrides: storedOverrides(value.overrides),
  };
}

/** Reads persisted tiers (already in USD per 1M tokens). */
function storedOverrides(value: unknown): PricingTier[] {
  if (!Array.isArray(value)) return [];

  const tiers: PricingTier[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;

    const minPromptTokens = numberOrNull(entry.minPromptTokens);
    const prompt = numberOrNull(entry.prompt);
    const completion = numberOrNull(entry.completion);
    if (minPromptTokens === null || prompt === null || completion === null) continue;

    tiers.push({
      minPromptTokens,
      prompt,
      completion,
      cacheRead: numberOrNull(entry.cacheRead) ?? prompt,
      cacheWrite: numberOrNull(entry.cacheWrite) ?? prompt,
    });
  }

  return tiers.sort((a, b) => a.minPromptTokens - b.minPromptTokens);
}

/**
 * Prices that apply to a call with `promptTokens` prompt tokens (all buckets,
 * i.e. input + cache read + cache write - the thresholds count the whole
 * prompt). Returns the highest tier whose threshold is reached, otherwise the
 * endpoint's base prices.
 */
export function pricingForPromptTokens(
  pricing: EndpointPricing,
  promptTokens: number,
): EndpointPricing {
  let applicable: PricingTier | null = null;
  for (const tier of pricing.overrides) {
    if (promptTokens >= tier.minPromptTokens) applicable = tier;
  }
  if (!applicable) return pricing;

  return {
    prompt: applicable.prompt,
    completion: applicable.completion,
    cacheRead: applicable.cacheRead,
    cacheWrite: applicable.cacheWrite,
    overrides: [],
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseEndpoints(body: unknown): ProviderPricingMap {
  const providers: ProviderPricingMap = new Map();
  if (!isRecord(body) || !isRecord(body.data)) return providers;

  const endpoints = body.data.endpoints;
  if (!Array.isArray(endpoints)) return providers;

  for (const endpoint of endpoints) {
    if (!isRecord(endpoint)) continue;
    const name = typeof endpoint.provider_name === "string" ? endpoint.provider_name.trim() : "";
    if (!name || providers.has(name)) continue;

    const pricing = parsePricing(endpoint.pricing);
    if (pricing) providers.set(name, pricing);
  }

  return providers;
}

let fileCache: CacheFile | null = null;
let writing = false;
let dirty = false;

async function loadFile(): Promise<CacheFile> {
  if (fileCache) return fileCache;

  fileCache = { version: CACHE_VERSION, models: {} };
  try {
    const raw: unknown = JSON.parse(await readFile(cachePath(), "utf8"));
    if (!isRecord(raw) || raw.version !== CACHE_VERSION || !isRecord(raw.models)) return fileCache;

    for (const [model, value] of Object.entries(raw.models)) {
      if (!isRecord(value) || !isRecord(value.providers)) continue;
      if (typeof value.fetchedAt !== "number") continue;

      const providers: Record<string, EndpointPricing> = {};
      for (const [name, pricing] of Object.entries(value.providers)) {
        if (!isRecord(pricing)) continue;
        const parsed = storedPricing(pricing);
        if (parsed) providers[name] = parsed;
      }
      fileCache.models[model] = { fetchedAt: value.fetchedAt, providers };
    }
  } catch {
    // Missing/corrupt cache is fine.
  }

  return fileCache;
}

function persist(next: CacheFile): void {
  dirty = true;
  if (writing) return;

  writing = true;
  void (async () => {
    try {
      while (dirty) {
        dirty = false;
        try {
          await mkdir(dirname(cachePath()), { recursive: true });
          await writeFile(cachePath(), JSON.stringify(next), "utf8");
        } catch {
          // Best-effort.
        }
      }
    } finally {
      writing = false;
    }
  })();
}

function toMap(entry: CacheEntry): ProviderPricingMap {
  return new Map(Object.entries(entry.providers));
}

/**
 * Returns the provider price list for a model slug (e.g.
 * `deepseek/deepseek-v4.1-flash`), using the 24h disk cache when possible.
 * Returns null when neither cache nor API is available.
 *
 * The endpoint list is public, so `apiKey` is optional and only sent when a
 * caller already has one: it must not be resolved just for this request (that
 * would be an asynchronous credential lookup on the price path).
 */
export async function getProviderPricing(
  modelSlug: string,
  apiKey?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderPricingMap | null> {
  const cache = await loadFile();
  const entry = cache.models[modelSlug];
  const fresh = entry && Date.now() - entry.fetchedAt < TTL_MS;
  if (fresh) return toMap(entry);

  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetchImpl(
      `${ENDPOINTS_URL}/${modelSlug}/endpoints`,
      { headers, signal: AbortSignal.timeout(8000) },
    );
    if (!response.ok) return entry ? toMap(entry) : null;

    const providers = parseEndpoints(await response.json());
    if (providers.size === 0) return entry ? toMap(entry) : null;

    cache.models[modelSlug] = {
      fetchedAt: Date.now(),
      providers: Object.fromEntries(providers),
    };
    persist(cache);
    return providers;
  } catch {
    return entry ? toMap(entry) : null;
  }
}

/** Drops the cached price lists (used by `/provider-cost lookup refresh`). */
export function clearPricingCache(): void {
  if (!fileCache) fileCache = { version: CACHE_VERSION, models: {} };
  fileCache.models = {};
  persist(fileCache);
}
