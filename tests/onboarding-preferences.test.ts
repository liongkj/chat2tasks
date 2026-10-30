import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, now } from '../src/server/store.js';
import { MessageSchema, TaskChangeSchema } from '../src/shared/schema.js';

test('attention preferences persist without changing existing workspaces', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat2tasks-preferences-'));
  try {
    let store = new Store(dir);
    assert.equal(store.preferences().screenshots, 'task');
    assert.equal(store.preferences().resolveReplies, 'automatically');
    store.savePreferences({
      ...store.preferences(),
      screenshots: 'review',
      resolveReplies: 'review',
      includeReminders: false,
    });
    store.close();
    store = new Store(dir);
    assert.equal(store.preferences().screenshots, 'review');
    assert.equal(store.preferences().resolveReplies, 'review');
    assert.equal(store.preferences().includeReminders, false);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a customer who wants to review replies keeps work open until confirming completion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat2tasks-preferences-'));
  const store = new Store(dir);
  try {
    store.savePreferences({ ...store.preferences(), resolveReplies: 'review' });
    const request = MessageSchema.parse({
      id: 'request',
      sessionId: 's',
      chatId: 'c',
      direction: 'incoming',
      body: 'Please send the report',
      type: 'text',
      timestamp: now() - 20,
    });
    const reply = MessageSchema.parse({
      id: 'reply',
      sessionId: 's',
      chatId: 'c',
      direction: 'outgoing',
      body: 'I sent the report',
      type: 'text',
      timestamp: now() - 10,
    });
    store.cache([request, reply]);
    store.apply(
      [
        TaskChangeSchema.parse({
          id: null,
          title: 'Send the report',
          scope: 'Example',
          note: 'Requested',
          source_ids: ['request'],
          kind: 'action',
          action_steps: [],
          done_when: [],
          priority: 'normal',
          triage_state: 'ready',
          blocking_question: null,
        }),
      ],
      [request],
    );
    const task = store.snapshot().tasks[0];
    assert.ok(task);
    store.decide(
      [
        {
          message_id: reply.id,
          action: 'complete',
          task_ids: [task.id],
          evidence_quote: reply.body,
          reason: 'Report sent',
          question: null,
        },
      ],
      [reply],
      now(),
    );
    assert.equal(store.snapshot().tasks[0]?.done, false);
    assert.equal(store.snapshot().questions.length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
