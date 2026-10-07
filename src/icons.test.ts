/**
 * Unit tests for the icon selection (env override, config mode, terminal heuristic).
 *
 * Run: `npm run test` (part of `npm run check`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getByokIcon,
  getPriceIcons,
  hasNerdFonts,
  normalizeIconMode,
  resolveIconMode,
} from "./icons.ts";

/** Runs `body` with a clean, then restored, process environment. */
function withEnv(env: Record<string, string | undefined>, body: () => void): void {
  const keys = ["PROVIDER_COST_NERD_FONTS", "GHOSTTY_RESOURCES_DIR", "TERM_PROGRAM", "TERM"];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));

  try {
    for (const key of keys) delete process.env[key];
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("normalizeIconMode: only the three known modes", () => {
  assert.equal(normalizeIconMode("auto"), "auto");
  assert.equal(normalizeIconMode("nerd"), "nerd");
  assert.equal(normalizeIconMode("ascii"), "ascii");
  assert.equal(normalizeIconMode("NERD"), undefined, "settings store exact values");
  assert.equal(normalizeIconMode(undefined), undefined);
  assert.equal(normalizeIconMode(42), undefined);
});

test("hasNerdFonts: env override beats the terminal heuristic", () => {
  withEnv({ PROVIDER_COST_NERD_FONTS: "1", TERM: "xterm-256color" }, () => {
    assert.equal(hasNerdFonts(), true);
  });
  withEnv({ PROVIDER_COST_NERD_FONTS: "0", TERM_PROGRAM: "iTerm.app" }, () => {
    assert.equal(hasNerdFonts(), false);
  });
});

test("hasNerdFonts: known terminals and Ghostty count, plain xterm does not", () => {
  for (const terminal of ["iTerm.app", "WezTerm", "kitty", "ghostty", "Alacritty", "kaku"]) {
    withEnv({ TERM_PROGRAM: terminal }, () => assert.equal(hasNerdFonts(), true, terminal));
  }
  withEnv({ TERM: "xterm-256color" }, () => assert.equal(hasNerdFonts(), false));
  withEnv({ GHOSTTY_RESOURCES_DIR: "/usr/share/ghostty" }, () => assert.equal(hasNerdFonts(), true));
  withEnv({}, () => assert.equal(hasNerdFonts(), false));
});

test("resolveIconMode: env override, then the configured mode, then auto", () => {
  withEnv({}, () => {
    assert.equal(resolveIconMode("nerd"), "nerd");
    assert.equal(resolveIconMode("ascii"), "ascii");
    assert.equal(resolveIconMode("auto"), "ascii", "no nerd-font terminal detected");
  });

  withEnv({ TERM_PROGRAM: "wezterm" }, () => {
    assert.equal(resolveIconMode("auto"), "nerd");
    assert.equal(resolveIconMode("ascii"), "ascii", "explicit mode wins over the heuristic");
  });

  withEnv({ PROVIDER_COST_NERD_FONTS: "0", TERM_PROGRAM: "wezterm" }, () => {
    assert.equal(resolveIconMode("nerd"), "ascii", "the env var wins for a single run");
  });
  withEnv({ PROVIDER_COST_NERD_FONTS: "1", TERM: "xterm-256color" }, () => {
    assert.equal(resolveIconMode("auto"), "nerd");
  });
});

test("getPriceIcons / getByokIcon: arrows in nerd mode, labels in ascii mode", () => {
  withEnv({}, () => {
    assert.deepEqual(getPriceIcons("nerd"), { input: "\u2191", output: "\u2193" });
    assert.deepEqual(getPriceIcons("ascii"), { input: "in:", output: "out:" });
    assert.deepEqual(getPriceIcons(), getPriceIcons("auto"));
    assert.equal(getByokIcon("nerd"), "\u{1F511}");
    assert.equal(getByokIcon("ascii"), "*");
  });
});
