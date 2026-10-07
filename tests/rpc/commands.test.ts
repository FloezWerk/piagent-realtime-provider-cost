/**
 * Free integration test for the `/provider-cost` command surface
 * (`npm run test:rpc`).
 *
 * Drives a real Pi in RPC mode with only this extension loaded and checks that
 * every command is handled and persisted. No model call, so it costs nothing; Pi
 * runs against a throwaway config directory (`PI_CODING_AGENT_DIR`), so the real
 * settings are never touched.
 *
 * Not part of `npm run check` (it needs an installed `pi`); it skips itself when
 * `pi` is not on PATH.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTENSION = join(ROOT, "extensions", "realtime-provider-cost.ts");
const SETTINGS_ROOT_KEY = "realtime-provider-cost";
const RESPONSE_TIMEOUT_MS = 30_000;

interface RpcRecord {
  id?: string;
  type: string;
  command?: string;
  data?: { disposition?: string };
  method?: string;
  statusKey?: string;
}

const hasPi = spawnSync("pi", ["--version"], { stdio: "ignore" }).status === 0;
const SKIP: false | string = hasPi ? false : "`pi` is not on PATH";

let child: ChildProcessWithoutNullStreams | undefined;
let agentDir: string | undefined;

before(async () => {
  if (!hasPi) return;

  agentDir = mkdtempSync(join(tmpdir(), "provider-cost-rpc-"));
  child = spawn("pi", ["--mode", "rpc", "--no-session", "-ne", "-e", EXTENSION], {
    cwd: ROOT,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Boot handshake: the extension publishes its status channel on session start.
  await readUntil((record) => record.method === "setStatus" && record.statusKey === SETTINGS_ROOT_KEY);
});

after(() => {
  child?.kill();
  if (agentDir) rmSync(agentDir, { recursive: true, force: true });
});

/** Reads stdout until `predicate` matches a record, or the timeout expires. */
function readUntil(predicate: (record: RpcRecord) => boolean, timeoutMs = RESPONSE_TIMEOUT_MS): Promise<RpcRecord> {
  assert.ok(child, "pi is running");
  const proc = child;

  return new Promise((resolvePromise, rejectPromise) => {
    let buffer = "";
    const timer = setTimeout(() => {
      proc.stdout.off("data", onData);
      rejectPromise(new Error("timed out waiting for a Pi RPC record"));
    }, timeoutMs);

    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        let record: RpcRecord;
        try {
          record = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (predicate(record)) {
          clearTimeout(timer);
          proc.stdout.off("data", onData);
          resolvePromise(record);
          return;
        }
      }
    };

    proc.stdout.on("data", onData);
  });
}

/** Runs an extension command and asserts that Pi handed it to the extension. */
async function command(message: string): Promise<void> {
  assert.ok(child, "pi is running");
  const id = `cmd-${message}`;
  child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);

  const response = await readUntil((record) => record.type === "response" && record.id === id);
  assert.equal(response.data?.disposition, "handled", `${message} reaches the extension`);
}

/** Settings section as the extension persisted it. */
function section(): Record<string, unknown> {
  assert.ok(agentDir, "agent dir exists");
  if (!existsSync(join(agentDir, "settings.json"))) return {};
  return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))[SETTINGS_ROOT_KEY] ?? {};
}

/**
 * Waits for a persisted value (the command handler saves asynchronously). A short
 * timeout asserts that a value was *not* changed: rejected input must leave the
 * previous value in place.
 */
async function expectSetting(key: string, value: unknown, timeoutMs = 3000, reason = ""): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    last = section()[key];
    if (JSON.stringify(last) === JSON.stringify(value)) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  assert.fail(`${key} is ${JSON.stringify(last)}, expected ${JSON.stringify(value)}${reason ? ` (${reason})` : ""}`);
}

test("status: reports without changing anything", { skip: SKIP }, async () => {
  await command("/provider-cost status");
  await command("/provider-cost");
  assert.deepEqual(section(), {}, "the status command persists nothing");
});

