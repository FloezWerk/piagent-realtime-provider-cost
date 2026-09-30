/**
 * Best-effort lookup of the serving data of an OpenRouter generation.
 *
 * Only used for a **restored session**: the last assistant message of a branch
 * carries the generation id (`responseId`, the `gen-...` id of the stream), but
 * no stream data was captured for it, so provider and billed amount have to be
 * asked for afterwards:
 *
 *   GET https://openrouter.ai/api/v1/generation?id=<responseId>
 *     -> { data: { provider_name, total_cost, upstream_inference_cost, is_byok } }
 *
 * Every live call is covered by the response itself (`provider_stream_event`,
 * see `stream-usage.ts`), so this is the only remaining request - and the only
 * place that needs an API key. It is made on demand (session restore, explicit
 * re-resolve) and a single attempt is enough: the generation of a restored call
 * is minutes or hours old, so the endpoint is not queried before it is ready
 * (which was the reason for the retry backoff the lookup used to have).
 *
 * Note: the endpoint has no per-bucket cost split (`cost_details` exists only in
 * the chat-completion usage Pi throws away), so only the total, the upstream
 * invoice and the BYOK flag can be used - see `deriveRealRates` and
 * `effectiveBilledCost`.
 */

const GENERATION_URL = "https://openrouter.ai/api/v1/generation";

export interface GenerationInfo {
  /** Serving provider reported by OpenRouter, e.g. "Fireworks". */
  providerName: string | null;
  /**
   * Amount billed by OpenRouter for this generation in USD. `0` for a BYOK
   * generation, where OpenRouter bills nothing and the provider charges you
   * directly (see `upstreamCost`).
   */
  totalCost: number | null;
  /**
   * Amount charged by the upstream provider in USD (`upstream_inference_cost`;
   * the same value is nested under `cost_details` in the streamed usage).
   */
  upstreamCost: number | null;
  /** The request used your own provider key instead of OpenRouter credits. */
  byok: boolean;
}

export interface LookupOptions {
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseGeneration(body: unknown): GenerationInfo | null {
  if (!isRecord(body) || !isRecord(body.data)) return null;
  const data = body.data;

  const providerName =
    typeof data.provider_name === "string" && data.provider_name.trim()
      ? data.provider_name.trim()
      : null;

  const costDetails = isRecord(data.cost_details) ? data.cost_details : null;

  return {
    providerName,
    totalCost: numberOrNull(data.total_cost),
    upstreamCost: numberOrNull(data.upstream_inference_cost)
      ?? numberOrNull(costDetails?.upstream_inference_cost),
    byok: data.is_byok === true,
  };
}

/** Resolves the generation metadata for a response id, or null. One attempt. */
export async function lookupOpenRouterGeneration(
  responseId: string,
  options: LookupOptions,
): Promise<GenerationInfo | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  if (typeof fetchImpl !== "function") return null;

  try {
    const response = await fetchImpl(`${GENERATION_URL}?id=${encodeURIComponent(responseId)}`, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
    });
    if (!response.ok) return null;

    return parseGeneration(await response.json());
  } catch {
    // Network errors / timeouts are non-fatal: without data the last known
    // values (or the catalogue-derived ones) stay in place.
    return null;
  }
}
