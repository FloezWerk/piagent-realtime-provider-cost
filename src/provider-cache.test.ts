/**
 * Placeholder - the tests of `provider-cache.ts` live in
 * `tests/pi/provider-cache.test.ts`.
 *
 * Why no test in this file: `provider-cache.ts` imports `getAgentDir` from
 * `@earendil-works/pi-coding-agent` at runtime, so importing it fails wherever the
 * Pi packages are missing (the peers are external, CI installs nothing). Its tests
 * therefore run on demand (`npm run test:pi`) against a throwaway
 * `PI_CODING_AGENT_DIR` (entry semantics, BYOK flag, version migration, on-disk
 * round-trip). The skipped test below is the marker for that, so the missing
 * coverage next to the source does not look accidental.
 */

import { test } from "node:test";

test("provider-cache.ts: covered by tests/pi/provider-cache.test.ts", { skip: "needs the Pi packages" }, () => {});
