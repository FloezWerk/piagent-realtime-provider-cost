/**
 * On-demand tests for the provider cache (`npm run test:pi`): entry semantics,
 * BYOK flag, the version-3 migration and the on-disk round-trip.
 *
 * Every test gets its own throwaway agent directory: the cache persists
 * asynchronously, so a shared file would race with the previous test's write.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { SKIP } from "./agent-dir.ts";

const cacheModule = await import("../../src/provider-cache.ts").catch(() => null);

const dirs: string[] = [];

/**
 * Points the module at a fresh agent dir and returns its cache file path.
 *
 * The cache persists in the background and resolves its path *after* an await, so
 * a write of a previous test could land in the new directory - hence the drain
 * before switching.
 */
async function freshCacheFile(): Promise<string> {
  await new Promise((done) => setTimeout(done, 30));

  const dir = mkdtempSync(join(tmpdir(), "provider-cost-cache-"));
  dirs.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir;
  return join(dir, "realtime-provider-cost", "provider-cache.json");
}

/** Writes a cache file the way an older Pi/extensions version would have left it. */
function writeRaw(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value), "utf8");
}

/** Waits until the cache file satisfies `predicate` (persistence is async). */
async function waitForFile(file: string, predicate: (raw: any) => boolean, timeoutMs = 2000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      try {
        last = JSON.parse(readFileSync(file, "utf8"));
        if (predicate(last)) return last;
      } catch {
        // Half-written file: retry.
      }
    }
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`cache file never matched: ${JSON.stringify(last)}`);
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("load: a missing or corrupt file yields an empty cache", { skip: SKIP }, async () => {
  assert.ok(cacheModule);
  const file = await freshCacheFile();

  const empty = new cacheModule.ProviderCache();
  await empty.load();
  assert.equal(empty.size(), 0);
  assert.equal(empty.peek("model-a"), null);

  writeRaw(file, "not an object");
  const corrupt = new cacheModule.ProviderCache();
  await corrupt.load();
  assert.equal(corrupt.size(), 0);
});

test("set: stores provider, rates and the BYOK flag", { skip: SKIP }, async () => {
  assert.ok(cacheModule);
  const file = await freshCacheFile();

  const cache = new cacheModule.ProviderCache();
  await cache.load();
  cache.set("model-a", "Fireworks", "stream", { input: 0.2, output: 1.2 }, true);

  const entry = cache.peek("model-a");
  assert.equal(entry?.provider, "Fireworks");
  assert.equal(entry?.source, "stream");
  assert.equal(entry?.inputRate, 0.2);
  assert.equal(entry?.outputRate, 1.2);
  assert.equal(entry?.byok, true);
  assert.ok(typeof entry?.fetchedAt === "number");

  const raw = await waitForFile(file, (value) => value?.entries?.["model-a"] !== undefined);
  assert.equal(raw.version, 3);
  assert.equal(raw.entries["model-a"].provider, "Fireworks");
});

test("setProvider: keeps rates of the same provider, drops them on a switch", { skip: SKIP }, async () => {
  assert.ok(cacheModule);
  await freshCacheFile();

  const cache = new cacheModule.ProviderCache();
  await cache.load();
  cache.set("model-a", "Fireworks", "stream", { input: 0.2, output: 1.2 }, false);

  cache.setProvider("model-a", "Fireworks", "stream");
  assert.equal(cache.peek("model-a")?.inputRate, 0.2, "same provider: rates still describe it");
  assert.equal(cache.peek("model-a")?.byok, false, "and so does the BYOK flag");

  cache.setProvider("model-a", "Morph", "stream");
  assert.equal(cache.peek("model-a")?.provider, "Morph");
  assert.equal(cache.peek("model-a")?.inputRate, undefined, "rates of the previous provider are dropped");
  assert.equal(cache.peek("model-a")?.byok, undefined);
});

test("setRates: only for the provider the entry belongs to", { skip: SKIP }, async () => {
  assert.ok(cacheModule);
  await freshCacheFile();

  const cache = new cacheModule.ProviderCache();
  await cache.load();

  cache.setRates("model-a", "Fireworks", { input: 0.1, output: 0.2 });
  assert.equal(cache.peek("model-a"), null, "no entry yet: nothing to attach to");

  cache.setProvider("model-a", "Morph", "stream");
  cache.setRates("model-a", "Fireworks", { input: 0.1, output: 0.2 });
  assert.equal(cache.peek("model-a")?.inputRate, undefined, "late rates of another provider are ignored");

  cache.setRates("model-a", "Morph", { input: 0.1, output: 0.2 });
  assert.equal(cache.peek("model-a")?.inputRate, 0.1);
  assert.equal(cache.peek("model-a")?.provider, "Morph");
});

test("load: version < 3 drops zero-rate generation entries only", { skip: SKIP }, async () => {
  assert.ok(cacheModule);
  const file = await freshCacheFile();
  writeRaw(file, {
    version: 2,
    entries: {
      "zero-generation": { provider: "Fireworks", source: "generation", fetchedAt: 1, inputRate: 0, outputRate: 0 },
      "real-generation": { provider: "Morph", source: "generation", fetchedAt: 1, inputRate: 0.2, outputRate: 1 },
      "zero-stream": { provider: "Novita", source: "stream", fetchedAt: 1, inputRate: 0, outputRate: 0 },
    },
  });

  const cache = new cacheModule.ProviderCache();
  await cache.load();
  assert.equal(cache.peek("zero-generation"), null, "re-resolved instead of reused");
  assert.equal(cache.peek("real-generation")?.inputRate, 0.2);
  assert.equal(cache.peek("zero-stream")?.inputRate, 0, "a stream entry is authoritative");
});

test("load: invalid entries are skipped, valid ones survive a reload", { skip: SKIP }, async () => {
  assert.ok(cacheModule);
  const file = await freshCacheFile();
  writeRaw(file, {
    version: 3,
    entries: {
      bad: { provider: "", source: "stream", fetchedAt: 1 },
      "no-source": { provider: "Morph", source: "guess", fetchedAt: 1 },
      "no-timestamp": { provider: "Morph", source: "stream" },
      good: { provider: " Morph ", source: "routing", fetchedAt: 5, inputRate: 0.3, outputRate: 1.5, byok: true },
    },
  });

  const reloaded = new cacheModule.ProviderCache();
  await reloaded.load();
  assert.equal(reloaded.size(), 1);
  assert.deepEqual(reloaded.peek("good"), {
    provider: "Morph",
    source: "routing",
    fetchedAt: 5,
    inputRate: 0.3,
    outputRate: 1.5,
    byok: true,
  });
});

test("clear: empties the cache and persists it", { skip: SKIP }, async () => {
  assert.ok(cacheModule);
  const file = await freshCacheFile();

  const cache = new cacheModule.ProviderCache();
  await cache.load();
  cache.set("model-a", "Fireworks", "stream");

  cache.clear();
  assert.equal(cache.size(), 0);
  assert.equal(cache.peek("model-a"), null);
  await waitForFile(file, (value) => Object.keys(value?.entries ?? {}).length === 0);
});
