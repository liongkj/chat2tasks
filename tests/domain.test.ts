import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, fingerprint, hash } from '../src/server/store.js';
import { GtdSchema, MessageSchema, TaskChangeSchema } from '../src/shared/schema.js';
import { isUpcoming } from '../src/shared/tasks.js';

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

test('a manual category survives model updates and completion changes', () => {
  const f = fixture();
  try {
    f.store.apply([{ ...f.change, kind: 'question' }], [f.message]);
    const task = f.store.snapshot().tasks[0];
    assert.ok(task);
    assert.equal(task.kind, 'question');
    f.store.tick(task.id, true);
    f.store.remark(task.id, 'Keep my note');
    f.store.setTaskKind(task.id, 'reminder');
    const before = f.store.taskEvidence(task.id);
    assert.equal(before.task.kind, 'reminder');
    assert.equal(before.task.done, true);
    f.store.apply([{ ...f.change, id: task.id, kind: 'task' }], [f.message]);
    const after = f.store.taskEvidence(task.id);
    assert.equal(after.task.kind, 'reminder');
    assert.equal(after.task.done, true);
    assert.equal(after.task.own_remark, 'Keep my note');
    assert.equal(f.store.autoSetTaskKind(task.id, after.revision, 'question'), false);
    assert.equal(f.store.taskEvidence(task.id).task.kind, 'reminder');
  } finally {
    f.close();
  }
});

test('an evidence-reviewed category survives later unreviewed task updates', () => {
  const f = fixture();
  try {
    f.store.apply([f.change], [f.message]);
    const initial = f.store.snapshot().tasks[0];
    assert.ok(initial);
    const evidence = f.store.taskEvidence(initial.id);
    assert.equal(f.store.autoSetTaskKind(initial.id, evidence.revision, 'question'), true);
    f.store.apply(
      [{ ...f.change, id: initial.id, kind: 'task', note: 'Updated context' }],
      [f.message],
    );
    const updated = f.store.taskEvidence(initial.id).task;
    assert.equal(updated.kind, 'question');
    assert.equal(updated.note, 'Updated context');
  } finally {
    f.close();
  }
});

