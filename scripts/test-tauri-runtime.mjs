import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const resources = resolve(process.env.CHAT2TASKS_TAURI_TEST_RESOURCES ?? 'work/tauri');
const supervisor = resolve(
  process.env.CHAT2TASKS_TAURI_TEST_SUPERVISOR ?? 'desktop/tauri-runtime.cjs',
);
const bun = join(resources, 'bun', process.platform === 'win32' ? 'bun.exe' : 'bun');
const origin = process.platform === 'win32' ? 'http://tauri.localhost' : 'tauri://localhost';
const passphrase = 'fictional test passphrase';
const temp = tmpdir();
if (process.platform === 'win32' && process.env.C2T_TEST_CROSS_DRIVE === '1') {
  assert.notEqual(
    parse(resources).root.toLowerCase(),
    parse(temp).root.toLowerCase(),
    'The Windows regression check needs the app and test workspace on different drives.',
  );
}
const root = await mkdtemp(join(temp, 'chat2tasks-tauri-offline-'));

async function reportDiagnostics(data, output) {
  const key = await readFile(join(data, 'gateway', 'data', '.api-key'), 'utf8').catch(() => '');
  if (key.trim()) output = output.replaceAll(key.trim(), '[redacted]');
  output = output
    .replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w-]+)\b/g, '[redacted]')
    .replace(/\bowa_k1_[A-Za-z0-9]+(?:…|\.\.\.)?/g, '[redacted]')
    .replace(/\b[\da-f]{32,}\b/gi, '[redacted]');
  if (output) process.stderr.write(`Local test diagnostics:\n${output}\n`);
}

