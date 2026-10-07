/**
 * On-demand tests for the settings persistence (`npm run test:pi`): defaults,
 * validation of every field and the read-modify-write that keeps unrelated keys.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AGENT_DIR, SKIP, cleanup } from "./agent-dir.ts";

const settings = await import("../../src/settings.ts").catch(() => null);

const FILE = join(AGENT_DIR, "settings.json");
const write = (value: unknown) => writeFileSync(FILE, JSON.stringify(value, null, 2), "utf8");
const read = () => JSON.parse(readFileSync(FILE, "utf8"));

after(() => cleanup());

test("loadSettings: missing file and unknown keys fall back to defaults", { skip: SKIP }, async () => {
  assert.ok(settings);
  rmSync(FILE, { force: true });

  const loaded = await settings.loadSettings();
  assert.deepEqual(loaded, settings.DEFAULT_SETTINGS);

  write({ other: true, "realtime-provider-cost": "not an object" });
  assert.deepEqual(await settings.loadSettings(), settings.DEFAULT_SETTINGS);
});

test("loadSettings: invalid values are replaced, valid ones kept", { skip: SKIP }, async () => {
  assert.ok(settings);
  write({
    "realtime-provider-cost": {
      enabled: false,
      currency: "XYZ",
      icons: "emoji",
      color: "warning",
      switchColor: "#FFD700",
      deviationStyle: "italic",
      deviationThresholds: { green: -5, yellow: "10", orange: 25 },
      lookupUpstreamProvider: "yes",
      patchSessionCost: "no",
      sessionCostBasis: "credits",
    },
  });

  const loaded = await settings.loadSettings();
  assert.equal(loaded.enabled, false, "a valid boolean is kept");
  assert.equal(loaded.currency, "USD");
  assert.equal(loaded.icons, "auto");
  assert.equal(loaded.color, "white", "theme names are not colour specs");
  assert.equal(loaded.switchColor, "#FFD700", "hex specs are kept verbatim");
  assert.equal(loaded.deviationStyle, "plain");
  assert.deepEqual(loaded.deviationThresholds, { green: 10, yellow: 10, orange: 25 });
  assert.equal(loaded.lookupUpstreamProvider, true);
  assert.equal(loaded.patchSessionCost, true);
  assert.equal(loaded.sessionCostBasis, "upstream");
});

test("saveSettings: patches only the extension section", { skip: SKIP }, async () => {
  assert.ok(settings);
  write({ packages: ["pi-powerline-footer"], "realtime-provider-cost": { enabled: true, icons: "nerd" } });

  await settings.saveSettings({ patchSessionCost: false });
  const root = read();
  assert.deepEqual(root.packages, ["pi-powerline-footer"], "unrelated keys survive");
  assert.deepEqual(root["realtime-provider-cost"], {
    enabled: true,
    icons: "nerd",
    patchSessionCost: false,
  });

  await settings.saveSettings({ currency: "EUR", sessionCostBasis: "openrouter" });
  const section = read()["realtime-provider-cost"];
  assert.equal(section.currency, "EUR");
  assert.equal(section.sessionCostBasis, "openrouter");
  assert.equal(section.patchSessionCost, false, "earlier patches stay");
  assert.equal(section.enabled, true);
});

test("saveSettings: round-trips through loadSettings", { skip: SKIP }, async () => {
  assert.ok(settings);
  rmSync(FILE, { force: true });

  await settings.saveSettings({ currency: "JPY", icons: "ascii", deviationStyle: "reverse" });
  const loaded = await settings.loadSettings();
  assert.equal(loaded.currency, "JPY");
  assert.equal(loaded.icons, "ascii");
  assert.equal(loaded.deviationStyle, "reverse");
  assert.equal(loaded.color, settings.DEFAULT_SETTINGS.color, "untouched fields keep their default");
});
