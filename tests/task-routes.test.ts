import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Store } from '../src/server/store.js';
import { UserError } from '../src/server/errors.js';
import { registerTaskRoutes } from '../src/server/task-routes.js';
import { MessageSchema, TaskChangeSchema } from '../src/shared/schema.js';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wawa-task-routes-'));
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
  store.apply(
    [
      TaskChangeSchema.parse({
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
      }),
    ],
    [message],
  );
  const task = store.snapshot().tasks[0];
  assert.ok(task);
  const server = Fastify();
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof UserError)
      return reply.code(error.statusCode).send({ error: error.message });
    throw error;
  });
  // Mounted twice, exactly as the workspace UI and the companion mount it.
  registerTaskRoutes(server, '/api', store);
  registerTaskRoutes(server, '/api/companion', store);
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

test('both mounts serve the same task evidence', async () => {
  const f = await fixture();
  try {
    for (const prefix of ['/api', '/api/companion']) {
      const response = await f.server.inject({
        method: 'GET',
        url: `${prefix}/tasks/${f.task.id}`,
      });
      assert.equal(response.statusCode, 200, prefix);
      assert.equal(response.json().task.title, 'Fix the export');
    }
  } finally {
    await f.close();
  }
});

test('tick and remark reject unknown tasks with 404 and persist for known ones', async () => {
  const f = await fixture();
  try {
    const missing = await f.server.inject({
      method: 'POST',
      url: '/api/tick',
      payload: { id: 'nope', done: true },
    });
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(missing.json(), { error: 'Task not found' });
    const missingRemark = await f.server.inject({
      method: 'POST',
      url: '/api/companion/remark',
      payload: { id: 'nope', remark: 'x' },
    });
    assert.equal(missingRemark.statusCode, 404);

    const ticked = await f.server.inject({
      method: 'POST',
      url: '/api/companion/tick',
      payload: { id: f.task.id, done: true },
    });
    assert.deepEqual(ticked.json(), { ok: true });
    const remarked = await f.server.inject({
      method: 'POST',
      url: '/api/remark',
      payload: { id: f.task.id, remark: 'Keep this' },
    });
    assert.deepEqual(remarked.json(), { ok: true });
    const task = f.store.snapshot().tasks[0];
    assert.equal(task?.done, true);
    assert.equal(task?.own_remark, 'Keep this');
  } finally {
    await f.close();
  }
});

test('waiting items can be created, updated, and confirmed over HTTP', async () => {
  const f = await fixture();
  try {
    const created = await f.server.inject({
      method: 'POST',
      url: '/api/waiting',
      payload: { expected: 'Invoice from Sam', person: 'Sam' },
    });
    assert.equal(created.statusCode, 200);
    const id: string = created.json().id;
    const received = await f.server.inject({
      method: 'POST',
      url: '/api/companion/waiting/state',
      payload: { id, state: 'received' },
    });
    assert.equal(received.json().wait.state, 'received');
    const evidence = await f.server.inject({ method: 'GET', url: `/api/waiting/${id}` });
    assert.equal(evidence.json().wait.expected, 'Invoice from Sam');
    const bad = await f.server.inject({
      method: 'POST',
      url: '/api/waiting/state',
      payload: { id, state: 'later' },
    });
    assert.equal(bad.statusCode, 500, 'zod errors are left to the host error handler');
  } finally {
    await f.close();
  }
});
