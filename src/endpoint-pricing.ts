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
 */
interface CacheFile {
  version: 2;
  models: Record<string, CacheEntry>;
}

const CACHE_VERSION = 2;

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
  };
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
 */
export async function getProviderPricing(
  modelSlug: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderPricingMap | null> {
  const cache = await loadFile();
  const entry = cache.models[modelSlug];
  const fresh = entry && Date.now() - entry.fetchedAt < TTL_MS;
  if (fresh) return toMap(entry);

  try {
    const response = await fetchImpl(
      `${ENDPOINTS_URL}/${modelSlug}/endpoints`,
      { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(8000) },
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
