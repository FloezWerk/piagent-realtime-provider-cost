/**
 * Serving data of a call, captured from OpenRouter's own stream chunks.
 *
 * Pi normalizes provider chunks before they reach a message and drops what is
 * not part of its model: `chunk.provider` (the provider *inside* OpenRouter that
 * served the request) and `chunk.usage.cost` (what OpenRouter charged) never
 * show up on the assistant message. Since pi 0.99 the raw chunk is reachable
 * through the `provider_stream_event` extension event, which fires for every
 * parsed chunk *before* normalization - so the serving provider and the billed
 * amount of a call can be read from the response itself, per response, without
 * a follow-up generation-API request.
 *
 * Chunk shape (OpenRouter via the `openai-completions` API):
 *
 *   { id: "gen-...", model, provider: "Fireworks", usage?: { cost, is_byok,
 *     cost_details: { upstream_inference_cost, upstream_inference_prompt_cost,
 *                     upstream_inference_completions_cost }, ... } }
 *
 * `provider` is present on every chunk, `usage` only on the final one, sent just
 * before `[DONE]` (OpenRouter's usage accounting is always on).
 *
 * `cost_details` also splits the upstream invoice into its prompt and completion
 * part (checked against a live stream); both fields cover *all* prompt tokens, so
 * a cache read is already priced into `promptCost`. They are captured as the
 * provider-side split basis of the billed amount; the display does not use them
 * yet - it still derives the in/out split from the provider's endpoint prices.
 *
 * Entries are keyed by the **request** model and consumed by the caller on
 * `message_end`, so a finished call can never be attributed twice; `reset` is
 * called when a new response of that model starts.
 */

export interface StreamCallInfo {
  /** Provider inside OpenRouter that served the request, e.g. "Fireworks". */
  provider: string | null;
  /** Amount OpenRouter billed for this generation in USD (0 for BYOK). */
  totalCost: number | null;
  /** Amount the upstream provider charged in USD (`cost_details`). */
  upstreamCost: number | null;
  /**
   * Upstream cost of the whole prompt in USD (`cost_details`), cached tokens
   * included. Together with `completionsCost` this is the provider-side split of
   * `upstreamCost`; separating the cache buckets inside it still needs the
   * provider's cache prices.
   */
  promptCost: number | null;
  /** Upstream cost of the completion in USD (`cost_details`). */
  completionsCost: number | null;
  /** The request used the account's own provider key instead of credits. */
  byok: boolean;
  /** Provider-side generation id (`gen-...`). */
  responseId: string | null;
}

/** Fields a single chunk can contribute; absent fields stay untouched. */
interface ChunkInfo {
  provider?: string;
  responseId?: string;
  totalCost?: number;
  upstreamCost?: number;
  promptCost?: number;
  completionsCost?: number;
  byok?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseChunk(data: unknown): ChunkInfo | null {
  if (!isRecord(data)) return null;
  const info: ChunkInfo = {};

  const provider = typeof data.provider === "string" ? data.provider.trim() : "";
  if (provider) info.provider = provider;

  const id = typeof data.id === "string" ? data.id.trim() : "";
  if (id) info.responseId = id;

  const usage = isRecord(data.usage) ? data.usage : null;
  if (usage) {
    const cost = numberOrNull(usage.cost);
    if (cost !== null) info.totalCost = cost;

    const details = isRecord(usage.cost_details) ? usage.cost_details : null;
    const upstream = numberOrNull(details?.upstream_inference_cost);
    if (upstream !== null) info.upstreamCost = upstream;

    const promptCost = numberOrNull(details?.upstream_inference_prompt_cost);
    if (promptCost !== null) info.promptCost = promptCost;

    const completionsCost = numberOrNull(details?.upstream_inference_completions_cost);
    if (completionsCost !== null) info.completionsCost = completionsCost;

    if (typeof usage.is_byok === "boolean") info.byok = usage.is_byok;
  }

  return Object.keys(info).length > 0 ? info : null;
}

export class StreamCallBuffer {
  private entries = new Map<string, StreamCallInfo>();

  /** Merges one parsed provider chunk into the entry of a request model. */
  record(model: string, data: unknown): void {
    const chunk = parseChunk(data);
    if (!chunk) return;

    const previous = this.entries.get(model);
    this.entries.set(model, {
      provider: chunk.provider ?? previous?.provider ?? null,
      totalCost: chunk.totalCost ?? previous?.totalCost ?? null,
      upstreamCost: chunk.upstreamCost ?? previous?.upstreamCost ?? null,
      promptCost: chunk.promptCost ?? previous?.promptCost ?? null,
      completionsCost: chunk.completionsCost ?? previous?.completionsCost ?? null,
      byok: chunk.byok ?? previous?.byok ?? false,
      responseId: chunk.responseId ?? previous?.responseId ?? null,
    });
  }

  /**
   * Entry of a finished call, removed on read: a consumed call must not be
   * reused for a later response of the same model.
   */
  take(model: string): StreamCallInfo | null {
    const entry = this.entries.get(model);
    if (entry) this.entries.delete(model);
    return entry ?? null;
  }

  /** Drops the entry of a model, called when a new response of it starts. */
  reset(model: string): void {
    this.entries.delete(model);
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}
