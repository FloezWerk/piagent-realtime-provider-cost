/**
 * Writes the release notes (the CHANGELOG section of the current package
 * version) to stdout or to a file, for the GitHub release body.
 *
 * Usage: node scripts/release-notes.mjs [--out <path>]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { changelogSection } from "./changelog-section.mjs";

const CHANGELOG = "CHANGELOG.md";
const PACKAGE = "package.json";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outPath = outIndex === -1 ? null : args[outIndex + 1];

const version = JSON.parse(readFileSync(PACKAGE, "utf8")).version;
const section = changelogSection(readFileSync(CHANGELOG, "utf8"), version);

if (!section) {
  console.error(`::error::${CHANGELOG} has no ## [${version}] section`);
  process.exit(1);
}

const notes = `### Changes in ${version}\n\n${section}\n`;
if (outPath) {
  writeFileSync(outPath, notes, "utf8");
} else {
  process.stdout.write(notes);
}
