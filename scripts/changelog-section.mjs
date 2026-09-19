/**
 * Shared helper for the release scripts: pulls a single version section out of
 * `CHANGELOG.md` (Keep a Changelog format).
 *
 * Not published (`package.json` "files" lists extensions/src/README/LICENSE
 * only); used by `release.yml` and `ci.yml`.
 */

/**
 * Returns the body of the `## [version]` section, without the heading and
 * without the trailing link-reference definitions that close the file.
 * Returns null when the version has no section.
 */
export function changelogSection(text, version) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) return null;

  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    // Next version heading or the "[x.y.z]: https://..." reference list.
    if (line.startsWith("## ") || /^\[[^\]]+\]:\s*http/.test(line)) break;
    body.push(line);
  }

  const section = body.join("\n").trim();
  return section || null;
}

/** Date of the `## [version] - YYYY-MM-DD` heading, or null. */
export function changelogDate(text, version) {
  const match = new RegExp(`^## \\[${version}\\]\\s*-\\s*(\\S+)\\s*$`, "m").exec(text);
  return match ? match[1] : null;
}
