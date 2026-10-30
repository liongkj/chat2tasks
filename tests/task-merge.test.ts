import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { MessageSchema, TaskChangeSchema } from '../src/shared/schema.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chat2tasks-merge-'));
  const store = new Store(dir);
  const entry = (id: string) => {
    const message = MessageSchema.parse({
      id,
      sessionId: 'session',
      chatId: id,
      body: 'Evidence ' + id,
      direction: 'incoming',
      timestamp: 1,
    });
    const change = TaskChangeSchema.parse({
      id: null,
      title: 'Issue ' + message.id,
      scope: 'Project',
      note: message.body,
      source_ids: [message.id],
      action_steps: ['Check the evidence'],
      done_when: ['Issue resolved'],
      priority: 'normal',
      triage_state: 'ready',
      blocking_question: null,
    });
    return { message, change };
  };
  const a = entry('a'),
    b = entry('b'),
    c = entry('c');
  store.cache([a.message, b.message, c.message]);
  for (const item of [a, b]) store.apply([item.change], [item.message]);
  const source = store.snapshot().tasks.find((task) => task.title === a.change.title);
  const target = store.snapshot().tasks.find((task) => task.title === b.change.title);
  assert.ok(source && target);
  const merge = () => ({
    source_id: source.id,
    target_id: target.id,
    source_revision: store.taskEvidence(source.id).revision,
    target_revision: store.taskEvidence(target.id).revision,
  });
  return {
    dir,
    store,
    a,
    b,
    c,
    source,
    target,
    merge,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('manual merge moves evidence and redirects old references while retaining both personal notes and completion records', () => {
  const f = fixture();
  try {
    f.store.remark(f.source.id, 'Original personal note');
    f.store.remark(f.target.id, 'Destination personal note');
    f.store.setGtd(f.source.id, {
      commitment: 'someday',
      project: 'Exports',
      times: [],
      recurrence: null,
    });
    const wait = f.store.createWait({
      expected: 'Requested file',
      person: null,
      task_id: f.source.id,
      source_ids: [f.a.message.id],
    });
    f.store.tick(f.target.id, true);
    const reply = MessageSchema.parse({
      ...f.a.message,
      id: 'reply',
      direction: 'outgoing',
      body: 'Is the issue done?',
      timestamp: Date.now() / 1000,
    });
    f.store.cache([reply]);
    f.store.decide(
      [
        {
          message_id: reply.id,
          action: 'ask',
          task_ids: [f.source.id],
          evidence_quote: '',
          reason: 'Ambiguous completion',
          question: 'Which issue is complete?',
        },
      ],
      [reply],
      Date.now() / 1000,
    );
    const request = f.merge();
    const result = f.store.mergeTasks(request);
    assert.equal(f.store.snapshot().tasks.length, 1);
    assert.equal(result.task.id, f.target.id);
    assert.equal(result.task.title, f.target.title);
    assert.equal(result.task.done, true);
    assert.equal(result.task.own_remark, 'Destination personal note');
    assert.deepEqual(result.task.source_ids.toSorted(), ['a', 'b']);
    assert.equal(result.task.merged_from[0]?.own_remark, 'Original personal note');
    assert.equal(result.task.merged_from[0]?.reference, f.source.reference);
    assert.equal(result.task.merged_from[0]?.gtd.project, 'Exports');
    assert.equal(f.store.waitEvidence(wait.id).wait.task_id, f.target.id);
    assert.deepEqual(result.task.merged_from[0]?.source_ids, f.source.source_ids);
    assert.equal(f.store.taskEvidence(f.source.id).task.id, f.target.id);
    assert.equal(f.store.taskEvidence(f.source.reference).task.id, f.target.id);
    assert.deepEqual(f.store.snapshot().questions[0]?.task_ids, [f.target.id]);
    assert.deepEqual(f.store.mergeTasks(request), result);
    assert.throws(() => f.store.tick(f.source.id, true), /merged/);
    const reopened = new Store(f.dir);
    try {
      assert.equal(reopened.taskEvidence(f.source.reference).task.id, f.target.id);
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});

test('manual merge rejects self-merges, missing destinations and stale edits atomically', () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.store.mergeTasks({ ...f.merge(), target_id: f.source.reference }),
      /itself/,
    );
    assert.throws(() => f.store.mergeTasks({ ...f.merge(), target_id: 'missing' }), /not found/);
    const stale = f.merge();
    f.store.remark(f.target.id, 'Changed while the merge was being prepared');
    const before = f.store.snapshot().tasks;
    assert.throws(() => f.store.mergeTasks(stale), /changed/);
    assert.deepEqual(f.store.snapshot().tasks, before);
  } finally {
    f.close();
  }
});

test('model replay cannot recreate a merged TODO or overwrite its destination, and merge chains keep every old link working', () => {
  const f = fixture();
  try {
    f.store.mergeTasks(f.merge());
    for (const id of [f.source.id, null]) {
      assert.equal(f.store.apply([{ ...f.a.change, id }], [f.a.message]), 0);
      assert.equal(f.store.snapshot().tasks.length, 1);
      assert.equal(f.store.taskEvidence(f.target.id).task.title, f.target.title);
    }
    f.store.apply(
      [{ ...f.b.change, id: f.target.id, source_ids: ['a', 'b'], note: 'Combined evidence' }],
      [f.b.message],
      [f.a.message],
    );
    assert.equal(f.store.taskEvidence(f.target.id).task.note, 'Combined evidence');
    assert.throws(
      () => f.store.apply([{ ...f.c.change, id: f.target.id }], [f.c.message]),
      /another conversation/,
    );
    f.store.apply([f.c.change], [f.c.message]);
    const last = f.store.snapshot().tasks.find((task) => task.id !== f.target.id);
    assert.ok(last);
    f.store.mergeTasks({
      source_id: f.target.id,
      target_id: last.id,
      source_revision: f.store.taskEvidence(f.target.id).revision,
      target_revision: f.store.taskEvidence(last.id).revision,
    });
    assert.equal(f.store.taskEvidence(f.source.reference).task.id, last.id);
    assert.equal(f.store.taskEvidence(f.target.reference).task.id, last.id);
    assert.equal(f.store.taskEvidence(last.id).task.merged_from.length, 2);
    assert.throws(
      () =>
        f.store.mergeTasks({
          source_id: last.id,
          target_id: f.source.reference,
          source_revision: f.store.taskEvidence(last.id).revision,
          target_revision: f.store.taskEvidence(last.id).revision,
        }),
      /itself/,
    );
  } finally {
    f.close();
  }
});
