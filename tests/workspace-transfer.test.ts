import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, now } from '../src/server/store.js';
import { OpenWA } from '../src/server/openwa.js';
import { LocalSearch } from '../src/server/search.js';
import { Sync } from '../src/server/sync.js';
import Fastify from 'fastify';
import { DestinationMove } from '../src/server/destination-move.js';
import { MoveGate } from '../src/server/move-gate.js';
import { registerServerMoveRoutes } from '../src/server/server-move-routes.js';
import { WorkspaceOwnership } from '../src/server/workspace-ownership.js';
import { MessageSchema, TaskChangeSchema } from '../src/shared/schema.js';
import {
  exportWorkspace,
  importMovedWorkspace,
  importWorkspace,
} from '../src/server/workspace-transfer.js';

test('a move snapshot includes updates that were already in progress', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat2tasks-move-'));
  const store = new Store(join(root, 'source'));
  const source = WorkspaceOwnership.open(join(root, 'source', '.ownership'), 'server');
  const targetData = join(root, 'target');
  const existing = new Store(join(targetData, 'workspace'));
  existing.setMeta('previous_local_workspace', 'kept as a backup');
  existing.close();
  await mkdir(join(targetData, 'gateway'), { recursive: true });
  await mkdir(join(targetData, 'codex'), { recursive: true });
  await writeFile(join(targetData, 'gateway', 'marker'), 'old gateway');
  await writeFile(join(targetData, 'codex', 'marker'), 'old sign-in');
  const target = new DestinationMove(targetData);
  const moveId = randomUUID();
  const app = Fastify();
  const gate = new MoveGate(app);
  let redirectedTo = '';
  registerServerMoveRoutes(app, {
    gate,
    ownership: source,
    store,
    stopBackground: async () => {},
    completed: async (_id, origin) => {
      redirectedTo = origin;
    },
  });
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const release = new Promise<void>((resolve) => (finish = resolve));
  app.post('/api/edit', async () => {
    entered();
    await release;
    store.setMeta('last_user_update', 'completed before the move');
    return { ok: true };
  });
  try {
    const request = app.inject({ method: 'POST', url: '/api/edit' }).then((response) => response);
    await started;
    const startedMove = await app.inject({
      method: 'POST',
      url: '/api/workspace/move/start',
      payload: {
        id: moveId,
        target: await target.prepare(moveId),
        targetOrigin: 'https://target.example',
      },
    });
    assert.equal(startedMove.statusCode, 202);
    assert.equal((await app.inject({ method: 'POST', url: '/api/edit' })).statusCode, 503);
    assert.equal(
      (await app.inject({ method: 'GET', url: `/api/workspace/move/${moveId}` })).json().kind,
      'preparing',
    );
    finish();
    assert.equal((await request).statusCode, 200);
    let status = (await app.inject({ method: 'GET', url: `/api/workspace/move/${moveId}` })).json();
    for (let attempt = 0; status.kind === 'preparing' && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (await app.inject({ method: 'GET', url: `/api/workspace/move/${moveId}` })).json();
    }
    assert.equal(status.kind, 'ready');
    const grant = status.grant;
    assert.throws(() => source.assertCanRun(), /move/i);
    const path = join(root, 'move.c2t');
    const download = await app.inject({
      method: 'GET',
      url: `/api/workspace/move/${moveId}/archive`,
    });
    assert.equal(download.statusCode, 200);
    await writeFile(path, download.rawPayload);
    const receive = {
      grant,
      trustedSourceKey: source.identity().signingPublicKey,
      archivePath: path,
      localPort: 2786,
      password: 'fictional-target-password',
    };
    const conflictingBackup = join(targetData, `workspace.before-move-${moveId}`);
    await mkdir(conflictingBackup);
    await assert.rejects(target.receive(receive), /backup already exists/i);
    assert.throws(() => source.assertCanRun(), /move/i);
    assert.throws(
      () =>
        WorkspaceOwnership.open(
          join(targetData, 'server-moves', moveId, 'workspace', '.ownership'),
          'client',
        ).assertCanRun(),
      /move/i,
    );
    await rm(conflictingBackup, { recursive: true });
    const acknowledgement = await target.receive(receive);
    assert.equal(await target.receive(receive), acknowledgement);
    assert.equal(await target.recoverCompleted(moveId), acknowledgement);
    assert.equal(source.verifyActivation(moveId, acknowledgement), 'https://target.example');
    assert.throws(() => source.verifyActivation(moveId, 'invalid'), /authorization/i);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/workspace/move/${moveId}/complete`,
          payload: { acknowledgement },
        })
      ).statusCode,
      200,
    );
    assert.equal(redirectedTo, 'https://target.example');
    const unrelated = WorkspaceOwnership.open(join(root, 'unrelated-owner'), 'client');
    await assert.rejects(
      target.receive({ ...receive, trustedSourceKey: unrelated.identity().signingPublicKey }),
      /authorization/i,
    );
    WorkspaceOwnership.open(join(targetData, 'workspace', '.ownership'), 'client').assertCanRun();
    const restored = new Store(join(targetData, 'workspace'));
    try {
      assert.equal(restored.metaValue('last_user_update'), 'completed before the move');
      assert.deepEqual(restored.desktopSharing(), {
        kind: 'enabled',
        origin: 'https://target.example',
        port: 2786,
      });
    } finally {
      restored.close();
    }
    const backup = new Store(join(targetData, `workspace.before-move-${moveId}`));
    try {
      assert.equal(backup.metaValue('previous_local_workspace'), 'kept as a backup');
    } finally {
      backup.close();
    }
    assert.equal(
      await readFile(join(targetData, `gateway.before-move-${moveId}`, 'marker'), 'utf8'),
      'old gateway',
    );
    assert.equal(
      await readFile(join(targetData, `codex.before-move-${moveId}`, 'marker'), 'utf8'),
      'old sign-in',
    );
  } finally {
    finish();
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an interrupted preparation can retry without restarting the old processor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat2tasks-move-retry-'));
  const store = new Store(join(root, 'source'));
  const source = WorkspaceOwnership.open(join(store.dir, '.ownership'), 'server');
  const target = WorkspaceOwnership.open(join(root, 'target'), 'client');
  const proposal = {
    id: randomUUID(),
    target: target.identity(),
    targetOrigin: 'https://target.example',
  };
  source.prepare(proposal);
  const directory = join(store.dir, '.server-moves');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, proposal.id + '.c2t'), 'interrupted snapshot');
  const app = Fastify();
  const gate = new MoveGate(app);
  registerServerMoveRoutes(app, {
    gate,
    ownership: source,
    store,
    stopBackground: async () => {},
    completed: async () => {},
  });
  try {
    assert.throws(() => source.assertCanRun(), /move/i);
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/workspace/move/start', payload: proposal }))
        .statusCode,
      202,
    );
    let status = (
      await app.inject({ method: 'GET', url: `/api/workspace/move/${proposal.id}` })
    ).json();
    for (let attempt = 0; status.kind === 'preparing' && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = (
        await app.inject({ method: 'GET', url: `/api/workspace/move/${proposal.id}` })
      ).json();
    }
    assert.equal(status.kind, 'ready');
    await target.stage(
      status.grant,
      source.identity().signingPublicKey,
      join(directory, proposal.id + '.c2t'),
    );
    assert.throws(() => source.assertCanRun(), /move/i);
  } finally {
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
    store.saveDesktopSharing({
      kind: 'enabled',
      origin: 'https://shared.example:8443',
      port: 2786,
      password: 'fictional-sharing-password',
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
    const search = new LocalSearch(store.db, () => store.snapshot());
    search.saveSettings({ kind: 'server', url: 'https://search.example.invalid' });
    store.db
      .prepare("INSERT INTO search_embeddings VALUES('message','image',0,'old',?)")
      .run(Buffer.alloc(1024));
    store.queueChat('c', 60, true, true);
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
      assert.deepEqual(restored.desktopSharing(), { kind: 'disabled' });
      assert.equal(restored.secret('desktop-sharing-password'), '');
      assert.equal(restored.jobs().length, 0);
      const restoredSearch = new LocalSearch(restored.db, () => restored.snapshot());
      assert.deepEqual(restoredSearch.settings(), { kind: 'workspace' });
      assert.equal(
        restored.db.prepare('SELECT count(*) AS count FROM search_embeddings').get()?.count,
        0,
      );
      const image = await new OpenWA(restored).media(result.messages[0]!);
      assert.equal(image?.bytes.toString(), 'fictional image');
      assert.equal(store.settings().chats[0]?.enabled, true);
      assert.equal(store.desktopSharing().kind, 'enabled');
    } finally {
      restored.close();
    }
    await importMovedWorkspace(file, join(root, 'moved'), 'example passphrase');
    const moved = new Store(join(root, 'moved'));
    try {
      assert.equal(moved.settings().chats[0]?.enabled, false);
      assert.equal(moved.jobs().length, 0, 'pending work waits while the conversation is paused');
      moved.saveSettings({
        settings: {
          ...moved.settings(),
          chats: moved.settings().chats.map((chat) => ({ ...chat, enabled: true })),
        },
        secrets: {},
        removeSecrets: [],
      });
      const sync = new Sync(moved, new OpenWA(moved));
      sync.stop();
      sync.reconfigure();
      assert.equal(moved.jobs()[0]?.manual, 1, 'pending manual analysis survives the move');
    } finally {
      moved.close();
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
