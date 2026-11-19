import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKeeper } from '../server/keeper.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quick = { health: 200, unwell: 2, restarts: 5, restartWindow: 60_000, linger: 300, quietWithoutBrowser: 60_000 };

async function waitFor(check, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error('timed out');
}

const ask = (port, token, route = 'notes') =>
  fetch(`http://127.0.0.1:${port}/api/${route}`, { headers: { 'X-Atlas-Token': token } }).then((res) => res.status).catch(() => 0);

/** A "browser" that holds the window until the test closes it. */
function fakeBrowser() {
  const made = [];
  const launch = () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    made.push(child);
    return child;
  };
  return { launch, made };
}

test('the keeper brings a stopped server back on the same port, with the same token', { timeout: 60_000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-keeper-'));
  const lines = [];
  const browser = fakeBrowser();
  const keeper = createKeeper({ dataDir, log: (line) => lines.push(line), rules: quick, browser: browser.launch, port: 0 });
  t.after(async () => {
    await keeper.stop();
    for (const child of browser.made) child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const { port, token } = await keeper.start();
  assert.equal(await ask(port, token), 200, 'the window can talk to it');
  assert.equal(browser.made.length, 1, 'and the window was opened');

  // the server dies: back in a moment, where the window looks for it, taking the same token
  const first = keeper.serverPid;
  process.kill(first);
  await waitFor(() => lines.includes(`server back on port ${port}`));
  assert.notEqual(keeper.serverPid, first);
  assert.equal(await ask(port, token), 200, 'the same window goes on: same port, same token');
  assert.ok(lines.some((line) => line.startsWith('server stopped by itself')), lines.join('\n'));
});

test('the keeper and its server go once the window closes', { timeout: 60_000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-keeper-'));
  const lines = [];
  const browser = fakeBrowser();
  const keeper = createKeeper({ dataDir, log: (line) => lines.push(line), rules: quick, browser: browser.launch, port: 0 });
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const { port, token } = await keeper.start();
  // the window stays open well past the health checks: nothing stops
  await sleep(6000);
  assert.equal(await ask(port, token), 200);
  browser.made[0].kill();
  await waitFor(() => lines.includes('stopped'), 20_000);
  assert.equal(await ask(port, token), 0, 'the server is gone');
  assert.ok(!fs.existsSync(path.join(dataDir, 'server.json')), 'and it cleared its files');
  assert.ok(lines.includes('window closed: stopping'), lines.join('\n'));
});

// Windows cannot pause a process with a signal (SIGSTOP), so there the hang is not made up
test('a server that stops answering is replaced', { timeout: 60_000, skip: process.platform === 'win32' }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-keeper-'));
  const lines = [];
  const browser = fakeBrowser();
  const keeper = createKeeper({ dataDir, log: (line) => lines.push(line), rules: quick, browser: browser.launch, port: 0 });
  t.after(async () => {
    await keeper.stop();
    for (const child of browser.made) child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const { port, token } = await keeper.start();
  const first = keeper.serverPid;
  // a hung process: alive, but answering nothing
  process.kill(first, 'SIGSTOP');
  await waitFor(() => lines.includes(`server back on port ${port}`), 30_000);
  assert.ok(lines.some((line) => line.startsWith('server did not answer')), lines.join('\n'));
  assert.equal(await ask(port, token), 200);
});
