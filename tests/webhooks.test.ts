import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, now } from '../src/server/store.js';
import { OpenWA } from '../src/server/openwa.js';
import { Sync } from '../src/server/sync.js';
import { Webhooks } from '../src/server/webhooks.js';
import { MessageSchema } from '../src/shared/schema.js';
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
    assert.equal(f.store.pending(f.store.messages()).length, 1);
    const reopened = new Store(f.dir);
    try {
      assert.equal(reopened.jobs()[0]?.chat_id, 'active');
      assert.equal(reopened.webhookSecret(), f.store.webhookSecret());
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
