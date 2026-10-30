import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { MessageSchema, TaskChangeSchema } from '../src/shared/schema.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chat2tasks-triage-'));
  const store = new Store(dir);
  const message = MessageSchema.parse({
    id: 'source',
    sessionId: 'session',
    chatId: 'chat',
    body: 'The export is missing a column',
    direction: 'incoming',
    timestamp: 1,
  });
  const change = TaskChangeSchema.parse({
    id: null,
    title: 'Restore the export column',
    scope: 'Exports',
    note: 'Column missing',
    source_ids: [message.id],
    action_steps: ['Restore the column'],
    done_when: ['The exported file contains the column'],
    priority: 'normal',
    triage_state: 'ready',
    blocking_question: null,
  });
  store.cache([message]);
  store.apply([change], [message]);
  const {
    id: _id,
    source_ids: _sources,
    kind: _kind,
    kind_suggestion: _kindSuggestion,
    ...triage
  } = change;
  const task = store.snapshot().tasks[0];
  assert.ok(task);
  return {
    store,
    message,
    triage,
    task,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('triage updates the issue while preserving completion, personal notes, sources and pending work', () => {
  const f = fixture();
  try {
    f.store.tick(f.task.id, true);
    f.store.remark(f.task.id, 'Keep my personal note');
    const edited = { ...f.message, body: 'Which column is missing from the export?' };
    f.store.cache([edited]);
    const before = f.store.taskEvidence(f.task.id);
    const updated = f.store.triageTask({
      ...f.triage,
      id: f.task.id,
      expected_revision: before.revision,
      triage_state: 'needs_info',
      blocking_question: 'Which export column is missing?',
      note: 'The missing column has not been identified',
      priority: 'high',
    });
    assert.equal(updated.task.triage_state, 'needs_info');
    assert.equal(updated.task.priority, 'high');
    assert.equal(updated.task.done, true);
    assert.equal(updated.task.own_remark, 'Keep my personal note');
    assert.deepEqual(updated.task.source_ids, ['source']);
    assert.equal(f.store.pending([edited]).length, 1);
    assert.notEqual(updated.revision, before.revision);
    assert.throws(() =>
      f.store.triageTask({
        ...f.triage,
        id: f.task.id,
        expected_revision: updated.revision,
        triage_state: 'needs_info',
        blocking_question: null,
      }),
    );
    assert.deepEqual(f.store.taskEvidence(f.task.id), updated);
  } finally {
    f.close();
  }
});

test('triage rejects stale evidence and concurrent owner edits instead of overwriting them', () => {
  const f = fixture();
  try {
    for (const edit of [
      () => f.store.cache([{ ...f.message, body: 'Actually, restore two columns' }]),
      () => f.store.remark(f.task.id, 'Owner clarification'),
      () => f.store.tick(f.task.id, true),
    ]) {
      const before = f.store.taskEvidence(f.task.id);
      edit();
      const current = f.store.taskEvidence(f.task.id);
      assert.throws(
        () =>
          f.store.triageTask({
            ...f.triage,
            id: f.task.id,
            expected_revision: before.revision,
            priority: 'high',
          }),
        /changed/,
      );
      assert.deepEqual(f.store.taskEvidence(f.task.id), current);
    }
    assert.throws(() => f.store.taskEvidence('missing'), /not found/);
  } finally {
    f.close();
  }
});
