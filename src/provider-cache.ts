/**
 * Persisted per-model cache for the resolved OpenRouter provider.
 *
 * Goal: avoid one REST call per response. An entry is either
 * - `routing`   – derived statically from the model's `openRouterRouting.only`
 *                 constraint (no call, never expires), or
 * - `generation` – resolved once via the generation API and reused for the next
 *                 `providerCacheRefreshPrompts` user prompts on that model.
 *
 * Invalidation is prompt-count based (not time based): a generation entry stays
 * valid as long as fewer than N prompts have been submitted **on that model**
 * since it was stored. The per-model prompt counters are persisted so the
 * semantics survive restarts.
 *
 * Attempts are tracked per model as well: a generation-API request that yields
 * no result (404 right after the call, timeout, ...) re-arms the window just
 * like a stored entry, so a failed lookup cannot turn into one request per
 * prompt.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ProviderSource = "routing" | "generation";

export interface ProviderCacheEntry {
  provider: string;
  source: ProviderSource;
  fetchedAt: number;
  /** Prompt counter value at the time the entry was stored. */
  promptCount: number;
  /** Real effective rates (USD per 1M tokens) when known. */
  inputRate?: number;
  outputRate?: number;
}

interface CacheFile {
  version: 1 | 2;
  /** Model -> monotonic count of submitted user prompts on that model. */
  promptCounts?: Record<string, number>;
  /** Legacy (v1): a single global prompt counter, migrated to `promptCounts`. */
  promptCount?: number;
  /** Model -> prompt counter of the last generation-API attempt (any outcome). */
  attempts?: Record<string, number>;
  entries: Record<string, ProviderCacheEntry>;
}

/** Accepts a persisted counter value, clamping anything unusable to 0. */
function counter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cachePath(): string {
  return join(getAgentDir(), "realtime-provider-cost", "provider-cache.json");
}

export class ProviderCache {
  private entries: Map<string, ProviderCacheEntry> = new Map();
  private attempts: Map<string, number> = new Map();
  /** Model -> submitted prompts on that model. */
  private counters: Map<string, number> = new Map();
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

      // A v1 file carried one global counter. Entries and attempts are anchored
      // to it and cannot be mapped onto per-model counters, so their anchors are
      // reset: every model then starts with a full window instead of one that
      // would never expire (an anchor above its model's counter).
      const legacy = !isRecord(raw.promptCounts);

      if (isRecord(raw.promptCounts)) {
        for (const [model, value] of Object.entries(raw.promptCounts)) {
          this.counters.set(model, counter(value));
        }
      }

      if (isRecord(raw.attempts)) {
        for (const [model, value] of Object.entries(raw.attempts)) {
          this.attempts.set(model, legacy ? 0 : counter(value));
        }
      }

      if (!isRecord(raw.entries)) return;
      for (const [model, value] of Object.entries(raw.entries)) {
        if (!isRecord(value)) continue;
        const provider = value.provider;
        const source = value.source;
        const fetchedAt = value.fetchedAt;
        const promptCount = value.promptCount;
        if (typeof provider !== "string" || !provider.trim()) continue;
        if (source !== "routing" && source !== "generation") continue;
        if (typeof fetchedAt !== "number") continue;

        const inputRate = value.inputRate;
        const outputRate = value.outputRate;
        this.entries.set(model, {
          provider: provider.trim(),
          source,
          fetchedAt,
          promptCount: legacy ? 0 : counter(promptCount),
          ...(typeof inputRate === "number" && Number.isFinite(inputRate) ? { inputRate } : {}),
          ...(typeof outputRate === "number" && Number.isFinite(outputRate) ? { outputRate } : {}),
        });
      }
    } catch {
      // Missing/corrupt cache is fine.
    }
  }

  /** Monotonic prompt counter of one model. */
  promptCount(model: string): number {
    return this.counters.get(model) ?? 0;
  }

  /**
   * Increments the prompt counter of one model (called once per submitted user
   * prompt, with the model that will serve it).
   */
  bumpPromptCount(model: string): void {
    this.counters.set(model, this.promptCount(model) + 1);
    void this.persist();
  }

  /**
   * Returns a still-valid entry, or null. `routing` entries never expire;
   * `generation` entries expire after `refreshPrompts` further prompts **on the
   * same model**. A failed attempt (see `markAttempt`) re-arms the window, so
   * the last known provider/costs stay in use instead of being re-resolved per
   * prompt. Prompts on other models do not age this entry.
   */
  get(model: string, refreshPrompts: number): ProviderCacheEntry | null {
    const entry = this.entries.get(model);
    if (!entry) return null;
    if (entry.source === "routing") return entry;

    const anchor = Math.max(entry.promptCount, this.attempts.get(model) ?? 0);
    const age = this.promptCount(model) - anchor;
    return age < Math.max(0, refreshPrompts) ? entry : null;
  }

  /** Returns the entry regardless of age (for status output). */
  peek(model: string): ProviderCacheEntry | null {
    return this.entries.get(model) ?? null;
  }

  set(
    model: string,
    provider: string,
    source: ProviderSource,
    rates?: { input: number; output: number } | null,
  ): void {
    this.entries.set(model, {
      provider,
      source,
      fetchedAt: Date.now(),
      promptCount: this.promptCount(model),
      ...(rates ? { inputRate: rates.input, outputRate: rates.output } : {}),
    });
    void this.persist();
  }

  /** Prompt counter of the last generation-API attempt for a model, or null. */
  attemptPromptCount(model: string): number | null {
    return this.attempts.get(model) ?? null;
  }

  /**
   * Records a generation-API attempt - successful or not. Called before the
   * request so a failing lookup cannot be repeated on every prompt.
   */
  markAttempt(model: string): void {
    this.attempts.set(model, this.promptCount(model));
    void this.persist();
  }

  clear(): void {
    this.entries.clear();
    this.attempts.clear();
    this.counters.clear();
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
            version: 2,
            promptCounts: Object.fromEntries(this.counters),
            attempts: Object.fromEntries(this.attempts),
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