test('existing categories migrate without losing completed work and can become an action', () => {
  const f = fixture();
  let reopened: Store | undefined;
  try {
    f.store.apply([f.change], [f.message]);
    const item = f.store.snapshot().tasks[0];
    assert.ok(item);
    f.store.setTaskKind(item.id, 'question');
    f.store.tick(item.id, true);
    f.store.close();
    const db = new DatabaseSync(join(f.dir, 'tasks.sqlite'));
    db.exec(`
      ALTER TABLE item_kinds RENAME TO original_kinds;
      CREATE TABLE item_kinds(task_id TEXT PRIMARY KEY REFERENCES tasks(id),kind TEXT NOT NULL CHECK(kind IN ('task','question','reminder')),manual INTEGER NOT NULL CHECK(manual IN (0,1)),suggestion TEXT CHECK(suggestion IS NULL OR suggestion IN ('task','question','reminder')));
      INSERT INTO item_kinds SELECT * FROM original_kinds;
      DROP TABLE original_kinds;
    `);
    db.close();
    reopened = new Store(f.dir);
    assert.equal(reopened.taskEvidence(item.id).task.kind, 'question');
    reopened.setTaskKind(item.id, 'action');
    const migrated = reopened.taskEvidence(item.id).task;
    assert.equal(migrated.kind, 'action');
    assert.equal(migrated.done, true);
    assert.deepEqual(migrated.source_ids, [f.message.id]);
    assert.equal(
      TaskChangeSchema.parse({ ...f.change, kind: 'action', action_steps: [], done_when: [] }).kind,
      'action',
    );
  } finally {
    reopened?.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('receiving a wait leaves its linked task open and a manual reopen stays authoritative', () => {
  const f = fixture();
  try {
    const request = MessageSchema.parse({
      ...f.message,
      id: 'request',
      body: 'Please send the file',
      direction: 'outgoing',
      timestamp: 2,
    });
    const reply = MessageSchema.parse({
      ...f.message,
      id: 'reply',
      body: 'Here is the file',
      timestamp: 3,
    });
    f.store.cache([request, reply]);
    f.store.apply([f.change], [f.message]);
    const task = f.store.snapshot().tasks[0];
    assert.ok(task);
    const wait = f.store.createWait({
      expected: 'The requested file',
      person: null,
      task_id: task.id,
      source_ids: [request.id],
    });
    assert.equal(wait.state, 'waiting');
    f.store.setWaitState(wait.id, 'received');
    assert.equal(f.store.snapshot().tasks[0]?.done, false);
    assert.equal(f.store.waitEvidence(wait.id).wait.state, 'received');
    f.store.setWaitState(wait.id, 'waiting');
    const current = f.store.waitEvidence(wait.id);
    assert.equal(
      f.store.autoReceiveWait(wait.id, current.revision, reply.id, fingerprint(reply)),
      false,
    );
    assert.equal(f.store.waitEvidence(wait.id).wait.state, 'waiting');
  } finally {
    f.close();
  }
});

test('replaying an owner request does not recreate a dismissed wait', () => {
  const f = fixture();
  try {
    const request = MessageSchema.parse({
      ...f.message,
      id: 'request',
      body: 'Please send the file',
      direction: 'outgoing',
    });
    f.store.cache([request]);
    const candidate = {
      id: null,
      expected: 'The requested file',
      person: null,
      task_id: null,
      source_ids: [request.id],
      needs_review: false,
    };
    f.store.apply([], [request], [], [candidate]);
    const wait = f.store.snapshot().waiting_for[0];
    assert.ok(wait);
    f.store.setWaitState(wait.id, 'dismissed');
    f.store.apply([], [request], [], [candidate]);
    assert.equal(f.store.snapshot().waiting_for.length, 1);
    assert.equal(f.store.waitEvidence(wait.id).wait.state, 'dismissed');
  } finally {
    f.close();
  }
});

test('later analysis cannot silently attach a different conversation to an existing wait', () => {
  const f = fixture();
  try {
    const request = MessageSchema.parse({ ...f.message, id: 'request', direction: 'outgoing' });
    const unrelated = MessageSchema.parse({
      ...request,
      id: 'other-request',
      chatId: 'another-chat',
    });
    f.store.cache([request, unrelated]);
    const wait = f.store.createWait({
      expected: 'The requested file',
      person: null,
      task_id: null,
      source_ids: [request.id],
    });
    f.store.apply(
      [],
      [unrelated],
      [],
      [
        {
          id: wait.id,
          expected: 'Different request',
          person: null,
          task_id: null,
          source_ids: [unrelated.id],
          needs_review: false,
        },
      ],
    );
    assert.deepEqual(f.store.waitEvidence(wait.id).wait.source_ids, [request.id]);
  } finally {
    f.close();
  }
});

test('Upcoming keeps overdue work and uncertain dates, but not events known to have passed', () => {
  const today = '2026-10-30';
  const gtd = GtdSchema.parse({
    commitment: 'active',
    project: null,
    times: [{ kind: 'scheduled', text: 'Yesterday', date: '2026-10-29' }],
    recurrence: null,
  });
  assert.equal(isUpcoming({ kind: 'event', gtd }, today), false);
  assert.equal(isUpcoming({ kind: 'task', gtd }, today), true);
  assert.equal(
    isUpcoming(
      { kind: 'event', gtd: { ...gtd, times: [{ ...gtd.times[0]!, date: null }] } },
      today,
    ),
    true,
  );
});

test('GTD organization remains separate from the item and survives later analysis', () => {
  const f = fixture();
  try {
    f.store.apply([f.change], [f.message]);
    const task = f.store.snapshot().tasks[0];
    assert.ok(task);
    f.store.setGtd(task.id, {
      commitment: 'someday',
      project: 'Exports',
      area: 'Operations',
      times: [{ kind: 'revisit', text: 'next month', date: null }],
      recurrence: null,
    });
    f.store.apply([{ ...f.change, id: task.id, note: 'New evidence' }], [f.message]);
    const updated = f.store.taskEvidence(task.id).task;
    assert.equal(updated.done, false);
    assert.equal(updated.gtd.commitment, 'someday');
    assert.equal(updated.gtd.times[0]?.text, 'next month');
    assert.equal(updated.gtd.times[0]?.date, null);
    assert.equal(updated.gtd.project, 'Exports');
    assert.equal(updated.gtd.area, 'Operations');
    const evidence = f.store.taskEvidence(task.id);
    assert.equal(f.store.filterNotTask(task.id, evidence.revision), false);
    assert.equal(f.store.taskEvidence(task.id).task.done, false);
  } finally {
    f.close();
  }
});

test('completing a recurring occurrence advances once without completing the whole item', () => {
  const f = fixture();
  try {
    f.store.apply([f.change], [f.message]);
    const task = f.store.snapshot().tasks[0];
    assert.ok(task);
    f.store.setGtd(task.id, {
      commitment: 'active',
      project: null,
      times: [],
      recurrence: { frequency: 'monthly', anchor_date: '2026-01-31', next_date: '2026-01-31' },
    });
    assert.equal(
      f.store.autoSetTaskKind(task.id, f.store.taskEvidence(task.id).revision, 'question'),
      false,
    );
    assert.equal(f.store.completeOccurrence(task.id, '2026-01-31'), true);
    assert.equal(f.store.completeOccurrence(task.id, '2026-01-31'), false);
    let current = f.store.taskEvidence(task.id).task;
    assert.equal(current.done, false);
    assert.equal(current.gtd.recurrence?.next_date, '2026-02-28');
    assert.equal(f.store.completeOccurrence(task.id, '2026-02-28'), true);
    current = f.store.taskEvidence(task.id).task;
    assert.equal(current.gtd.recurrence?.next_date, '2026-03-31');
    assert.deepEqual(
      current.occurrences.map((occurrence) => occurrence.date),
      ['2026-01-31', '2026-02-28'],
    );
  } finally {
    f.close();
  }
});

test('TODO references stay unique and stable through edits, completion and restart', () => {
  const f = fixture();
  try {
    f.store.apply([f.change], [f.message]);
    const first = f.store.snapshot().tasks[0];
    assert.ok(first);
    assert.equal(first.reference, 'TODO-001');
    f.store.apply(
      [{ ...f.change, id: first.id, title: 'Restore the missing export column' }],
      [f.message],
    );
    f.store.tick(first.id, true);
    f.store.apply([{ ...f.change, title: 'Review the next export' }], [f.message]);
    assert.equal(f.store.taskEvidence(first.reference).task.id, first.id);
    const references = f.store.snapshot().tasks.map((task) => task.reference);
    assert.deepEqual(references, ['TODO-001', 'TODO-002']);
    const reopened = new Store(f.dir);
    try {
      assert.deepEqual(
        reopened.snapshot().tasks.map((task) => task.reference),
        references,
      );
      assert.equal(reopened.taskEvidence(first.reference).task.done, true);
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});
test('upgrading existing tasks assigns references without changing their content or completion', () => {
  const f = fixture();
  try {
    f.store.apply([f.change], [f.message]);
    const task = f.store.snapshot().tasks[0];
    assert.ok(task);
    f.store.tick(task.id, true);
    f.store.remark(task.id, 'Preserve my note');
    const before = f.store.snapshot().tasks[0];
    f.store.db.exec(
      'DROP TRIGGER IF EXISTS assign_task_reference; DROP TABLE IF EXISTS task_references',
    );
    const upgraded = new Store(f.dir);
    try {
      assert.deepEqual(upgraded.snapshot().tasks[0], before);
      upgraded.apply([{ ...f.change, title: 'A task after upgrade' }], [f.message]);
      assert.deepEqual(
        upgraded.snapshot().tasks.map((item) => item.reference),
        ['TODO-001', 'TODO-002'],
      );
    } finally {
      upgraded.close();
    }
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
