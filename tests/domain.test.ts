import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, hash } from '../src/server/store.js';
import { MessageSchema, TaskChangeSchema } from '../src/shared/schema.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chat2tasks-test-'));
  const store = new Store(dir);
  const message = MessageSchema.parse({
    id: 'm1',
    sessionId: 's',
    chatId: 'c',
    waMessageId: 'w1',
    body: 'Fix the export',
    direction: 'incoming',
    type: 'text',
    timestamp: 1,
  });
  store.cache([message]);
  const change = TaskChangeSchema.parse({
    id: null,
    title: 'Fix the export',
    scope: 'Exports',
    note: 'Missing a column',
    source_ids: ['m1'],
    action_steps: ['Restore the column'],
    done_when: ['Export contains the column'],
    priority: 'normal',
    triage_state: 'ready',
    blocking_question: null,
  });
  return {
    dir,
    store,
    message,
    change,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('replayed task generation is idempotent and cannot overwrite a manual tick', () => {
  const f = fixture();
  try {
    f.store.apply([f.change], [f.message]);
    const task = f.store.snapshot().tasks[0];
    assert.ok(task);
    f.store.tick(task.id, true);
    f.store.apply([f.change], [f.message]);
    assert.equal(f.store.snapshot().tasks.length, 1);
    assert.equal(f.store.snapshot().tasks[0]?.done, true);
    f.store.remark(task.id, 'Keep my note');
    f.store.apply([{ ...f.change, id: task.id, note: 'Updated context' }], [f.message]);
    assert.equal(f.store.snapshot().tasks[0]?.own_remark, 'Keep my note');
  } finally {
    f.close();
  }
});
test('a source outside the supplied conversation rejects the entire task batch', () => {
  const f = fixture();
  try {
    assert.throws(() =>
      f.store.apply([f.change, { ...f.change, source_ids: ['missing'] }], [f.message]),
    );
    assert.equal(f.store.snapshot().tasks.length, 0);
    assert.equal(f.store.pending([f.message]).length, 1);
  } finally {
    f.close();
  }
});
test('edited messages are processed again', () => {
  const f = fixture();
  try {
    f.store.apply([], [f.message]);
    assert.equal(f.store.pending([f.message]).length, 0);
    assert.equal(f.store.pending([{ ...f.message, body: 'Fix two columns' }]).length, 1);
  } finally {
    f.close();
  }
});
test('AI screenshot readings do not requeue unchanged source images, but changed bytes do', () => {
  const f = fixture();
  try {
    const image = { ...f.message, type: 'image', image_digest: 'before' };
    const enriched = {
      ...image,
      image_reading: {
        message_id: image.id,
        observations: ['An export column is missing'],
        uncertainties: [],
      },
    };
    f.store.cache([image]);
    f.store.apply([], [enriched]);
    assert.equal(f.store.pending([image]).length, 0);
    assert.equal(f.store.pending([{ ...image, image_digest: 'after' }]).length, 1);
  } finally {
    f.close();
  }
});
test('only an explicit outgoing completion in the same chat can tick a task', () => {
  const f = fixture();
  try {
    f.store.apply([f.change], [f.message]);
    const task = f.store.snapshot().tasks[0];
    assert.ok(task);
    const reply = {
      ...f.message,
      id: 'r',
      body: 'Done, export fixed',
      timestamp: Date.now() / 1000 + 1,
    };
    f.store.cache([reply]);
    const decision = {
      message_id: 'r',
      action: 'complete',
      task_ids: [task.id],
      evidence_quote: 'Done',
      reason: 'Explicit completion',
      question: null,
    } satisfies Parameters<Store['decide']>[0][number];
    assert.throws(() => f.store.decide([decision], [reply], Date.now() / 1000));
    assert.throws(() =>
      f.store.decide(
        [decision],
        [{ ...reply, direction: 'outgoing', chatId: 'other' }],
        Date.now() / 1000,
      ),
    );
    f.store.decide([decision], [{ ...reply, direction: 'outgoing' }], Date.now() / 1000);
    assert.equal(f.store.snapshot().tasks[0]?.done, true);
    f.store.tick(task.id, false);
    f.store.decide([decision], [{ ...reply, direction: 'outgoing' }], Date.now() / 1000);
    assert.equal(f.store.snapshot().tasks[0]?.done, false);
  } finally {
    f.close();
  }
});
test('ambiguous completion asks locally and a manual change during inference wins', () => {
  const f = fixture();
  try {
    f.store.apply([f.change], [f.message]);
    const task = f.store.snapshot().tasks[0];
    assert.ok(task);
    const reply = MessageSchema.parse({
      ...f.message,
      id: 'r',
      body: 'Done',
      direction: 'outgoing',
      timestamp: Date.now() / 1000 + 10,
    });
    f.store.cache([reply]);
    const started = Date.now() / 1000 - 1;
    f.store.tick(task.id, false);
    f.store.decide(
      [
        {
          message_id: 'r',
          action: 'complete',
          task_ids: [task.id],
          evidence_quote: 'Done',
          reason: 'Completion reply',
          question: null,
        },
      ],
      [reply],
      started,
    );
    assert.equal(f.store.snapshot().tasks[0]?.done, false);
    const q = f.store.snapshot().questions[0];
    assert.ok(q);
    f.store.resolve(q.id, task.id);
    assert.equal(f.store.snapshot().tasks[0]?.done, true);
  } finally {
    f.close();
  }
});
test('API keys are encrypted at rest, never returned, and can be replaced and removed', () => {
  const f = fixture();
  try {
    const settings = f.store.settings();
    f.store.saveSettings({
      settings,
      secrets: { openwa: 'private-test-secret' },
      removeSecrets: [],
    });
    assert.equal(f.store.secret('openwa'), 'private-test-secret');
    assert.ok(!JSON.stringify(f.store.publicSettings()).includes('private-test-secret'));
    f.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.ok(
      !readFileSync(join(f.dir, 'tasks.sqlite')).includes(Buffer.from('private-test-secret')),
    );
    f.store.saveSettings({ settings, secrets: { openwa: 'replacement' }, removeSecrets: [] });
    assert.equal(f.store.secret('openwa'), 'replacement');
    f.store.saveSettings({ settings, secrets: {}, removeSecrets: ['openwa'] });
    assert.equal(f.store.secret('openwa'), '');
  } finally {
    f.close();
  }
});

test('webhook and history transport differences do not resend unchanged evidence to the model', () => {
  const f = fixture();
  try {
    f.store.apply([], [f.message]);
    const recovered = {
      ...f.message,
      openwaId: 'rest-row-id',
      reply_to_wa_id: null,
      reply_quote: null,
    };
    f.store.cache([recovered]);
    assert.equal(f.store.pending(f.store.messages()).length, 0);
    f.store.cache([{ ...recovered, body: 'A real change to the task request' }]);
    assert.equal(f.store.pending(f.store.messages()).length, 1);
  } finally {
    f.close();
  }
});
test('upgrading fingerprints preserves a pending edit while recognizing unchanged prior evidence', () => {
  const f = fixture();
  try {
    const other = { ...f.message, id: 'm2', waMessageId: 'w2' };
    f.store.cache([other]);
    for (const m of [f.message, other])
      f.store.db.prepare('INSERT OR REPLACE INTO processed VALUES(?,?)').run(m.id, hash(m));
    f.store.cache([{ ...other, body: 'An edit still waiting for analysis' }]);
    f.store.setMeta('source_fingerprint_version', 1);
    const reopened = new Store(f.dir);
    try {
      assert.deepEqual(
        reopened.pending(reopened.messages()).map((m) => m.id),
        ['m2'],
      );
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});
