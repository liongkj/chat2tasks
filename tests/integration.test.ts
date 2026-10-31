import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { Store, hash } from '../src/server/store.js';
import { OpenWA } from '../src/server/openwa.js';
import { Sync } from '../src/server/sync.js';
import { connectionRequest } from '../src/server/ai.js';
import { desktopSessionCookie, validDesktopSession } from '../src/server/desktop-session.js';
import { SettingsSchema, MessageSchema } from '../src/shared/schema.js';

test('a desktop workspace opens while WhatsApp starts and reports when it is ready', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat2tasks-desktop-start-'));
  const keyFile = join(dir, 'gateway-key');
  writeFileSync(keyFile, 'fixture-key');
  const store = new Store(join(dir, 'workspace'));
  store.setMeta('desktop_setup_complete', true);
  store.saveDesktopSharing({
    kind: 'enabled',
    origin: 'https://shared.example:8443',
    port: 2786,
    password: 'fictional-sharing-password',
  });
  store.close();
  let gatewayReady = false;
  const gateway = createServer((_request, response) => {
    response.writeHead(gatewayReady ? 200 : 503, { 'Content-Type': 'application/json' });
    response.end('{}');
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const address = gateway.address();
  assert.ok(address && typeof address !== 'string');
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const reserved = reservation.address();
  assert.ok(reserved && typeof reserved !== 'string');
  const port = reserved.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      CHAT2TASKS_DESKTOP: 'true',
      SYNC_DISABLED: 'true',
      PORT: String(port),
      PUBLIC_ORIGIN: base,
      BIND_HOST: '127.0.0.1',
      APP_PASSWORD: '',
      DATA_DIR: join(dir, 'workspace'),
      DESKTOP_OPENWA_URL: `http://127.0.0.1:${address.port}`,
      DESKTOP_OPENWA_KEY_FILE: keyFile,
      CHAT2TASKS_TAURI_ORIGIN: 'tauri://localhost',
      CHAT2TASKS_TAURI_TOKEN: 'a'.repeat(64),
    },
  });
  let output = '';
  child.stdout.on('data', (data: Buffer) => (output += data.toString().slice(0, 8192)));
  child.stderr.on('data', (data: Buffer) => (output += data.toString().slice(0, 8192)));
  async function state() {
    const response = await fetch(base + '/api/state', {
      headers: { Origin: 'tauri://localhost', 'X-Chat2Tasks-Session': 'a'.repeat(64) },
    });
    assert.equal(response.status, 200);
    return z
      .object({ status: z.object({ syncing: z.boolean(), phase: z.string() }) })
      .parse(await response.json()).status;
  }
  try {
    let first: Awaited<ReturnType<typeof state>> | undefined;
    for (let attempt = 0; attempt < 300; attempt++) {
      try {
        first = await state();
        break;
      } catch {
        if (child.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.ok(first, `the workspace should open before the gateway is ready: ${output}`);
    assert.equal(first.syncing, true);
    assert.match(first.phase, /Starting WhatsApp/);
    const preflight = await fetch(base + '/api/state', {
      method: 'OPTIONS',
      headers: {
        Origin: 'tauri://localhost',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'x-chat2tasks-session',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'tauri://localhost');
    assert.equal((await fetch(base + '/api/state')).status, 403);
    assert.equal(
      (
        await fetch(base + '/api/state', {
          headers: { Origin: 'tauri://localhost', 'X-Chat2Tasks-Session': 'wrong' },
        })
      ).status,
      403,
    );
    const authorized = await fetch(base + '/api/state', {
      headers: { Origin: 'tauri://localhost', 'X-Chat2Tasks-Session': 'a'.repeat(64) },
    });
    assert.equal(authorized.status, 200);
    assert.equal(authorized.headers.get('access-control-allow-origin'), 'tauri://localhost');
    const remoteHeaders = { Host: 'shared.example:8443', Origin: 'https://shared.example:8443' };
    const remoteCall = (path: string, method: string, headers: Record<string, string>, body = '') =>
      new Promise<{ status: number; cookies: string[] }>((resolve, reject) => {
        const request = httpRequest(base + path, { method, headers }, (response) => {
          response.resume();
          response.once('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              cookies: response.headers['set-cookie'] ?? [],
            }),
          );
        });
        request.once('error', reject);
        request.end(body);
      });
    assert.equal((await remoteCall('/api/state', 'GET', remoteHeaders)).status, 401);
    const signIn = await remoteCall(
      '/desktop-sign-in',
      'POST',
      { ...remoteHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
      new URLSearchParams({ password: 'fictional-sharing-password' }).toString(),
    );
    assert.equal(signIn.status, 303);
    const cookie = signIn.cookies[0]?.split(';')[0];
    assert.ok(cookie, 'a remote desktop can sign in');
    assert.equal(
      (await remoteCall('/api/state', 'GET', { ...remoteHeaders, Cookie: cookie })).status,
      200,
    );
    assert.equal(
      (await remoteCall('/api/desktop/sharing', 'GET', { ...remoteHeaders, Cookie: cookie }))
        .status,
      403,
      'a remote client cannot change the host computer sharing configuration',
    );
    const localSharing = await fetch(base + '/api/desktop/sharing', {
      headers: { Origin: 'tauri://localhost', 'X-Chat2Tasks-Session': 'a'.repeat(64) },
    });
    const sharingStatus = await localSharing.json();
    assert.equal(localSharing.status, 200);
    assert.equal(sharingStatus.restartRequired, false);
    assert.equal(JSON.stringify(sharingStatus).includes('fictional-sharing-password'), false);
    const disableSharing = await fetch(base + '/api/desktop/sharing', {
      method: 'POST',
      headers: {
        Origin: 'tauri://localhost',
        'X-Chat2Tasks-Session': 'a'.repeat(64),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ kind: 'disabled' }),
    });
    assert.equal(disableSharing.status, 200);
    assert.equal((await disableSharing.json()).restartRequired, true);
    const untrusted = await fetch(base + '/api/state', {
      headers: { Origin: 'https://example.invalid', 'X-Chat2Tasks-Session': 'a'.repeat(64) },
    });
    assert.notEqual(
      untrusted.headers.get('access-control-allow-origin'),
      'https://example.invalid',
    );
    gatewayReady = true;
    let ready = first;
    for (let attempt = 0; attempt < 100 && ready.syncing; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      ready = await state();
    }
    assert.equal(ready.syncing, false);
  } finally {
    gatewayReady = true;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    timeout.unref();
    await exited;
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('changing the workspace password invalidates a desktop session', () => {
  const key = Buffer.alloc(32, 1);
  const cookie = desktopSessionCookie(key, 'original-password', true);
  assert.equal(validDesktopSession(cookie, key, 'original-password'), true);
  assert.equal(validDesktopSession(cookie, key, 'new-password'), false);
  assert.equal(validDesktopSession(cookie, Buffer.alloc(32, 2), 'original-password'), false);
});

test('a fresh server enables onboarding and connects its gateway without exposing the API key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wawa-managed-server-'));
  const keyFile = join(dir, 'gateway-key');
  writeFileSync(keyFile, 'fixture-gateway-secret');
  const gateway = createServer((_request, response) => response.end('{}'));
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const gatewayAddress = gateway.address();
  assert.ok(gatewayAddress && typeof gatewayAddress !== 'string');
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const base = `http://127.0.0.1:${address.port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: process.cwd(),
    stdio: 'ignore',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      WAWA_MANAGED_SERVER: 'true',
      CHAT2TASKS_DESKTOP: 'false',
      SYNC_DISABLED: 'true',
      PORT: String(address.port),
      PUBLIC_ORIGIN: base,
      BIND_HOST: '127.0.0.1',
      APP_PASSWORD: '',
      CODEX_BIN: join(dir, 'codex-not-installed'),
      DATA_DIR: join(dir, 'workspace'),
      DESKTOP_OPENWA_URL: `http://127.0.0.1:${gatewayAddress.port}`,
      DESKTOP_OPENWA_KEY_FILE: keyFile,
      DESKTOP_WEBHOOK_URL: 'http://wawa:2786/api/webhooks/openwa',
      CHAT2TASKS_TAURI_ORIGIN: '',
      CHAT2TASKS_TAURI_TOKEN: '',
    },
  });
  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        response = await fetch(base + '/api/setup-mode');
        break;
      } catch {
        if (child.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.ok(response, 'the managed server should start');
    assert.deepEqual(await response.json(), { managedServer: true });
    const setup = await (await fetch(base + '/api/desktop/status')).json();
    assert.equal(z.object({ setupComplete: z.boolean() }).parse(setup).setupComplete, false);
    const settings = await (await fetch(base + '/api/settings')).text();
    assert.ok(!settings.includes('fixture-gateway-secret'));
    assert.match(settings, /http:\/\/wawa:2786\/api\/webhooks\/openwa/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await exited;
    }
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an extra remote workspace address requires an app password even behind another proxy', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chat2tasks-remote-auth-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DEMO: 'false',
      SYNC_DISABLED: 'true',
      CHAT2TASKS_DESKTOP: 'false',
      PORT: '2786',
      PUBLIC_ORIGIN: 'http://127.0.0.1:2786',
      ADDITIONAL_ORIGINS: 'https://fixture.tailnet.ts.net',
      APP_PASSWORD: '',
      TRUST_PROXY_AUTH: 'true',
      DATA_DIR: directory,
    },
  });
  let error = '';
  child.stderr.on('data', (chunk: Buffer) => {
    error += chunk.toString();
  });
  try {
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    assert.notEqual(code, 0);
    assert.match(error, /Set APP_PASSWORD before adding a remote workspace address/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a server workspace processes a new message without a connected desktop client', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat2tasks-always-on-'));
  const workspace = join(dir, 'workspace');
  const change = {
    id: null,
    title: 'Prepare the report',
    scope: 'Reporting',
    note: 'A fictional request',
    source_ids: [hash(['session', 'chat', 'fixture-message'])],
    action_steps: ['Prepare the report'],
    done_when: ['The report is ready'],
    priority: 'normal',
    triage_state: 'ready',
    blocking_question: null,
  };
  const upstream = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url?.startsWith('/api/sessions/')) {
      response.end(JSON.stringify({ messages: [] }));
      return;
    }
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    const body = z
      .object({ messages: z.array(z.object({ content: z.unknown() })) })
      .parse(JSON.parse(raw));
    const review = String(body.messages[1]?.content).startsWith('Evaluate each named question');
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify(
                review
                  ? {
                      answers: [
                        { name: 'candidate_0', type: 'choice', choice: 'keep', confidence: 0.99 },
                      ],
                    }
                  : { changes: [change] },
              ),
            },
          },
        ],
        usage: { total_tokens: 12 },
      }),
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const store = new Store(workspace);
  store.saveSettings({
    settings: {
      ...store.settings(),
      openwaUrl: `http://127.0.0.1:${address.port}`,
      chats: [
        { id: 'active', name: 'Sample chat', sessionId: 'session', chatId: 'chat', enabled: true },
      ],
      profiles: [
        {
          id: 'fake',
          name: 'Fictional model',
          kind: 'compatible',
          model: 'fixture',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
        },
      ],
      activeProfileId: 'fake',
      quietSeconds: 0,
      trigger: { mode: 'automatic', decisionProfileId: null },
    },
    secrets: { openwa: 'fake-gateway-key', 'fake:key': 'fake-model-key' },
    removeSecrets: [],
  });
  const signingKey = store.webhookSecret();
  store.close();
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const reserved = reservation.address();
  assert.ok(reserved && typeof reserved !== 'string');
  const port = reserved.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: process.cwd(),
    stdio: 'ignore',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DEMO: 'false',
      SYNC_DISABLED: 'false',
      CHAT2TASKS_DESKTOP: 'false',
      PORT: String(port),
      PUBLIC_ORIGIN: base,
      BIND_HOST: '127.0.0.1',
      APP_PASSWORD: 'fictional-password',
      ADDITIONAL_ORIGINS: 'https://fixture.tailnet.ts.net',
      DATA_DIR: workspace,
    },
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 300 && !ready; attempt++) {
      try {
        ready = (await fetch(base + '/api/health')).ok;
      } catch {
        /* Server is starting. */
      }
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'the separate workspace server started');
    const call = (path: string, method: string, headers: Record<string, string>, body = '') =>
      new Promise<number>((resolve, reject) => {
        const request = httpRequest(base + path, { method, headers }, (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode ?? 0));
        });
        request.once('error', reject);
        request.end(body);
      });
    const tailnetHeaders = {
      Host: 'fixture.tailnet.ts.net',
      Origin: 'https://fixture.tailnet.ts.net',
    };
    const signIn = (password: string, origin = tailnetHeaders.Origin) =>
      new Promise<{ status: number; cookie: string; referrerPolicy: string }>((resolve, reject) => {
        const request = httpRequest(
          base + '/desktop-sign-in',
          {
            method: 'POST',
            headers: {
              ...tailnetHeaders,
              Origin: origin,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          },
          (response) => {
            response.resume();
            response.once('end', () =>
              resolve({
                status: response.statusCode ?? 0,
                cookie: response.headers['set-cookie']?.[0] ?? '',
                referrerPolicy: String(response.headers['referrer-policy'] ?? ''),
              }),
            );
          },
        );
        request.once('error', reject);
        request.end(new URLSearchParams({ password }).toString());
      });
    const signInPage = await fetch(base + '/desktop-sign-in', { headers: tailnetHeaders });
    assert.equal(signInPage.status, 200);
    assert.equal(signInPage.headers.get('referrer-policy'), 'same-origin');
    assert.equal((await signIn('fictional-password', 'https://unexpected.example')).status, 403);
    const wrongPassword = await signIn('wrong-password');
    assert.equal(wrongPassword.status, 401);
    assert.equal(wrongPassword.referrerPolicy, 'same-origin');
    const signedIn = await signIn('fictional-password');
    assert.equal(signedIn.status, 303);
    assert.match(signedIn.cookie, /HttpOnly/);
    assert.match(signedIn.cookie, /Secure/);
    assert.match(signedIn.cookie, /SameSite=Strict/);
    const session = signedIn.cookie.split(';')[0]!;
    assert.equal(
      await call('/desktop-sign-in', 'GET', { ...tailnetHeaders, Cookie: session }),
      303,
    );
    assert.equal(await call('/api/state', 'GET', { ...tailnetHeaders, Cookie: session }), 200);
    assert.equal(
      await call('/api/state', 'GET', { ...tailnetHeaders, Cookie: session + 'invalid' }),
      401,
    );
    assert.equal(await call('/api/state', 'GET', tailnetHeaders), 401);
    const authorization = 'Basic ' + Buffer.from('admin:fictional-password').toString('base64');
    assert.equal(
      await call('/api/state', 'GET', { ...tailnetHeaders, Authorization: authorization }),
      200,
    );
    assert.equal(
      await call('/api/state', 'GET', { Host: 'unexpected.example', Authorization: authorization }),
      403,
    );
    assert.equal(
      await call(
        '/api/preferences',
        'POST',
        {
          ...tailnetHeaders,
          Origin: 'https://unexpected.example',
          Authorization: authorization,
          'Content-Type': 'application/json',
        },
        '{}',
      ),
      403,
    );
    assert.equal(
      await call(
        '/api/preferences',
        'POST',
        { ...tailnetHeaders, Authorization: authorization, 'Content-Type': 'application/json' },
        '{}',
      ),
      200,
    );
    const payload = JSON.stringify({
      event: 'message.received',
      sessionId: 'session',
      data: { id: 'fixture-message', chatId: 'chat', body: 'Please prepare the report' },
    });
    const response = await fetch(base + '/api/webhooks/openwa', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OpenWA-Signature':
          'sha256=' + createHmac('sha256', signingKey).update(payload).digest('hex'),
      },
      body: payload,
    });
    assert.equal(response.status, 200);
    const database = new DatabaseSync(join(workspace, 'tasks.sqlite'), { readOnly: true });
    try {
      let task: unknown;
      for (let attempt = 0; attempt < 300 && !task; attempt++) {
        task = database.prepare('SELECT title FROM tasks WHERE title=?').get(change.title);
        if (!task) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(task, 'the server created a task without a desktop client');
    } finally {
      database.close();
    }
  } finally {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    timeout.unref();
    await exited;
    clearTimeout(timeout);
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('active chats alone reach OpenWA and the selected model; paused chats do not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat2tasks-flow-')),
    store = new Store(dir),
    requests: string[] = [];
  const change = {
    id: null,
    title: 'Restore the export column',
    scope: 'Exports',
    note: 'The request names the missing column',
    source_ids: [hash(['session', 'active', 'wa-message'])],
    action_steps: ['Restore the column'],
    done_when: ['The export has the column'],
    priority: 'normal',
    triage_state: 'ready',
    blocking_question: null,
  };
  const upstream = createServer(async (request, response) => {
    requests.push(request.url ?? '');
    response.setHeader('Content-Type', 'application/json');
    if (request.url?.startsWith('/api/sessions/')) {
      assert.equal(request.headers['x-api-key'], 'openwa-fixture-key');
      response.end(
        JSON.stringify({
          messages: [
            {
              id: 'internal-message',
              waMessageId: 'wa-message',
              body: 'Restore the export column',
              type: 'text',
              direction: 'incoming',
              timestamp: 1,
            },
          ],
        }),
      );
    } else {
      assert.equal(request.headers.authorization, 'Bearer provider-fixture-key');
      let raw = '';
      for await (const chunk of request) raw += String(chunk);
      const body = z
        .object({ model: z.string(), messages: z.array(z.object({ content: z.unknown() })) })
        .parse(JSON.parse(raw));
      assert.equal(body.model, 'fixture-model');
      const review = String(body.messages[1]?.content).startsWith('Evaluate each named question');
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  review
                    ? {
                        answers: [
                          { name: 'candidate_0', type: 'choice', choice: 'keep', confidence: 0.99 },
                        ],
                      }
                    : { changes: [change] },
                ),
              },
            },
          ],
          usage: { total_tokens: 12 },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const settings = SettingsSchema.parse({
    ...store.settings(),
    openwaUrl: `http://127.0.0.1:${address.port}`,
    quietSeconds: 0,
    profiles: [
      {
        id: 'api',
        name: 'Fixture API',
        kind: 'compatible',
        model: 'fixture-model',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      },
    ],
    activeProfileId: 'api',
    trigger: { mode: 'automatic', decisionProfileId: null },
    chats: [
      { id: 'a', name: 'Active', sessionId: 'session', chatId: 'active', enabled: true },
      { id: 'b', name: 'Paused', sessionId: 'session', chatId: 'paused', enabled: false },
    ],
  });
  store.saveSettings({
    settings,
    secrets: { openwa: 'openwa-fixture-key', 'api:key': 'provider-fixture-key' },
    removeSecrets: [],
  });
  const sync = new Sync(store, new OpenWA(store));
  sync.stop();

  try {
    await sync.run();
    assert.equal(store.snapshot().status.error, null);
    assert.equal(store.snapshot().tasks.length, 1);
    assert.equal(store.snapshot().usage.calls, 3);
    assert.ok(requests.some((path) => path.includes('chatId=active')));
    assert.ok(!requests.some((path) => path.includes('paused')));
    const count = requests.length;
    store.saveSettings({
      settings: { ...settings, chats: settings.chats.map((c) => ({ ...c, enabled: false })) },
      secrets: {},
      removeSecrets: [],
    });
    await sync.run();
    assert.equal(requests.length, count);
    assert.equal(store.snapshot().tasks.length, 1);
  } finally {
    sync.stop();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the image route uses the WhatsApp ID and caches bytes across restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat2tasks-media-')),
    store = new Store(dir);
  let calls = 0;
  const upstream = createServer((request, response) => {
    calls++;
    assert.ok(request.url?.endsWith('/whatsapp-id/media'));
    response.setHeader('Content-Type', 'image/jpeg');
    response.end(Buffer.from([255, 216, 255, 217]));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  store.saveSettings({
    settings: { ...store.settings(), openwaUrl: `http://127.0.0.1:${address.port}` },
    secrets: { openwa: 'fixture-key' },
    removeSecrets: [],
  });
  const message = MessageSchema.parse({
    id: 'internal-id',
    sessionId: 's',
    chatId: 'c',
    waMessageId: 'whatsapp-id',
    body: 'Screenshot',
    type: 'image',
    direction: 'incoming',
    timestamp: 1,
    mediaMimetype: 'image/jpeg',
  });
  try {
    const first = await new OpenWA(store).media(message),
      second = await new OpenWA(store).media(message);
    assert.equal(calls, 1);
    assert.deepEqual(first?.bytes, second?.bytes);
    assert.equal(second?.mime, 'image/jpeg');
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saved audio and video attachments can be cached for search', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat2tasks-search-media-')),
    store = new Store(dir);
  let calls = 0;
  const upstream = createServer((request, response) => {
    calls++;
    if (request.url?.includes('?')) {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          messages: [
            {
              id: 'inline-audio',
              type: 'audio',
              direction: 'incoming',
              timestamp: 1,
              metadata: {
                media: {
                  mimetype: 'audio/ogg',
                  data: Buffer.from('inline sample').toString('base64'),
                },
              },
            },
          ],
        }),
      );
      return;
    }
    const audio = request.url?.endsWith('/audio-id/media');
    response.setHeader('Content-Type', audio ? 'audio/ogg' : 'video/mp4');
    response.end(audio ? 'audio sample' : 'video sample');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  store.saveSettings({
    settings: { ...store.settings(), openwaUrl: `http://127.0.0.1:${address.port}` },
    secrets: { openwa: 'fixture-key' },
    removeSecrets: [],
  });
  try {
    for (const [type, id, mime] of [
      ['ptt', 'audio-id', 'audio/ogg'],
      ['video', 'video-id', 'video/mp4'],
    ]) {
      const message = MessageSchema.parse({
        id,
        sessionId: 's',
        chatId: 'c',
        waMessageId: id,
        type,
        body: '',
        direction: 'incoming',
        timestamp: 1,
        mediaMimetype: mime,
      });
      const first = await new OpenWA(store).attachment(message);
      const second = await new OpenWA(store).attachment(message);
      assert.equal(first?.mime, mime);
      assert.deepEqual(first?.bytes, second?.bytes);
    }
    assert.equal(calls, 2);
    const chat = { id: 'chat', name: 'Sample', sessionId: 's', chatId: 'c', enabled: true };
    const [inline] = await new OpenWA(store).messages(chat);
    assert.ok(inline);
    assert.equal((await new OpenWA(store).attachment(inline))?.bytes.toString(), 'inline sample');
    assert.equal(calls, 3);
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pausing during inference discards its result and prevents the next AI call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat2tasks-pause-')),
    store = new Store(dir);
  let calls = 0;
  const upstream = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url?.startsWith('/api/sessions/'))
      response.end(
        JSON.stringify({
          messages: [
            {
              id: 'raw',
              waMessageId: 'wa',
              body: 'Fix the export',
              type: 'text',
              direction: 'incoming',
              timestamp: 1,
            },
          ],
        }),
      );
    else {
      calls++;
      store.saveSettings({
        settings: {
          ...store.settings(),
          chats: store.settings().chats.map((c) => ({ ...c, enabled: false })),
        },
        secrets: {},
        removeSecrets: [],
      });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  changes: [
                    {
                      id: null,
                      title: 'Fix the export',
                      scope: 'Exports',
                      note: 'Missing column',
                      source_ids: [hash(['s', 'c', 'wa'])],
                      action_steps: ['Restore the column'],
                      done_when: ['Column restored'],
                      priority: 'normal',
                      triage_state: 'ready',
                      blocking_question: null,
                    },
                  ],
                }),
              },
            },
          ],
        }),
      );
    }
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  store.saveSettings({
    settings: {
      ...store.settings(),
      openwaUrl: `http://127.0.0.1:${address.port}`,
      quietSeconds: 0,
      chats: [{ id: 'c', name: 'Chat', sessionId: 's', chatId: 'c', enabled: true }],
      profiles: [
        {
          id: 'p',
          name: 'API',
          kind: 'compatible',
          model: 'fixture',
          baseUrl: `http://127.0.0.1:${address.port}`,
        },
      ],
      activeProfileId: 'p',
      trigger: { mode: 'automatic', decisionProfileId: null },
    },
    secrets: { openwa: 'fixture' },
    removeSecrets: [],
  });
  const sync = new Sync(store, new OpenWA(store));
  sync.stop();

  try {
    await sync.run();
    assert.equal(calls, 1);
    assert.equal(store.snapshot().tasks.length, 0);
    assert.equal(store.pending(store.messages()).length, 1);
  } finally {
    sync.stop();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Cloudflare proxy and current REST API keep provider and gateway tokens in their documented headers', () => {
  const base = {
    id: 'cf',
    name: 'Gateway',
    kind: 'cloudflare',
    accountId: 'a'.repeat(32),
    gatewayId: 'team',
    model: 'gpt-4.1-mini',
  } satisfies Omit<
    Extract<ReturnType<Store['settings']>['profiles'][number], { kind: 'cloudflare' }>,
    'route'
  >;
  const secret = (id: string) => (id.endsWith(':key') ? 'provider-key' : 'gateway-key');
  const proxy = connectionRequest({ ...base, route: 'proxy' }, secret);
  assert.equal(
    proxy.url,
    `https://gateway.ai.cloudflare.com/v1/${base.accountId}/team/openai/chat/completions`,
  );
  assert.equal(proxy.headers.Authorization, 'Bearer provider-key');
  assert.equal(proxy.headers['cf-aig-authorization'], 'Bearer gateway-key');
  const unified = connectionRequest(
    { ...base, model: 'openai/gpt-4.1-mini', route: 'unified' },
    secret,
  );
  assert.equal(
    unified.url,
    `https://api.cloudflare.com/client/v4/accounts/${base.accountId}/ai/v1/chat/completions`,
  );
  assert.equal(unified.headers.Authorization, 'Bearer gateway-key');
  assert.equal(unified.headers['cf-aig-gateway-id'], 'team');
  assert.equal(unified.headers['cf-aig-collect-log'], 'false');
});

