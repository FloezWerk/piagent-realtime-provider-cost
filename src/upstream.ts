/**
 * Best-effort lookup of the real serving data for an OpenRouter generation.
 *
 * Pi does not surface OpenRouter's upstream provider or the actually billed
 * amount for successful calls (it discards `chunk.provider` and `usage.cost` and
 * recomputes costs from its own catalogue). The authoritative source is the
 * generation endpoint:
 *
 *   GET https://openrouter.ai/api/v1/generation?id=<responseId>
 *     -> { data: { provider_name, total_cost, native_tokens_* } }
 *
 * `responseId` is the `gen-...` id that Pi stores on the assistant message
 * (`chunk.id` of the OpenRouter stream). The lookup is optional and failures are
 * swallowed (the caller then falls back to the catalogue-derived numbers).
 *
 * Note: the endpoint has no per-bucket cost split (`cost_details` exists only in
 * the chat-completion usage Pi throws away), so only the *total* cost and the
 * native token counts can be used - see `deriveRealRates`.
 */

const GENERATION_URL = "https://openrouter.ai/api/v1/generation";

export interface GenerationInfo {
  /** Serving provider reported by OpenRouter, e.g. "Fireworks". */
  providerName: string | null;
  /** Amount billed for this generation in USD. */
  totalCost: number | null;
  /** Token counts as counted by the upstream provider. */
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
}

export interface LookupOptions {
  apiKey: string;
  timeoutMs?: number;
  /** Number of additional attempts when the generation is not yet available. */
  retries?: number;
  /** Base delay for the exponential backoff between attempts. */
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_RETRIES = 4;
const DEFAULT_RETRY_DELAY_MS = 1000;

/**
 * OpenRouter publishes generation metadata with a delay (the endpoint can return
 * 404 for a few seconds right after the call), hence the retry backoff.
 * Total wait ≈ 1s + 2s + 4s + 8s = 15s for the defaults.
 */

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

  return {
    providerName,
    totalCost: numberOrNull(data.total_cost),
    promptTokens: numberOrNull(data.native_tokens_prompt),
    completionTokens: numberOrNull(data.native_tokens_completion),
    cachedTokens: numberOrNull(data.native_tokens_cached),
  };
}

async function fetchGeneration(
  responseId: string,
  options: LookupOptions,
): Promise<GenerationInfo | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  if (typeof fetchImpl !== "function") return null;

  const response = await fetchImpl(`${GENERATION_URL}?id=${encodeURIComponent(responseId)}`, {
    headers: { Authorization: `Bearer ${options.apiKey}` },
    signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
  });

  if (!response.ok) return null;
  return parseGeneration(await response.json());
}

/** Resolves the generation metadata for a response id, or null. */
export async function lookupOpenRouterGeneration(
  responseId: string,
  options: LookupOptions,
): Promise<GenerationInfo | null> {
  const attempts = 1 + Math.max(0, options.retries ?? DEFAULT_RETRIES);
  const baseDelay = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const info = await fetchGeneration(responseId, options);
      if (info) return info;
    } catch {
      // Network errors / timeouts / aborts are non-fatal.
    }

    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, baseDelay * 2 ** attempt));
    }
  }

  return null;
}
