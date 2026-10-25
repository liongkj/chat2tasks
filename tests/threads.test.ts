import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store } from '../src/server/store.js';
import { Threads } from '../src/server/threads.js';
import { Threading } from '../src/server/threading.js';
import { MessageSchema, TaskChangeSchema } from '../src/shared/schema.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chat2tasks-threads-'));
  const store = new Store(dir);
  store.saveSettings({
    settings: {
      ...store.settings(),
      chats: [
        { id: 'ops', name: 'Operations', sessionId: 'one', chatId: 'a@lid', enabled: true },
        { id: 'support', name: 'Support', sessionId: 'two', chatId: 'b@lid', enabled: true },
      ],
    },
    secrets: {},
    removeSecrets: [],
  });
  const messages = [
    MessageSchema.parse({
      id: 'a',
      sessionId: 'one',
      chatId: 'a@lid',
      waMessageId: 'false_a@lid_ABC123',
      body: 'PBI capacity values are null',
      timestamp: 1,
      direction: 'incoming',
    }),
    MessageSchema.parse({
      id: 'b',
      sessionId: 'two',
      chatId: 'b@lid',
      waMessageId: 'true_b@lid_DEF456',
      body: 'I can check those inverter settings',
      timestamp: 2,
      direction: 'outgoing',
    }),
    MessageSchema.parse({
      id: 'c',
      sessionId: 'one',
      chatId: 'a@lid',
      waMessageId: 'false_a@lid_GHI789',
      body: 'Weekly model did not trigger',
      timestamp: 3,
      direction: 'incoming',
    }),
  ];
  store.cache(messages);
  const threads = new Threads(store);
  return {
    dir,
    store,
    threads,
    messages,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a discussion spans source chats without a task and keeps unrelated messages reachable', () => {
  const f = fixture();
  try {
    f.threads.apply(
      {
        threads: [{ id: null, title: 'PBI capacity', messageIds: ['a', 'b'] }],
        otherMessageIds: ['c'],
      },
      f.messages,
    );
    const snapshot = f.threads.snapshot();
    assert.equal(snapshot.threads.length, 1);
    assert.deepEqual(snapshot.threads[0]?.taskIds, []);
    assert.deepEqual(
      snapshot.messages.map((m) => [m.body, m.conversationId]),
      [
        ['PBI capacity values are null', 'ops'],
        ['I can check those inverter settings', 'support'],
        ['Weekly model did not trigger', 'ops'],
      ],
    );
    assert.equal(snapshot.messages.find((m) => m.id === 'c')?.threadId, null);
    assert.equal(f.threads.pending().length, 0);
    assert.equal(f.store.snapshot().tasks.length, 0);
  } finally {
    f.close();
  }
});

test('organisation rejects omitted, duplicate, unknown and invented-thread assignments atomically', () => {
  const f = fixture();
  try {
    for (const plan of [
      { threads: [{ id: null, title: 'PBI', messageIds: ['a', 'b'] }], otherMessageIds: [] },
      { threads: [{ id: null, title: 'PBI', messageIds: ['a', 'a'] }], otherMessageIds: ['c'] },
      {
        threads: [{ id: null, title: 'PBI', messageIds: ['a', 'b'] }],
        otherMessageIds: ['invented'],
      },
      {
        threads: [
          { id: '7546afaa-724d-4b71-8804-27e85b588ef1', title: 'PBI', messageIds: ['a', 'b'] },
        ],
        otherMessageIds: ['c'],
      },
    ])
      assert.throws(() => f.threads.apply(plan, f.messages));
    assert.equal(f.threads.snapshot().threads.length, 0);
    assert.equal(f.threads.pending().length, 3);
  } finally {
    f.close();
  }
});

