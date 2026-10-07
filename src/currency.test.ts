/**
 * Placeholder - the tests of `currency.ts` live in `tests/pi/currency.test.ts`.
 *
 * Why no test in this file: `currency.ts` imports `getAgentDir` from
 * `@earendil-works/pi-coding-agent` at runtime, so importing it fails wherever the
 * Pi packages are missing (the peers are external, CI installs nothing). Its tests
 * therefore run on demand (`npm run test:pi`) against a throwaway
 * `PI_CODING_AGENT_DIR` and stubbed requests. The skipped test below is the marker
 * for that, so the missing coverage next to the source does not look accidental.
 */

import { test } from "node:test";

test("currency.ts: covered by tests/pi/currency.test.ts", { skip: "needs the Pi packages" }, () => {});
