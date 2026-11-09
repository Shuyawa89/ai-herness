import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const helper = new URL("../scripts/lib_cdp.mjs", import.meta.url).href;

function runFixture(mode, missingExecutable = false) {
  const dir = mkdtempSync(join(tmpdir(), "deck-cdp-test-"));
  try {
    const chrome = join(dir, "chrome"), log = join(dir, "launch.json");
    writeFileSync(chrome, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
const profile = args.find(a => a.startsWith('--user-data-dir=')).split('=').slice(1).join('=');
fs.writeFileSync(process.env.FIXTURE_LOG, JSON.stringify({args, profile, pid: process.pid}));
if (process.env.FIXTURE_MODE === 'exit') process.exit(7);
if (process.env.FIXTURE_MODE === 'stubborn') process.on('SIGTERM', () => {});
if (process.env.FIXTURE_MODE !== 'timeout')
  fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), '43123\\n/devtools/browser/owned-fixture\\n');
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
import { openPage } from ${JSON.stringify(helper)};
const endpoints = [], fetches = [];
globalThis.fetch = async (url) => { fetches.push(url); return {ok: true, json: async () => ({webSocketDebuggerUrl: 'ws://unowned-browser'})}; };
globalThis.WebSocket = class {
  constructor(url) { endpoints.push(url); setImmediate(() => process.env.FIXTURE_MODE === 'websocket-error' ? this.onerror?.() : this.onopen?.()); }
  send(raw) {
    const message = JSON.parse(raw);
    const result = message.method === 'Target.createTarget' ? {targetId: 'target'}
      : message.method === 'Target.attachToTarget' ? {sessionId: 'session'} : {};
    setImmediate(() => {
      this.onmessage?.({data: JSON.stringify(process.env.FIXTURE_MODE === 'command-error'
        ? {id: message.id, error: {message: 'fixture command failed'}} : {id: message.id, result})});
      if (message.method === 'Page.navigate') this.onmessage?.({data: JSON.stringify({method: 'Page.loadEventFired'})});
    });
  }
  close() { this.onclose?.(); }
};
try { const page = await openPage('fixture.html'); await page.close(); await page.close(); console.log(JSON.stringify({ok: true, endpoints, fetches})); }
catch (error) { console.log(JSON.stringify({ok: false, error: error.message, endpoints, fetches})); }
`], {
      env: { ...process.env, CHROME_PATH: missingExecutable ? join(dir, "missing") : chrome,
        FIXTURE_MODE: mode, FIXTURE_LOG: log, TMPDIR: dir },
      encoding: "utf8", timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const output = JSON.parse(result.stdout.trim());
    if (existsSync(log)) {
      output.launch = JSON.parse(readFileSync(log, "utf8"));
      assert.equal(existsSync(output.launch.profile), false, "owned browser profile was cleaned up");
      assert.throws(() => process.kill(output.launch.pid, 0), {code: "ESRCH"}, "owned browser stopped");
    }
    assert.deepEqual(readdirSync(dir).filter(name => name.startsWith("chr-deck-")), []);
    return output;
  } finally { rmSync(dir, {recursive: true, force: true}); }
}

test("connects only to the endpoint advertised by the launched browser's profile", () => {
  const output = runFixture("ready");
  assert.equal(output.ok, true, output.error);
  assert.ok(output.launch.args.includes("--remote-debugging-port=0"));
  assert.deepEqual(output.endpoints, ["ws://127.0.0.1:43123/devtools/browser/owned-fixture"]);
  assert.deepEqual(output.fetches, []);
});

test("browser exit before startup rejects without connecting elsewhere", () => {
  const output = runFixture("exit");
  assert.equal(output.ok, false);
  assert.match(output.error, /exited/i);
  assert.deepEqual(output.endpoints, []);
});

test("startup timeout rejects and cleans up its owned profile", () => {
  const output = runFixture("timeout");
  assert.equal(output.ok, false);
  assert.match(output.error, /endpoint not ready/i);
  assert.deepEqual(output.endpoints, []);
});

test("spawn error rejects without an unhandled process error", () => {
  const output = runFixture("ready", true);
  assert.equal(output.ok, false);
  assert.match(output.error, /ENOENT/);
  assert.deepEqual(output.endpoints, []);
});

test("websocket and initialization command failures clean up the launched browser", () => {
  for (const mode of ["websocket-error", "command-error"]) {
    const output = runFixture(mode);
    assert.equal(output.ok, false);
    assert.match(output.error, /connection failed|fixture command failed/);
  }
});

test("cleanup stops a browser that ignores the initial termination signal", () => {
  const output = runFixture("stubborn");
  assert.equal(output.ok, true, output.error);
});