test('a saved correction survives automatic regrouping, source edits and restart', () => {
  const f = fixture();
  try {
    f.threads.apply(
      {
        threads: [{ id: null, title: 'PBI capacity', messageIds: ['a', 'b'] }],
        otherMessageIds: ['c'],
      },
      f.messages,
    );
    const source = f.threads.snapshot().messages.find((m) => m.id === 'a');
    assert.ok(source);
    const oldTopic = source.threadId;
    assert.ok(oldTopic);
    const target = f.threads.move({
      messageId: source.id,
      expectedRevision: source.groupingRevision,
      target: { kind: 'new', title: 'Separate capacity case' },
    });
    f.threads.apply(
      {
        threads: [{ id: oldTopic, title: 'PBI capacity', messageIds: ['a', 'b'] }],
        otherMessageIds: ['c'],
      },
      f.messages,
    );
    const original = f.messages[0];
    assert.ok(original);
    f.store.cache([{ ...original, body: 'The source was edited' }]);
    assert.equal(
      f.threads.snapshot().messages.find((m) => m.id === 'a')?.threadId,
      target.threadId,
    );
    assert.ok(!f.threads.pending().some((m) => m.id === 'a'));
    f.store.close();
    const reopened = new Store(f.dir);
    try {
      assert.equal(
        new Threads(reopened).snapshot().messages.find((m) => m.id === 'a')?.threadId,
        target.threadId,
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a stale move cannot overwrite another correction', () => {
  const f = fixture();
  try {
    const source = f.threads.snapshot().messages[0];
    assert.ok(source);
    f.threads.move({
      messageId: source.id,
      expectedRevision: source.groupingRevision,
      target: { kind: 'new', title: 'Chosen topic' },
    });
    assert.throws(
      () =>
        f.threads.move({
          messageId: source.id,
          expectedRevision: source.groupingRevision,
          target: { kind: 'other' },
        }),
      /changed/,
    );
    assert.equal(f.threads.snapshot().threads[0]?.title, 'Chosen topic');
  } finally {
    f.close();
  }
});

test('an edited source is not assigned using an outdated model response', () => {
  const f = fixture();
  try {
    const original = f.messages[0];
    assert.ok(original);
    const priorRevision = f.threads.snapshot().messages.find((m) => m.id === 'a')?.groupingRevision;
    assert.ok(priorRevision);
    f.store.cache([{ ...original, body: 'A different subject after editing' }]);
    assert.throws(
      () =>
        f.threads.move({
          messageId: 'a',
          expectedRevision: priorRevision,
          target: { kind: 'other' },
        }),
      /changed/,
    );
    f.threads.apply(
      {
        threads: [{ id: null, title: 'Old topic', messageIds: ['a', 'b'] }],
        otherMessageIds: ['c'],
      },
      f.messages,
    );
    assert.equal(f.threads.snapshot().messages.find((m) => m.id === 'a')?.threadId, null);
    assert.equal(f.threads.pending()[0]?.id, 'a');
  } finally {
    f.close();
  }
});

test('inline TODOs use unique WhatsApp identity rather than body similarity', () => {
  const f = fixture();
  try {
    f.store.apply(
      [
        TaskChangeSchema.parse({
          id: null,
          title: 'Check capacity',
          scope: 'PBI',
          note: 'Capacity values need checking.',
          source_ids: ['a'],
          action_steps: ['Confirm values'],
          done_when: ['Values confirmed'],
          priority: 'normal',
          triage_state: 'ready',
          blocking_question: null,
        }),
      ],
      f.messages,
    );
    assert.equal(f.threads.annotations(['ABC123']).annotations[0]?.reference, 'TODO-001');
    assert.equal(f.threads.annotations(['ABC123']).annotations[0]?.conversationId, 'ops');
    f.store.cache([
      MessageSchema.parse({
        id: 'duplicate',
        sessionId: 'two',
        chatId: 'b@lid',
        waMessageId: 'false_b@lid_ABC123',
        body: 'Different text',
        direction: 'incoming',
        timestamp: 4,
      }),
    ]);
    assert.deepEqual(f.threads.annotations(['ABC123']).annotations, []);
    assert.deepEqual(f.threads.annotations(['unrelated']).annotations, []);
  } finally {
    f.close();
  }
});
test('organisation checkpoints model responses and requires a manual retry after failure', async () => {
  const f = fixture();
  let calls = 0,
    fail = false,
    busy = false;
  const payloads: string[] = [];
  let beforeReply = () => {};
  const provider = createServer((request, response) => {
    let payload = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (payload += chunk));
    request.on('end', () => {
      payloads.push(payload);
      calls++;
      if (fail) {
        response.writeHead(503);
        response.end();
        return;
      }
      const active = new Set(
        f.store
          .settings()
          .chats.filter((c) => c.enabled)
          .map((c) => c.id),
      );
      const pending = f.threads.pending().filter((m) => active.has(m.conversationId)),
        existing = f.threads.snapshot().threads[0];
      const grouped = pending.filter((m) => m.id !== 'c').map((m) => m.id);
      beforeReply();
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  threads: grouped.length
                    ? [{ id: existing?.id ?? null, title: 'PBI capacity', messageIds: grouped }]
                    : [],
                  otherMessageIds: pending.filter((m) => m.id === 'c').map((m) => m.id),
                }),
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  assert.ok(address && typeof address !== 'string');
  f.store.saveSettings({
    settings: {
      ...f.store.settings(),
      profiles: [
        {
          id: 'fixture',
          name: 'Fixture',
          kind: 'compatible',
          baseUrl: `http://127.0.0.1:${address.port}`,
          model: 'fixture',
        },
      ],
      activeProfileId: 'fixture',
      trigger: { mode: 'automatic', decisionProfileId: null },
    },
    secrets: {},
    removeSecrets: [],
  });
  const organiser = new Threading(f.threads, true, () => busy);
  try {
    await organiser.request();
    assert.equal(f.threads.snapshot().threads[0]?.messageIds.length, 2);
    await organiser.request();
    assert.equal(calls, 1);
    const source = f.messages[0];
    assert.ok(source);
    f.store.cache([{ ...source, body: 'Updated capacity question' }]);
    busy = true;
    organiser.request();
    assert.equal(f.threads.status().kind, 'queued');
    assert.equal(calls, 1);
    busy = false;
    f.store.saveSettings({
      settings: { ...f.store.settings(), trigger: { mode: 'manual' } },
      secrets: {},
      removeSecrets: [],
    });
    await organiser.enable();
    assert.equal(calls, 1);
    fail = true;
    await organiser.request();
    assert.equal(calls, 2);
    assert.equal(f.threads.status().kind, 'error');
    await new Promise((resolve) => setTimeout(resolve, 2100));
    assert.equal(calls, 2);
    busy = true;
    await organiser.request(false);
    assert.equal(f.threads.status().kind, 'error');
    busy = false;
    await organiser.request(false);
    assert.equal(calls, 2);
    fail = false;
    await organiser.request();
    assert.equal(calls, 3);
    assert.equal(f.threads.status().kind, 'idle');
    assert.equal(f.threads.pending().length, 0);
    const support = f.messages[1];
    assert.ok(support);
    f.store.cache([
      { ...source, body: 'A new capacity question' },
      { ...support, body: 'Private paused evidence' },
    ]);
    f.store.saveSettings({
      settings: {
        ...f.store.settings(),
        chats: f.store.settings().chats.map((c) => ({ ...c, enabled: c.id !== 'support' })),
      },
      secrets: {},
      removeSecrets: [],
    });
    beforeReply = () =>
      f.store.saveSettings({
        settings: {
          ...f.store.settings(),
          chats: f.store.settings().chats.map((c) => ({ ...c, enabled: false })),
        },
        secrets: {},
        removeSecrets: [],
      });
    await organiser.request();
    assert.equal(calls, 4);
    assert.ok(!payloads.at(-1)?.includes('Private paused evidence'));
    assert.ok(f.threads.pending().some((m) => m.id === source.id));
    await organiser.request(false);
    assert.equal(calls, 4);
  } finally {
    await organiser.stop();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    f.close();
  }
});
