/**
 * Persisted per-model cache for the resolved OpenRouter provider.
 *
 * Goal: keep the last known provider/rates per model available when a response
 * carries none - the last call of a **restored session** in particular, whose
 * generation is long over. Entries never expire: every live response overwrites
 * the entry of its model, so what is stored is always the latest observation.
 * An entry is either
 * - `stream`     – read from the response itself (`provider_stream_event`), the
 *                 normal path; refreshed on every response. Stored in two steps:
 *                 the provider as soon as the response is handled (`setProvider`),
 *                 its rates once the price lookup returned (`setRates`), so a
 *                 pending lookup cannot delay the switch detection,
 * - `routing`    – derived statically from the model's `openRouterRouting.only`
 *                 constraint (no call), or
 * - `generation` – resolved via the generation API for a restored session (see
 *                 `upstream.ts`).
 *
 * Version 3 drops `generation` entries with zero rates: before the BYOK fix
 * (`effectiveBilledCost`) a generation billed by the provider instead of
 * OpenRouter stored `0/0`, which would then stick forever. Dropping them costs
 * one extra lookup; free models resolve to `0/0` again and are stored as before.
 * Older files also carry prompt counters and attempt marks for the removed
 * prompt-count window; they are simply ignored when loading.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ProviderSource = "stream" | "routing" | "generation";

export interface ProviderCacheEntry {
  provider: string;
  source: ProviderSource;
  fetchedAt: number;
  /** Real effective rates (USD per 1M tokens) when known. */
  inputRate?: number;
  outputRate?: number;
  /**
   * The call was billed through your own provider key (BYOK) instead of
   * OpenRouter credits. Kept so a restored call can show the marker without
   * knowing the response anymore.
   */
  byok?: boolean;
}

interface CacheFile {
  version: 1 | 2 | 3;
  entries: Record<string, ProviderCacheEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cachePath(): string {
  return join(getAgentDir(), "realtime-provider-cost", "provider-cache.json");
}

export class ProviderCache {
  private entries: Map<string, ProviderCacheEntry> = new Map();
  private loaded = false;
  private writing = false;
  private dirty = false;

  /** Loads the on-disk cache once. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;

    try {
      const raw: unknown = JSON.parse(await readFile(cachePath(), "utf8"));
      if (!isRecord(raw)) return;

      // A file written before the BYOK fix (version < 3) could carry generation
      // entries with zero rates (see the module comment): they are re-resolved
      // once instead of being reused.
      const dropZeroRates = raw.version !== 3;

      if (!isRecord(raw.entries)) return;
      for (const [model, value] of Object.entries(raw.entries)) {
        if (!isRecord(value)) continue;
        const provider = value.provider;
        const source = value.source;
        const fetchedAt = value.fetchedAt;
        if (typeof provider !== "string" || !provider.trim()) continue;
        if (source !== "stream" && source !== "routing" && source !== "generation") continue;
        if (typeof fetchedAt !== "number") continue;

        const inputRate = value.inputRate;
        const outputRate = value.outputRate;
        const byok = value.byok;
        if (
          dropZeroRates
          && source === "generation"
          && inputRate === 0
          && outputRate === 0
        ) {
          continue;
        }

        this.entries.set(model, {
          provider: provider.trim(),
          source,
          fetchedAt,
          ...(typeof inputRate === "number" && Number.isFinite(inputRate) ? { inputRate } : {}),
          ...(typeof outputRate === "number" && Number.isFinite(outputRate) ? { outputRate } : {}),
          ...(typeof byok === "boolean" ? { byok } : {}),
        });
      }
    } catch {
      // Missing/corrupt cache is fine.
    }
  }

  /** Last known entry of a model, or null. */
  peek(model: string): ProviderCacheEntry | null {
    return this.entries.get(model) ?? null;
  }

  set(
    model: string,
    provider: string,
    source: ProviderSource,
    rates?: { input: number; output: number } | null,
    byok?: boolean,
  ): void {
    this.entries.set(model, {
      provider,
      source,
      fetchedAt: Date.now(),
      ...(rates ? { inputRate: rates.input, outputRate: rates.output } : {}),
      ...(byok !== undefined ? { byok } : {}),
    });
    void this.persist();
  }

  /**
   * Records the serving provider of a response *without* waiting for its rates
   * (see `setRates`). Used by the stream path, where the provider is known from
   * the response itself while the prices still need a lookup: the provider must
   * be stored before that lookup, otherwise the next response compares against
   * an outdated entry and a provider switch between two responses can be missed.
   *
   * Rates of the *same* provider are kept - they still describe this provider and
   * keep the displayed values stable until the new rates arrive. A switch drops
   * them: they belong to the previous provider and must not be attributed to the
   * new one. The BYOK state follows the same rule.
   */
  setProvider(
    model: string,
    provider: string,
    source: ProviderSource,
    byok?: boolean,
  ): void {
    const previous = this.entries.get(model);
    const sameProvider = previous !== undefined
      && previous.provider.trim().toLowerCase() === provider.trim().toLowerCase();

    const entry: ProviderCacheEntry = {
      provider,
      source,
      fetchedAt: Date.now(),
    };
    if (sameProvider && previous) {
      if (previous.inputRate !== undefined) entry.inputRate = previous.inputRate;
      if (previous.outputRate !== undefined) entry.outputRate = previous.outputRate;
    }

    const flag = byok ?? (sameProvider ? previous?.byok : undefined);
    if (flag !== undefined) entry.byok = flag;

    this.entries.set(model, entry);
    void this.persist();
  }

  /**
   * Adds the rates of an already stored provider (see `setProvider`). Ignored
   * when the entry meanwhile belongs to another provider, so a late price lookup
   * cannot attach its rates to the wrong one.
   */
  setRates(model: string, provider: string, rates: { input: number; output: number }): void {
    const entry = this.entries.get(model);
    if (!entry) return;
    if (entry.provider.trim().toLowerCase() !== provider.trim().toLowerCase()) return;

    this.entries.set(model, { ...entry, inputRate: rates.input, outputRate: rates.output });
    void this.persist();
  }

  clear(): void {
    this.entries.clear();
    void this.persist();
  }

  size(): number {
    return this.entries.size;
  }

  /** Writes the latest state; coalesces concurrent calls without dropping updates. */
  private persist(): void {
    this.dirty = true;
    if (this.writing) return;

    this.writing = true;
    void (async () => {
      try {
        while (this.dirty) {
          this.dirty = false;
          const payload: CacheFile = {
            version: 3,
            entries: Object.fromEntries(this.entries),
          };

          try {
            await mkdir(dirname(cachePath()), { recursive: true });
            await writeFile(cachePath(), JSON.stringify(payload), "utf8");
          } catch {
            // Cache persistence is best-effort.
          }
        }
      } finally {
        this.writing = false;
      }
    })();
  }
}

export const providerCache = new ProviderCache();
