import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const resources = resolve(process.env.CHAT2TASKS_TAURI_TEST_RESOURCES ?? 'work/tauri');
const supervisor = resolve(
  process.env.CHAT2TASKS_TAURI_TEST_SUPERVISOR ?? 'desktop/tauri-runtime.cjs',
);
const bun = join(resources, 'bun', process.platform === 'win32' ? 'bun.exe' : 'bun');
const origin = process.platform === 'win32' ? 'http://tauri.localhost' : 'tauri://localhost';
const passphrase = 'fictional test passphrase';
const root = await mkdtemp(join(tmpdir(), 'chat2tasks-tauri-offline-'));

async function start(demo) {
  const data = join(root, demo ? 'sample' : 'preview');
  const child = spawn(bun, [supervisor], {
    env: {
      ...process.env,
      C2T_TAURI_RESOURCES: resources,
      C2T_TAURI_DATA: data,
      C2T_TAURI_DEMO: demo ? '1' : '0',
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  const timeout = setTimeout(() => child.kill(), 45000);
  async function next() {
    const line = await iterator.next();
    assert.equal(line.done, false, 'The local service stopped unexpectedly.');
    return JSON.parse(line.value);
  }
  try {
    const ready = await next();
    assert.equal(ready.type, 'ready');
    assert.equal(ready.demo, demo);
    const headers = { Origin: origin, 'X-Chat2Tasks-Session': ready.token };
    return {
      data,
      async fetch(path, options = {}) {
        return fetch(ready.origin + path, {
          ...options,
          headers: { ...headers, ...options.headers },
        });
      },
      async request(value) {
        child.stdin.write(JSON.stringify(value) + '\n');
        return next();
      },
      async stop() {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.stdin.write('{"action":"shutdown"}\n');
          await exited;
        }
        clearTimeout(timeout);
        lines.close();
      },
    };
  } catch (error) {
    child.kill();
    clearTimeout(timeout);
    lines.close();
    throw error;
  }
}

let sample;
let preview;
try {
  sample = await start(true);
  let response = await sample.fetch('/api/state');
  let state = await response.json();
  assert.equal(response.status, 200);
  assert.equal(state.demo, true);
  assert.equal(state.tasks.length, 8);
  assert.equal((await readdir(sample.data)).includes('gateway'), false);
  response = await sample.fetch('/api/workspace/transfer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passphrase }),
  });
  assert.equal(response.status, 200);
  const transfer = join(root, 'fictional-workspace.c2t');
  await writeFile(transfer, Buffer.from(await response.arrayBuffer()));
  await sample.stop();
  sample = undefined;

  preview = await start(false);
  response = await preview.fetch('/api/desktop/status');
  assert.equal(response.status, 200);
  const desktop = await response.json();
  assert.equal(desktop.codex.installed, true);
  assert.equal(desktop.codex.signedIn, false);
  response = await preview.fetch('/api/desktop/whatsapp/status');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'not_connected');
  const keyBefore = await readFile(join(preview.data, 'workspace', 'vault.key'));
  let imported = await preview.request({
    action: 'import',
    path: transfer,
    passphrase: 'incorrect passphrase',
  });
  assert.equal(imported.ok, false);
  assert.deepEqual(await readFile(join(preview.data, 'workspace', 'vault.key')), keyBefore);
  imported = await preview.request({ action: 'import', path: transfer, passphrase });
  assert.equal(imported.ok, true);
  response = await preview.fetch('/api/state');
  state = await response.json();
  assert.equal(response.status, 200);
  assert.equal(state.tasks.length, 8);
  assert.ok(
    (await readdir(preview.data)).some((name) => name.startsWith('workspace.before-import-')),
  );
  response = await preview.fetch('/api/desktop/whatsapp/status');
  assert.equal((await response.json()).status, 'not_connected');
  process.stdout.write('Bun sample, unlinked gateway, and workspace transfer passed.\n');
} finally {
  await sample?.stop();
  await preview?.stop();
  await rm(root, { recursive: true, force: true });
}
