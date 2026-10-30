import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, now } from '../src/server/store.js';
import { OpenWA } from '../src/server/openwa.js';
import { Sync } from '../src/server/sync.js';
import { Webhooks } from '../src/server/webhooks.js';
import { MessageSchema } from '../src/shared/schema.js';
import { Threads } from '../src/server/threads.js';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chat2tasks-webhook-')),
    store = new Store(dir);
  store.saveSettings({
    settings: {
      ...store.settings(),
      chats: [
        { id: 'active', name: 'Active', sessionId: 's', chatId: 'chat', enabled: true },
        { id: 'paused', name: 'Paused', sessionId: 's', chatId: 'paused', enabled: false },
      ],
    },
    secrets: {},
    removeSecrets: [],
  });
  const openwa = new OpenWA(store),
    sync = new Sync(store, openwa);
  sync.stop();
  const hooks = new Webhooks(store, openwa, sync);
  const event = {
    event: 'message.received',
    sessionId: 's',
    idempotencyKey: 'delivery-key',
    data: { id: 'wa', chatId: 'chat', body: 'Fix the export' },
  };
  const raw = Buffer.from(JSON.stringify(event));
  const sign = (body: Buffer) =>
    'sha256=' + createHmac('sha256', store.webhookSecret()).update(body).digest('hex');
  return {
    dir,
    store,
    sync,
    hooks,
    event,
    raw,
    sign,
    close() {
      sync.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('only the exact signed body can enqueue work, and webhook retries do not reset the quiet period', () => {
  const f = fixture();
  try {
    assert.throws(() => f.hooks.receive(f.raw, 'sha256=invalid'));
    assert.equal(f.store.jobs().length, 0);
    f.hooks.receive(f.raw, f.sign(f.raw));
    const first = f.store.jobs()[0];
    assert.ok(first);
    const duplicate = f.hooks.receive(f.raw, f.sign(f.raw));
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(f.store.jobs()[0], first);
    assert.throws(() =>
      f.hooks.receive(Buffer.from(f.raw.toString().replace('Fix', 'Change')), f.sign(f.raw)),
    );
    const paused = Buffer.from(
      JSON.stringify({ ...f.event, idempotencyKey: 'paused-delivery', data: { chatId: 'paused' } }),
    );
    assert.equal(f.hooks.receive(paused, f.sign(paused)).ignored, true);
    assert.equal(f.store.jobs().length, 1);
  } finally {
    f.close();
  }
});
test('an edited older message keeps its stable source identity and durable work survives a restart', () => {
  const f = fixture();
  try {
    const m = MessageSchema.parse({
      id: 'stable-id',
      sessionId: 's',
      chatId: 'chat',
      waMessageId: 'wa',
      body: 'Old body',
      type: 'text',
      direction: 'incoming',
      timestamp: 1,
    });
    f.store.cache([m]);
    f.store.apply([], [m]);
    const threads = new Threads(f.store),
      source = threads.snapshot().messages[0];
    assert.ok(source);
    const correction = threads.move({
      messageId: source.id,
      expectedRevision: source.groupingRevision,
      target: { kind: 'new', title: 'Chosen discussion' },
    });
    const raw = Buffer.from(
      JSON.stringify({
        ...f.event,
        event: 'message.edited',
        data: { messageId: 'wa', chatId: 'chat', body: 'Corrected body' },
      }),
    );
    f.hooks.receive(raw, f.sign(raw));
    assert.equal(f.store.messages()[0]?.id, 'stable-id');
    assert.equal(f.store.messages()[0]?.body, 'Corrected body');
    assert.equal(threads.snapshot().messages[0]?.threadId, correction.threadId);
    assert.equal(f.store.pending(f.store.messages()).length, 1);
    const reopened = new Store(f.dir);
    try {
      assert.equal(reopened.jobs()[0]?.chat_id, 'active');
      assert.equal(reopened.webhookSecret(), f.store.webhookSecret());
      assert.equal(new Threads(reopened).snapshot().messages[0]?.threadId, correction.threadId);
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});
test('a continuous event burst cannot postpone processing beyond three minutes', () => {
  const f = fixture();
  try {
    f.hooks.receive(f.raw, f.sign(f.raw));
    f.store.db.prepare('UPDATE chat_jobs SET first=?').run(now() - 179);
    const raw = Buffer.from(JSON.stringify({ ...f.event, idempotencyKey: 'next-message' }));
    f.hooks.receive(raw, f.sign(raw));
    const job = f.store.jobs()[0];
    assert.ok(job);
    assert.ok(job.due <= job.first + 180);
    assert.ok(job.due < now() + 2);
  } finally {
    f.close();
  }
});
test('manual mode still receives and saves messages immediately without scheduling Luna', () => {
  const f = fixture();
  try {
    f.store.saveSettings({
      settings: { ...f.store.settings(), trigger: { mode: 'manual' } },
      secrets: {},
      removeSecrets: [],
    });
    f.hooks.receive(f.raw, f.sign(f.raw));
    assert.equal(f.store.messages()[0]?.body, 'Fix the export');
    assert.equal(f.store.jobs().length, 0);
    assert.equal(f.store.snapshot().usage.calls, 0);
    assert.equal(f.store.pending(f.store.messages()).length, 1);
  } finally {
    f.close();
  }
});

test('a saved webhook batch reaches the decision API first; skip avoids Luna and Run now bypasses the judge', async () => {
  const f = fixture();
  const calls: string[] = [];
  const upstream = createServer((request, response) => {
    if (request.url?.startsWith('/api/sessions/')) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ messages: [] }));
      return;
    }
    calls.push(request.url ?? '');
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify(
        request.url === '/v1/systemone'
          ? {
              answers: { trigger: { type: 'choice', choice: 'skip', confidence: 0.99 } },
              usage: { input_tokens: 10, output_tokens: 2 },
            }
          : {
              choices: [{ message: { content: JSON.stringify({ changes: [] }) } }],
              usage: { total_tokens: 10 },
            },
      ),
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const address = upstream.address();
    assert.ok(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    f.store.saveSettings({
      settings: {
        ...f.store.settings(),
        openwaUrl: `http://127.0.0.1:${address.port}`,
        profiles: [
          {
            id: 'judge',
            name: 'Jev',
            kind: 'decision',
            provider: 'jev',
            model: 'jev-latest',
            baseUrl,
          },
          { id: 'tasks', name: 'Task model', kind: 'compatible', model: 'fixture', baseUrl },
        ],
        activeProfileId: 'tasks',
        trigger: { mode: 'automatic', decisionProfileId: 'judge' },
      },
      secrets: { 'judge:key': 'fixture-key', openwa: 'fixture-openwa-key' },
      removeSecrets: [],
    });
    f.hooks.receive(f.raw, f.sign(f.raw));
    assert.equal(f.store.messages().length, 1);
    assert.deepEqual(calls, []);
    f.store.queueChat('active', 0, true);
    await f.sync.run(['active']);
    assert.equal(f.store.snapshot().status.error, null);
    assert.equal(f.store.jobs()[0]?.reconcile, 0);
    assert.deepEqual(calls, []);
    await f.sync.run(['active']);
    assert.deepEqual(calls, ['/v1/systemone']);
    assert.equal(f.store.pending(f.store.messages()).length, 0);
    assert.equal(f.store.jobs().length, 0);
    assert.equal(f.store.snapshot().status.last_decision?.choice, 'skip');
    const raw = Buffer.from(
      JSON.stringify({
        ...f.event,
        idempotencyKey: 'new-message',
        data: { ...f.event.data, id: 'new-wa' },
      }),
    );
    f.hooks.receive(raw, f.sign(raw));
    f.sync.wake();
    await f.sync.run(['active']);
    assert.equal(f.store.snapshot().status.error, null);
    assert.deepEqual(calls, ['/v1/systemone', '/v1/chat/completions']);
    assert.equal(f.store.pending(f.store.messages()).length, 0);
    assert.equal(f.store.snapshot().status.pending, 0);
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    f.close();
  }
});

test('processing stays visible while a decision is in progress', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let running: Promise<void> | undefined;
  try {
    f.store.saveSettings({
      settings: {
        ...f.store.settings(),
        profiles: [
          {
            id: 'judge',
            name: 'Decision',
            kind: 'decision',
            provider: 'jev',
            model: 'fixture',
            baseUrl: 'https://example.invalid/v1',
          },
          {
            id: 'tasks',
            name: 'Tasks',
            kind: 'compatible',
            model: 'fixture',
            baseUrl: 'https://example.invalid/v1',
          },
        ],
        activeProfileId: 'tasks',
        trigger: { mode: 'automatic', decisionProfileId: 'judge' },
      },
      secrets: { 'judge:key': 'fixture' },
      removeSecrets: [],
    });
    globalThis.fetch = async () => {
      entered();
      await waiting;
      return new Response(
        JSON.stringify({
          answers: { trigger: { type: 'choice', choice: 'skip', confidence: 0.99 } },
        }),
      );
    };
    f.hooks.receive(f.raw, f.sign(f.raw));
    running = f.sync.run(['active']);
    await started;
    assert.equal(f.store.status().syncing, true);
  } finally {
    release();
    await running;
    globalThis.fetch = original;
    f.close();
  }
});
