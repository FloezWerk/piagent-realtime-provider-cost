/**
 * Best-effort lookup of the actual serving provider for OpenRouter calls.
 *
 * Pi does not surface OpenRouter's upstream provider for successful calls; the
 * streaming chunks only carry the OpenRouter model id. The authoritative source
 * is the generation endpoint:
 *
 *   GET https://openrouter.ai/api/v1/generation?id=<responseId>
 *     -> { data: { provider_name: "Fireworks", ... } }
 *
 * `responseId` is the `gen-...` id that Pi stores on the assistant message
 * (`chunk.id` of the OpenRouter stream). The lookup is optional, time-boxed and
 * failures are swallowed (the caller then falls back to the provider id).
 */

const GENERATION_URL = "https://openrouter.ai/api/v1/generation";

interface LookupOptions {
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
  return typeof value === "object" && value !== null;
}

async function requestProviderName(
  responseId: string,
  options: LookupOptions,
): Promise<string | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  if (typeof fetchImpl !== "function") return null;

  const response = await fetchImpl(`${GENERATION_URL}?id=${encodeURIComponent(responseId)}`, {
    headers: { Authorization: `Bearer ${options.apiKey}` },
    signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
  });

  if (!response.ok) return null;

  const body: unknown = await response.json();
  const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
  const providerName = data?.provider_name;

  return typeof providerName === "string" && providerName.trim() ? providerName.trim() : null;
}

/** Resolves the OpenRouter upstream provider name for a generation id, or null. */
export async function lookupOpenRouterProvider(
  responseId: string,
  options: LookupOptions,
): Promise<string | null> {
  const attempts = 1 + Math.max(0, options.retries ?? DEFAULT_RETRIES);
  const baseDelay = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const name = await requestProviderName(responseId, options);
      if (name) return name;
    } catch {
      // Network errors / timeouts / aborts are non-fatal.
    }

    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, baseDelay * 2 ** attempt));
    }
  }

  return null;
}
