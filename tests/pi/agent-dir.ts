/**
 * Shared setup for the tests that need the Pi packages (`npm run test:pi`,
 * on demand, not part of `npm run check`).
 *
 * Points `PI_CODING_AGENT_DIR` at a throwaway directory *before* the modules
 * under test are imported, so their settings/cache files never touch the real
 * `~/.pi/agent`. Reports whether the Pi packages are resolvable at all; the
 * tests then skip themselves instead of failing (the peers are external and not
 * installed by `npm install`).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Throwaway agent directory used by all on-demand tests. */
export const AGENT_DIR = mkdtempSync(join(tmpdir(), "provider-cost-test-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

let piAvailable = true;
try {
  await import("@earendil-works/pi-coding-agent");
} catch {
  piAvailable = false;
}

/** `false` to run the tests, otherwise the reason to skip them. */
export const SKIP: false | string = piAvailable
  ? false
  : "the Pi packages are not resolvable (peers are external: install pi or the peers)";

/** Removes the throwaway agent directory. */
export function cleanup(): void {
  rmSync(AGENT_DIR, { recursive: true, force: true });
}