test('legacy migration preserves ticks, notes, sources, and incremental cursors without requeueing old work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat2tasks-legacy-')),
    config = join(dir, 'config.json');
  const initial = new Store(dir);
  const message = MessageSchema.parse({
    id: 'm',
    sessionId: 'session',
    chatId: 'chat',
    waMessageId: 'wa',
    body: 'Source',
    type: 'text',
    direction: 'incoming',
    timestamp: 1,
  });
  initial.cache([message]);
  initial.db
    .prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?)')
    .run('old', 'Preserve task', 'Project', 'Evidence', 1, 1);
  initial.db.prepare('INSERT INTO sources VALUES(?,?)').run('old', 'm');
  initial.tick('old', true);
  initial.remark('old', 'My original note');
  initial.db.prepare('INSERT INTO processed VALUES(?,?)').run('m', 'old-python-hash');
  initial.setMeta('source_cursor', 'source-id');
  initial.close();
  const database = new DatabaseSync(join(dir, 'tasks.sqlite'));
  database.exec(
    "DELETE FROM app_settings;DELETE FROM meta WHERE key IN ('typescript_migrated','source_fingerprint_version')",
  );
  database.close();
  writeFileSync(
    config,
    JSON.stringify({
      session_id: 'session',
      chat_id: 'chat',
      model: 'legacy-model',
      openwa_api_url: 'http://openwa:2785',
    }),
  );
  const migrated = new Store(dir, config);
  try {
    assert.equal(migrated.snapshot().tasks[0]?.done, true);
    assert.equal(migrated.snapshot().tasks[0]?.own_remark, 'My original note');
    assert.deepEqual(migrated.snapshot().tasks[0]?.source_ids, ['m']);
    assert.equal(migrated.settings().profiles[0]?.model, 'legacy-model');
    assert.equal(migrated.metaValue('cursor:' + hash(['session', 'chat'])), 'source-id');
    assert.equal(migrated.pending([message]).length, 0);
  } finally {
    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
