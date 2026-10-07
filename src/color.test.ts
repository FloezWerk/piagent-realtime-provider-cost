/**
 * Unit tests for the ANSI colour specs of the status text.
 *
 * Run: `npm run test` (part of `npm run check`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { COLOR_NAMES, RESET, colorize, normalizeColorSpec, resolveColorSpec } from "./color.ts";

test("resolveColorSpec: palette names use the bright SGR codes", () => {
  assert.deepEqual(resolveColorSpec("white"), { sgr: "97", none: false });
  assert.deepEqual(resolveColorSpec("yellow"), { sgr: "93", none: false });
  assert.deepEqual(resolveColorSpec("orange"), { sgr: "38;5;208", none: false });
  assert.deepEqual(resolveColorSpec("gray"), { sgr: "90", none: false });
});

test("resolveColorSpec: hex and 256-colour codes", () => {
  assert.deepEqual(resolveColorSpec("#ffd700"), { sgr: "38;2;255;215;0", none: false });
  assert.deepEqual(resolveColorSpec("#fd0"), { sgr: "38;2;255;221;0", none: false }, "short form is expanded");
  assert.deepEqual(resolveColorSpec("226"), { sgr: "38;5;226", none: false });
  assert.equal(resolveColorSpec("256"), null, "outside the 256-colour range");
  assert.equal(resolveColorSpec("#ggg"), null);
  assert.equal(resolveColorSpec("warning"), null, "theme names are not colour specs");
});

test("resolveColorSpec: bold/reverse prefixes, combinable and order-insensitive", () => {
  assert.deepEqual(resolveColorSpec("bold:yellow"), { sgr: "1;93", none: false });
  assert.deepEqual(resolveColorSpec("reverse:red"), { sgr: "7;91", none: false });
  assert.deepEqual(resolveColorSpec("bold:reverse:red"), { sgr: "1;7;91", none: false });
  assert.deepEqual(resolveColorSpec("reverse:bold:#ffd700"), { sgr: "1;7;38;2;255;215;0", none: false });
});

test("resolveColorSpec: `none` disables colour, but not with attributes", () => {
  assert.deepEqual(resolveColorSpec("none"), { sgr: "", none: true });
  assert.equal(resolveColorSpec("bold:none"), null, "an attribute without a colour is meaningless");
  assert.equal(resolveColorSpec("bold:"), null);
  assert.equal(resolveColorSpec(""), null);
});

test("normalizeColorSpec: canonicalises what gets persisted", () => {
  assert.equal(normalizeColorSpec("  Yellow "), "yellow");
  assert.equal(normalizeColorSpec("bold:YELLOW"), "bold:yellow");
  assert.equal(normalizeColorSpec("reverse:bold:#FFD700"), "bold:reverse:#FFD700");
  assert.equal(normalizeColorSpec("022"), "22", "leading zeros are trimmed");
  assert.equal(normalizeColorSpec("0226"), undefined, "four digits are not a 256-colour code");
  assert.equal(normalizeColorSpec("bogus"), undefined);
  assert.equal(normalizeColorSpec(undefined), undefined);
  assert.equal(normalizeColorSpec(93), undefined);
});

test("colorize: wraps the text, `none` and invalid specs stay plain", () => {
  assert.equal(colorize("hi", "yellow"), `\u001b[93mhi${RESET}`);
  assert.equal(colorize("hi", "bold:yellow"), `\u001b[1;93mhi${RESET}`);
  assert.equal(colorize("hi", "none"), "hi");
  assert.equal(colorize("hi", "bogus"), "hi");
});

test("COLOR_NAMES: every palette name resolves", () => {
  for (const name of COLOR_NAMES) {
    const resolved = resolveColorSpec(name);
    assert.ok(resolved, name);
    assert.equal(resolved.none, name === "none");
  }
});
