import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { OpenWA } from '../src/server/openwa.js';
import { registerWorkspaceRoutes } from '../src/server/workspace-routes.js';
import { routeServer, seededStore } from './route-fixture.js';

async function fixture() {
  const { dir, store, task } = seededStore('wawa-workspace-routes-');
  const server = routeServer();
  registerWorkspaceRoutes(server, store, new OpenWA(store));
  await server.ready();
  return {
    store,
    task,
    server,
    async close() {
      await server.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('state and export return the same snapshot', async () => {
  const f = await fixture();
  try {
    const state = await f.server.inject({ method: 'GET', url: '/api/state' });
    const exported = await f.server.inject({ method: 'GET', url: '/api/export' });
    assert.equal(state.statusCode, 200);
    assert.deepEqual(state.json().tasks, exported.json().tasks);
    assert.equal(state.json().tasks[0].id, f.task.id);
  } finally {
    await f.close();
  }
});

test('import ticks known tasks and rejects unknown ones atomically', async () => {
  const f = await fixture();
  try {
    const ok = await f.server.inject({
      method: 'POST',
      url: '/api/import',
      payload: { tasks: [{ id: f.task.id, done: true }] },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(f.store.snapshot().tasks[0]?.done, true);
    const bad = await f.server.inject({
      method: 'POST',
      url: '/api/import',
      payload: {
        tasks: [
          { id: f.task.id, done: false },
          { id: 'missing', done: true },
        ],
      },
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, 'Task not found');
    // The transaction rolled back the first tick too.
    assert.equal(f.store.snapshot().tasks[0]?.done, true);
  } finally {
    await f.close();
  }
});

test('resolve reports an already resolved question as a user error', async () => {
  const f = await fixture();
  try {
    const response = await f.server.inject({
      method: 'POST',
      url: '/api/resolve',
      payload: { id: 'nope', task_id: null },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'Question already resolved');
  } finally {
    await f.close();
  }
});

test('preferences round-trip and media reports missing attachments', async () => {
  const f = await fixture();
  try {
    const before = await f.server.inject({ method: 'GET', url: '/api/preferences' });
    assert.equal(before.statusCode, 200);
    const saved = await f.server.inject({
      method: 'POST',
      url: '/api/preferences',
      payload: before.json(),
    });
    assert.equal(saved.statusCode, 200);
    const media = await f.server.inject({ method: 'GET', url: '/api/media?id=unknown' });
    assert.equal(media.statusCode, 404);
    assert.equal(media.json().error, 'Attachment not found');
  } finally {
    await f.close();
  }
});

test('workspace transfer needs an eight character passphrase and streams an archive', async () => {
  const f = await fixture();
  try {
    const short = await f.server.inject({
      method: 'POST',
      url: '/api/workspace/transfer',
      payload: { passphrase: 'short' },
    });
    assert.equal(short.statusCode, 400);
    const archive = await f.server.inject({
      method: 'POST',
      url: '/api/workspace/transfer',
      payload: { passphrase: 'long enough passphrase' },
    });
    assert.equal(archive.statusCode, 200);
    assert.equal(archive.headers['content-type'], 'application/octet-stream');
    assert.match(String(archive.headers['content-disposition']), /workspace\.c2t/);
    assert.ok(archive.rawPayload.length > 0);
  } finally {
    await f.close();
  }
});
