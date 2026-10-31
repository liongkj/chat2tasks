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
import { Server as SocketServer } from 'socket.io';
import { RemoteEvents } from '../src/server/remote-events.js';
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

test('a remote server delivers messages and reconnects without enabling automatic processing', async () => {
  const f = fixture();
  const upstream = createServer();
  const io = new SocketServer(upstream);
  const events = io.of('/events');
  let subscribed = 0;
  events.use((socket, next) =>
    next(socket.handshake.auth.apiKey === 'sample-key' ? undefined : new Error('unauthorized')),
  );
  events.on('connection', (socket) =>
    socket.on('message', (value: { type: string; sessionId: string }) => {
      if (value.type !== 'subscribe') return;
      subscribed++;
      socket.emit('message', { type: 'subscribed', sessionId: value.sessionId });
    }),
  );
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  f.store.saveSettings({
    settings: {
      ...f.store.settings(),
      openwaUrl: `http://127.0.0.1:${address.port}`,
      trigger: { mode: 'manual' },
    },
    secrets: { openwa: 'sample-key' },
    removeSecrets: [],
  });
  const remote = new RemoteEvents(f.store, f.hooks, f.sync);
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!condition() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(condition());
  };
  try {
    remote.start();
    await waitFor(() => subscribed === 1 && f.store.jobs().length === 1);
    f.store.db.exec('DELETE FROM chat_jobs');
    events.emit('message', {
      type: 'event',
      payload: {
        event: 'message.received',
        sessionId: 's',
        data: { id: 'fake-message', chatId: 'chat', body: 'Sample request' },
      },
    });
    await waitFor(() => f.store.messages().some((message) => message.body === 'Sample request'));
    assert.equal(f.store.jobs().length, 0);
    assert.equal(f.store.snapshot().usage.calls, 0);
    for (const socket of events.sockets.values()) socket.conn.close();
    await waitFor(() => subscribed >= 2 && f.store.jobs().length === 1);
  } finally {
    remote.stop();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    f.close();
  }
});
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
test('new messages preserve active progress and count waiting messages across enabled chats once', () => {
  const f = fixture();
  try {
    f.store.saveSettings({
      settings: {
        ...f.store.settings(),
        chats: [
          ...f.store.settings().chats,
          { id: 'second', name: 'Second', sessionId: 's', chatId: 'second', enabled: true },
        ],
      },
      secrets: {},
      removeSecrets: [],
    });
    f.store.cache([
      MessageSchema.parse({
        id: 'outgoing',
        sessionId: 's',
        chatId: 'second',
        body: 'An outgoing message',
        type: 'text',
        direction: 'outgoing',
        timestamp: now() + 1,
      }),
      MessageSchema.parse({
        id: 'paused-message',
        sessionId: 's',
        chatId: 'paused',
        body: 'A paused conversation',
        type: 'text',
        direction: 'incoming',
        timestamp: now(),
      }),
    ]);
    f.store.status({ syncing: true, phase: 'Reading evidence from Active', debouncing: false });
    f.hooks.receive(f.raw, f.sign(f.raw));
    const status = f.store.status();
    assert.equal(status.phase, 'Reading evidence from Active');
    assert.equal(status.debouncing, false);
    assert.equal(status.pending, 2);
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
    let drained = false;
    const draining = f.sync.stopAndWait().then(() => {
      drained = true;
    });
    assert.equal(drained, false, 'handover waits for analysis already in progress');
    release();
    await draining;
    assert.equal(f.sync.running, false);
  } finally {
    release();
    await running;
    globalThis.fetch = original;
    f.close();
  }
});

