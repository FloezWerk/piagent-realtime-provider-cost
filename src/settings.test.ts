/**
 * Placeholder - the tests of `settings.ts` live in `tests/pi/settings.test.ts`.
 *
 * Why no test in this file: `settings.ts` imports `getAgentDir` from
 * `@earendil-works/pi-coding-agent` at runtime, so importing it fails wherever the
 * Pi packages are missing (the peers are external, CI installs nothing). Its tests
 * therefore run on demand (`npm run test:pi`) against a throwaway
 * `PI_CODING_AGENT_DIR` (defaults, field validation, read-modify-write). The
 * skipped test below is the marker for that, so the missing coverage next to the
 * source does not look accidental.
 */

import { test } from "node:test";

test("settings.ts: covered by tests/pi/settings.test.ts", { skip: "needs the Pi packages" }, () => {});
