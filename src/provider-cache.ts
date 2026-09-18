/**
 * Persisted per-model cache for the resolved OpenRouter provider.
 *
 * Goal: avoid one REST call per response. An entry is either
 * - `routing`   – derived statically from the model's `openRouterRouting.only`
 *                 constraint (no call, effectively permanent), or
 * - `generation` – resolved once via the generation API and reused until the TTL
 *                 expires.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ProviderSource = "routing" | "generation";

export interface ProviderCacheEntry {
  provider: string;
  source: ProviderSource;
  fetchedAt: number;
}

interface CacheFile {
  version: 1;
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
      if (!isRecord(raw) || !isRecord(raw.entries)) return;

      for (const [model, value] of Object.entries(raw.entries)) {
        if (!isRecord(value)) continue;
        const provider = value.provider;
        const source = value.source;
        const fetchedAt = value.fetchedAt;
        if (typeof provider !== "string" || !provider.trim()) continue;
        if (source !== "routing" && source !== "generation") continue;
        if (typeof fetchedAt !== "number") continue;

        this.entries.set(model, { provider: provider.trim(), source, fetchedAt });
      }
    } catch {
      // Missing/corrupt cache is fine.
    }
  }

  /** Returns a still-valid entry, or null. `routing` entries never expire. */
  get(model: string, ttlMs: number): ProviderCacheEntry | null {
    const entry = this.entries.get(model);
    if (!entry) return null;
    if (entry.source === "routing") return entry;
    if (Date.now() - entry.fetchedAt < ttlMs) return entry;
    return null;
  }

  /** Returns the entry regardless of TTL (for status output). */
  peek(model: string): ProviderCacheEntry | null {
    return this.entries.get(model) ?? null;
  }

  set(model: string, provider: string, source: ProviderSource): void {
    this.entries.set(model, { provider, source, fetchedAt: Date.now() });
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
            version: 1,
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