test("on/off/toggle: the display switch is persisted", { skip: SKIP }, async () => {
  await command("/provider-cost off");
  await expectSetting("enabled", false);

  await command("/provider-cost on");
  await expectSetting("enabled", true);

  await command("/provider-cost toggle");
  await expectSetting("enabled", false);

  await command("/provider-cost on");
  await expectSetting("enabled", true);
});

test("session: toggle and BYOK basis are persisted, invalid input is rejected", { skip: SKIP }, async () => {
  await command("/provider-cost session off");
  await expectSetting("patchSessionCost", false);

  await command("/provider-cost session basis openrouter");
  await expectSetting("sessionCostBasis", "openrouter");
  assert.equal(section().patchSessionCost, false, "the basis change keeps the toggle");

  await command("/provider-cost session toggle");
  await expectSetting("patchSessionCost", true);

  await command("/provider-cost session basis bogus");
  await expectSetting("sessionCostBasis", "openrouter", 200, "invalid basis is rejected");
});

test("currency/icons/style: valid values are persisted, invalid ones rejected", { skip: SKIP }, async () => {
  await command("/provider-cost currency EUR");
  await expectSetting("currency", "EUR");

  await command("/provider-cost currency XYZ");
  await expectSetting("currency", "EUR", 200, "unknown currency is rejected");

  await command("/provider-cost icons ascii");
  await expectSetting("icons", "ascii");

  await command("/provider-cost icons emoji");
  await expectSetting("icons", "ascii", 200);

  await command("/provider-cost style reverse");
  await expectSetting("deviationStyle", "reverse");

  await command("/provider-cost style italic");
  await expectSetting("deviationStyle", "reverse", 200);
});

test("color/switchColor: specs are canonicalised, invalid ones rejected", { skip: SKIP }, async () => {
  await command("/provider-cost color bold:Yellow");
  await expectSetting("color", "bold:yellow");

  await command("/provider-cost color warning");
  await expectSetting("color", "bold:yellow", 200, "theme names are not colour specs");

  await command("/provider-cost switchColor #FFD700");
  await expectSetting("switchColor", "#FFD700");
});

test("threshold: sets one threshold, rejects unusable input", { skip: SKIP }, async () => {
  await command("/provider-cost threshold orange 25");
  await expectSetting("deviationThresholds", { green: 10, yellow: 10, orange: 25 });

  await command("/provider-cost threshold orange");
  await command("/provider-cost threshold blue 5");
  await command("/provider-cost threshold orange -1");
  await expectSetting("deviationThresholds", { green: 10, yellow: 10, orange: 25 }, 200);
});

test("lookup: toggles the provider resolution", { skip: SKIP }, async () => {
  await command("/provider-cost lookup off");
  await expectSetting("lookupUpstreamProvider", false);

  await command("/provider-cost lookup on");
  await expectSetting("lookupUpstreamProvider", true);

  await command("/provider-cost lookup refresh");
  await expectSetting("lookupUpstreamProvider", true, 200, "refresh only clears the caches");
});

test("refresh: reloads the exchange rates without a model call", { skip: SKIP }, async () => {
  await command("/provider-cost refresh");
  assert.equal(section().currency, "EUR", "the configured currency survives");
});

test("unknown options and commands are rejected without a crash", { skip: SKIP }, async () => {
  await command("/provider-cost nonsense");
  await command("/provider-cost session nonsense");
  await command("/provider-cost session basis");

  await command("/provider-cost status");
  assert.equal(section().lookupUpstreamProvider, true, "the process is still alive and configured");
});

test("shutdown: Pi ends cleanly", { skip: SKIP }, async () => {
  assert.ok(child);
  const id = "shutdown";
  child.stdin.write(`${JSON.stringify({ id, type: "shutdown" })}\n`);
  const response = await readUntil((record) => record.type === "response" && record.id === id);
  assert.equal(response.type, "response");
});
