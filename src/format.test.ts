/**
 * Placeholder - the tests of `format.ts` live in `tests/pi/format.test.ts`.
 *
 * Why no test in this file: `format.ts` is only *transitively* dependent on the Pi
 * packages - it imports `CURRENCY_SYMBOLS` from `currency.ts`, which imports
 * `getAgentDir` from `@earendil-works/pi-coding-agent` at runtime. Importing it
 * therefore fails wherever the Pi packages are missing (the peers are external, CI
 * installs nothing), so its tests run on demand (`npm run test:pi`): prices,
 * rounding, the status text with tag/BYOK marker and the deviation colours. The
 * skipped test below is the marker for that, so the missing coverage next to the
 * source does not look accidental.
 */

import { test } from "node:test";

test("format.ts: covered by tests/pi/format.test.ts", { skip: "needs the Pi packages" }, () => {});