test('image analysis shows its current image and completes the saved batch', async () => {
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
  let calls = 0;
  try {
    f.store.saveSettings({
      settings: {
        ...f.store.settings(),
        profiles: [
          {
            id: 'tasks',
            name: 'Tasks',
            kind: 'compatible',
            model: 'fixture',
            baseUrl: 'https://example.invalid/v1',
          },
        ],
        activeProfileId: 'tasks',
        trigger: { mode: 'manual' },
      },
      secrets: {},
      removeSecrets: [],
    });
    f.store.cache([
      MessageSchema.parse({
        id: 'image-1',
        sessionId: 's',
        chatId: 'chat',
        body: '',
        type: 'image',
        direction: 'incoming',
        timestamp: now(),
        image_digest: 'fixture-digest',
        mediaMimetype: 'image/jpeg',
      }),
    ]);
    await new OpenWA(f.store).saveMedia('image-1', Buffer.from('fixture image'));
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) {
        entered();
        await waiting;
      }
      const result =
        calls === 1
          ? { readings: [{ message_id: 'image-1', observations: [], uncertainties: [] }] }
          : { changes: [], waits: [] };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }),
      );
    };
    f.store.queueChat('active', 0, false, true);
    running = f.sync.run(['active']);
    await Promise.race([
      started,
      running.then(() => {
        throw new Error('Image analysis ended before the model request: ' + f.store.status().error);
      }),
    ]);
    assert.equal(f.store.status().phase, 'Reading image 1 of 1 from Active');
    release();
    await running;
    assert.equal(f.store.status().error, null);
    assert.equal(
      f.store.db.prepare('SELECT count(*) AS count FROM image_readings').get()?.count,
      1,
    );
    assert.equal(f.store.status().pending, 0);
  } finally {
    release();
    await running;
    globalThis.fetch = original;
    f.close();
  }
});

test('partial reply matching saves only uniquely matched replies and retries the rest', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  try {
    f.store.saveSettings({
      settings: {
        ...f.store.settings(),
        profiles: [
          {
            id: 'tasks',
            name: 'Tasks',
            kind: 'compatible',
            model: 'fixture',
            baseUrl: 'https://example.invalid/v1',
          },
        ],
        activeProfileId: 'tasks',
        trigger: { mode: 'automatic', decisionProfileId: null },
      },
      secrets: {},
      removeSecrets: [],
    });
    const messages = [
      { id: 'request', direction: 'incoming' as const, body: 'Fix the export' },
      { id: 'reply-1', direction: 'outgoing' as const, body: 'Checking it' },
      { id: 'reply-2', direction: 'outgoing' as const, body: 'Another update' },
      { id: 'reply-3', direction: 'outgoing' as const, body: 'Still working' },
    ].map((message) =>
      MessageSchema.parse({
        ...message,
        sessionId: 's',
        chatId: 'chat',
        type: 'text',
        timestamp: now() + 1,
      }),
    );
    f.store.cache(messages);
    f.store.apply(
      [
        {
          id: null,
          title: 'Fix the export',
          scope: 'Exports',
          note: 'Requested in the conversation',
          source_ids: ['request'],
          kind: 'task',
          action_steps: ['Fix the export'],
          done_when: ['The export works'],
          priority: 'normal',
          triage_state: 'ready',
          blocking_question: null,
        },
      ],
      messages,
    );
    const decision = (messageId: string) => ({
      message_id: messageId,
      action: 'none',
      task_ids: [],
      evidence_quote: '',
      reason: 'No completion reported',
      question: null,
    });
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  decisions: [
                    decision('reply-1'),
                    decision('reply-3'),
                    decision('reply-3'),
                    decision('unknown'),
                  ],
                }),
              },
            },
          ],
        }),
      );
    f.store.queueChat('active', 0, false);
    await f.sync.run(['active']);
    assert.equal(f.store.status().error, null);
    assert.deepEqual(
      f.store
        .pendingReplies(f.store.messages())
        .map((message) => message.id)
        .sort(),
      ['reply-2', 'reply-3'],
    );
    assert.equal(f.store.snapshot().tasks[0]?.done, false);
    assert.equal(f.store.jobs().length, 1);
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});