async function start(demo) {
  const data = join(root, demo ? 'sample' : 'preview');
  let diagnostics = '';
  const child = spawn(bun, [supervisor], {
    env: {
      ...process.env,
      C2T_TAURI_RESOURCES: resources,
      C2T_TAURI_DATA: data,
      C2T_TAURI_DEMO: demo ? '1' : '0',
      C2T_TAURI_TEST_DIAGNOSTICS: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-16000);
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
      ready,
      clearDiagnostics() {
        diagnostics = '';
      },
      async reportDiagnostics() {
        await reportDiagnostics(data, diagnostics);
      },
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
    await reportDiagnostics(data, diagnostics);
    throw error;
  }
}

let sample;
let preview;
let reservation;
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
  const duplicate = spawn(bun, [supervisor], {
    env: {
      ...process.env,
      C2T_TAURI_RESOURCES: resources,
      C2T_TAURI_DATA: preview.data,
      C2T_TAURI_DEMO: '0',
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const duplicateLines = createInterface({ input: duplicate.stdout });
  try {
    const [line] = await once(duplicateLines, 'line');
    const result = JSON.parse(line);
    assert.equal(result.type, 'error', 'The same local workspace must not start twice.');
    assert.equal(result.code, 'already_running');
  } finally {
    if (duplicate.exitCode === null && duplicate.signalCode === null) {
      const exited = once(duplicate, 'exit');
      duplicate.stdin.write('{"action":"shutdown"}\n');
      await exited;
    }
    duplicateLines.close();
  }
  assert.equal((await preview.fetch('/api/state')).status, 200);
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
  preview.clearDiagnostics();
  imported = await preview.request({ action: 'import', path: transfer, passphrase });
  if (!imported.ok) await preview.reportDiagnostics();
  assert.equal(imported.ok, true, imported.error);
  response = await preview.fetch('/api/state');
  state = await response.json();
  assert.equal(response.status, 200);
  assert.equal(state.tasks.length, 8);
  assert.ok(
    (await readdir(preview.data)).some((name) => name.startsWith('workspace.before-import-')),
  );
  response = await preview.fetch('/api/desktop/whatsapp/status');
  assert.equal((await response.json()).status, 'not_connected');
  const gatewayKey = await readFile(join(preview.data, 'gateway', 'data', '.api-key'));
  response = await preview.fetch('/api/settings');
  let config = await response.json();
  response = await preview.fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      settings: {
        ...config.settings,
        desktopGateway: {
          ...config.settings.desktopGateway,
          mode: 'remote',
          remoteUrl: 'http://127.0.0.1:1',
        },
      },
      secrets: { 'remote-openwa': 'fictional-key' },
      removeSecrets: [],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).desktopGatewayRestartRequired, true);
  await preview.stop();
  preview = await start(false);
  assert.equal(preview.ready.gatewayMode, 'remote');
  assert.equal(preview.ready.localGatewayRunning, false);
  config = await (await preview.fetch('/api/settings')).json();
  assert.equal(config.settings.desktopGateway.activeMode, 'remote');
  assert.equal((await (await preview.fetch('/api/state')).json()).tasks.length, 8);
  assert.deepEqual(await readFile(join(preview.data, 'gateway', 'data', '.api-key')), gatewayKey);
  imported = await preview.request({ action: 'import', path: transfer, passphrase });
  assert.equal(imported.ok, true, imported.error);
  assert.equal(imported.gatewayMode, 'local');
  assert.equal(imported.resumeSessions, false);
  assert.deepEqual(await readFile(join(preview.data, 'gateway', 'data', '.api-key')), gatewayKey);
  config = await (await preview.fetch('/api/settings')).json();
  response = await preview.fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      settings: {
        ...config.settings,
        desktopGateway: {
          ...config.settings.desktopGateway,
          mode: 'remote',
          remoteUrl: 'http://127.0.0.1:1',
        },
      },
      secrets: { 'remote-openwa': 'fictional-key' },
      removeSecrets: [],
    }),
  });
  assert.equal(response.status, 200);
  await preview.stop();
  preview = await start(false);
  config = await (await preview.fetch('/api/settings')).json();
  response = await preview.fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      settings: {
        ...config.settings,
        desktopGateway: { ...config.settings.desktopGateway, mode: 'local' },
      },
      secrets: {},
      removeSecrets: [],
    }),
  });
  assert.equal(response.status, 200);
  await preview.stop();
  preview = await start(false);
  assert.equal(preview.ready.gatewayMode, 'local');
  assert.equal(preview.ready.resumeSessions, false);
  assert.deepEqual(await readFile(join(preview.data, 'gateway', 'data', '.api-key')), gatewayKey);
  reservation = createServer((socket) => socket.on('error', () => undefined));
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  const sharingPort = address.port;
  const sharingOrigin = 'https://shared.example:8443';
  response = await preview.fetch('/api/desktop/sharing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'enabled',
      origin: sharingOrigin,
      port: sharingPort,
      password: 'fictional-sharing-password',
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).restartRequired, true);
  await preview.stop();
  preview = await start(false);
  assert.notEqual(preview.ready.origin, `http://127.0.0.1:${sharingPort}`);
  assert.equal(preview.ready.localGatewayRunning, false);
  response = await fetch(preview.ready.origin + '/api/desktop/sharing', {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,x-chat2tasks-session',
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  response = await preview.fetch('/api/desktop/sharing');
  const unavailable = await response.json();
  assert.equal(unavailable.active.kind, 'disabled');
  assert.equal(unavailable.unavailableReason, 'port_in_use');
  response = await preview.fetch('/api/tick', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'any-task', done: true }),
  });
  assert.equal(response.status, 503);
  assert.equal((await preview.fetch('/api/companion/captures')).status, 503);
  assert.equal((await preview.fetch('/api/webhooks/openwa', { method: 'POST' })).status, 503);
  await preview.stop();
  await new Promise((resolve) => reservation.close(resolve));
  reservation = undefined;
  preview = await start(false);
  assert.equal(preview.ready.origin, `http://127.0.0.1:${sharingPort}`);
  response = await preview.fetch('/api/desktop/sharing');
  assert.equal((await response.json()).restartRequired, false);
  const remoteHeaders = { Host: 'shared.example:8443', Origin: sharingOrigin };
  const remoteCall = (path, method, headers, body = '') =>
    new Promise((resolve, reject) => {
      const request = httpRequest(preview.ready.origin + path, { method, headers }, (result) => {
        result.resume();
        result.once('end', () =>
          resolve({ status: result.statusCode, cookies: result.headers['set-cookie'] ?? [] }),
        );
      });
      request.once('error', reject);
      request.end(body);
    });
  assert.equal((await remoteCall('/api/state', 'GET', remoteHeaders)).status, 401);
  const signedIn = await remoteCall(
    '/desktop-sign-in',
    'POST',
    { ...remoteHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
    new URLSearchParams({ password: 'fictional-sharing-password' }).toString(),
  );
  assert.equal(signedIn.status, 303);
  const session = signedIn.cookies[0]?.split(';')[0];
  assert.ok(session);
  assert.equal(
    (await remoteCall('/api/state', 'GET', { ...remoteHeaders, Cookie: session })).status,
    200,
  );
  process.stdout.write(
    'Bun sample, workspace transfer, local/remote server switching, and desktop sharing passed.\n',
  );
} finally {
  await sample?.stop();
  await preview?.stop();
  if (reservation?.listening) await new Promise((resolve) => reservation.close(resolve));
  await rm(root, { recursive: true, force: true });
}
