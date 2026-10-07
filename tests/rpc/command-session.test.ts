/**
 * Free integration test for the session-cost commands (`npm run test:rpc`).
 *
 * Drives a real Pi in RPC mode with only this extension loaded and checks that
 * `/provider-cost session …` is handled and persisted. No model call, so it costs
 * nothing; Pi runs against a throwaway config directory
 * (`PI_CODING_AGENT_DIR`), so the real settings are never touched.
 *
 * Not part of `npm run check` (it needs an installed `pi`); it skips itself when
 * `pi` is not on PATH.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTENSION = join(ROOT, "extensions", "realtime-provider-cost.ts");
const SETTINGS_ROOT_KEY = "realtime-provider-cost";
const RESPONSE_TIMEOUT_MS = 30_000;

interface RpcResponse {
  id?: string;
  type: string;
  command?: string;
  data?: { disposition?: string };
  method?: string;
  statusKey?: string;
  message?: string;
}

const hasPi = spawnSync("pi", ["--version"], { stdio: "ignore" }).status === 0;

let child: ChildProcessWithoutNullStreams | undefined;
let agentDir: string | undefined;

after(() => {
  child?.kill();
  if (agentDir) rmSync(agentDir, { recursive: true, force: true });
});

/** Settings section as the extension persisted it (throws while it is absent). */
function section(): Record<string, unknown> {
  assert.ok(agentDir, "agent dir exists");
  const raw = readFileSync(join(agentDir, "settings.json"), "utf8");
  return JSON.parse(raw)[SETTINGS_ROOT_KEY] ?? {};
}

async function start(): Promise<void> {
  agentDir = mkdtempSync(join(tmpdir(), "provider-cost-rpc-"));
  child = spawn(
    "pi",
    ["--mode", "rpc", "--no-session", "-ne", "-e", EXTENSION],
    {
      cwd: ROOT,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  // Boot handshake: the extension publishes its status channel on session start.
  await readUntil(
    (record) => record.method === "setStatus" && record.statusKey === SETTINGS_ROOT_KEY,
  );
}

/** Reads stdout until `predicate` matches a record, or the timeout expires. */
function readUntil(
  predicate: (record: RpcResponse) => boolean,
  timeoutMs = RESPONSE_TIMEOUT_MS,
): Promise<RpcResponse> {
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
        let record: RpcResponse;
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

/** Sends one command and returns its response. */
async function send(id: string, record: Record<string, unknown>): Promise<RpcResponse> {
  assert.ok(child, "pi is running");
  child.stdin.write(`${JSON.stringify({ id, ...record })}\n`);
  return readUntil((entry) => entry.type === "response" && entry.id === id);
}

/** Runs an extension command and asserts that Pi handed it to the extension. */
async function command(message: string): Promise<void> {
  const response = await send(`cmd-${message}`, { type: "prompt", message });
  assert.equal(response.data?.disposition, "handled", `${message} reaches the extension`);
}

test("session-cost commands persist and reach the extension", { skip: !hasPi }, async () => {
  await start();

  await command("/provider-cost session off");
  assert.equal(section().patchSessionCost, false);

  await command("/provider-cost session basis openrouter");
  assert.equal(section().sessionCostBasis, "openrouter");
  assert.equal(section().patchSessionCost, false, "basis change keeps the toggle");

  await command("/provider-cost session toggle");
  assert.equal(section().patchSessionCost, true);

  await command("/provider-cost session basis bogus");
  assert.equal(section().sessionCostBasis, "openrouter", "invalid basis is rejected");

  await command("/provider-cost session on");
  assert.equal(section().patchSessionCost, true);

  await command("/provider-cost status");
  assert.equal((await send("shutdown", { type: "shutdown" })).type, "response");
});
