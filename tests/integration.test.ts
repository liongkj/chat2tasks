import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { Store, hash } from '../src/server/store.js';
import { OpenWA } from '../src/server/openwa.js';
import { Sync } from '../src/server/sync.js';
import { connectionRequest } from '../src/server/ai.js';
import { SettingsSchema, MessageSchema } from '../src/shared/schema.js';

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
      const body = z.object({ model: z.string() }).parse(JSON.parse(raw));
      assert.equal(body.model, 'fixture-model');
      response.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ changes: [change] }) } }],
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
  sync.force = true;
  try {
    await sync.run();
    assert.equal(store.snapshot().status.error, null);
    assert.equal(store.snapshot().tasks.length, 1);
    assert.equal(store.snapshot().usage.calls, 2);
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
    },
    secrets: { openwa: 'fixture' },
    removeSecrets: [],
  });
  const sync = new Sync(store, new OpenWA(store));
  sync.stop();
  sync.force = true;
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
  database.exec("DELETE FROM app_settings;DELETE FROM meta WHERE key='typescript_migrated'");
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
