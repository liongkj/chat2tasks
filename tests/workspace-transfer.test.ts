import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, now } from '../src/server/store.js';
import { OpenWA } from '../src/server/openwa.js';
import { MessageSchema, TaskChangeSchema } from '../src/shared/schema.js';
import { exportWorkspace, importWorkspace } from '../src/server/workspace-transfer.js';

test('an encrypted transfer preserves workspace evidence and pauses the old connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat2tasks-transfer-'));
  const store = new Store(join(root, 'old'));
  try {
    store.saveSettings({
      settings: {
        ...store.settings(),
        openwaUrl: 'https://example.invalid',
        webhookUrl: 'https://example.invalid/api/webhooks/openwa',
        chats: [{ id: 'c', name: 'Chat', sessionId: 'old-session', chatId: 'chat', enabled: true }],
      },
      secrets: { openwa: 'private-gateway-key' },
      removeSecrets: [],
    });
    const request = MessageSchema.parse({
      id: 'image',
      sessionId: 'old-session',
      chatId: 'chat',
      type: 'image',
      direction: 'incoming',
      body: 'Private source text',
      timestamp: now(),
    });
    store.cache([request]);
    await new OpenWA(store).saveMedia(request.id, Buffer.from('fictional image'));
    store.apply(
      [
        TaskChangeSchema.parse({
          id: null,
          title: 'Fix the disk',
          scope: 'Example',
          note: 'Check storage',
          source_ids: [request.id],
          kind: 'task',
          action_steps: ['Inspect disk'],
          done_when: ['Disk is healthy'],
          priority: 'normal',
          triage_state: 'ready',
          blocking_question: null,
        }),
      ],
      [request],
    );
    const original = store.snapshot().tasks[0];
    assert.ok(original);
    store.remark(original.id, 'Private owner note');
    store.tick(original.id, true);
    store.createWait({ expected: 'A report', person: 'Sam', task_id: original.id, source_ids: [] });
    store.savePreferences({ ...store.preferences(), screenshots: 'review' });
    const file = join(root, 'workspace.c2t');
    await exportWorkspace(store, file, 'example passphrase');
    const bytes = await readFile(file);
    assert.equal(bytes.includes(Buffer.from('Private source text')), false);
    await assert.rejects(importWorkspace(file, join(root, 'wrong'), 'wrong passphrase'));
    await importWorkspace(file, join(root, 'new'), 'example passphrase');
    const restored = new Store(join(root, 'new'));
    try {
      const result = restored.snapshot();
      assert.equal(result.tasks[0]?.reference, original.reference);
      assert.equal(result.tasks[0]?.own_remark, 'Private owner note');
      assert.equal(result.tasks[0]?.done, true);
      assert.equal(result.waiting_for[0]?.expected, 'A report');
      assert.equal(result.messages[0]?.body, 'Private source text');
      assert.equal(restored.preferences().screenshots, 'review');
      assert.equal(restored.settings().chats[0]?.enabled, false);
      assert.equal(restored.settings().openwaUrl, '');
      assert.equal(restored.secret('openwa'), '');
      const image = await new OpenWA(restored).media(result.messages[0]!);
      assert.equal(image?.bytes.toString(), 'fictional image');
      assert.equal(store.settings().chats[0]?.enabled, true);
    } finally {
      restored.close();
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('relinking an imported conversation keeps its tasks and does not reprocess unchanged messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat2tasks-relink-'));
  const store = new Store(root);
  try {
    store.saveSettings({
      settings: {
        ...store.settings(),
        chats: [
          { id: 'saved-chat', name: 'Chat', sessionId: 'old', chatId: 'group', enabled: false },
        ],
      },
      secrets: {},
      removeSecrets: [],
    });
    const request = MessageSchema.parse({
      id: 'source',
      sessionId: 'old',
      chatId: 'group',
      waMessageId: 'wa-id',
      type: 'text',
      direction: 'incoming',
      body: 'Please send the PDF',
      timestamp: now(),
    });
    store.cache([request]);
    store.apply(
      [
        TaskChangeSchema.parse({
          id: null,
          title: 'Send the PDF',
          scope: 'Example',
          note: 'Requested',
          source_ids: [request.id],
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
    const before = store.snapshot().tasks[0];
    assert.ok(before);
    store.relinkConversation('saved-chat', 'new');
    const after = store.snapshot();
    assert.equal(after.tasks[0]?.reference, before.reference);
    assert.deepEqual(after.tasks[0]?.source_ids, ['source']);
    assert.equal(after.messages[0]?.sessionId, 'new');
    assert.equal(store.settings().chats[0]?.enabled, false);
    assert.equal(store.pending(after.messages).length, 0);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
