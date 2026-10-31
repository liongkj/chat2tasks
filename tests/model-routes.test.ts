import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import Fastify from 'fastify';
import { OpenWA } from '../src/server/openwa.js';
import { registerModelRoutes } from '../src/server/model-routes.js';
import { routeServer, seededStore } from './route-fixture.js';

async function fixture(catalog: { status: number; body: unknown }) {
  const { dir, store, task } = seededStore('wawa-model-routes-');
  const provider = Fastify();
  const seen: string[] = [];
  provider.get('/v1/models', (request, reply) => {
    seen.push(String(request.headers.authorization ?? ''));
    return reply.code(catalog.status).send(catalog.body);
  });
  const baseUrl = await provider.listen({ port: 0, host: '127.0.0.1' });
  store.saveSettings({
    settings: {
      ...store.settings(),
      profiles: [
        { id: 'fake', name: 'Fixture', kind: 'compatible', model: 'm', baseUrl: baseUrl + '/v1' },
        { id: 'codex', name: 'Codex', kind: 'codex', model: 'c' },
      ],
      activeProfileId: 'fake',
    },
    secrets: { 'fake:key': 'fixture-key' },
    removeSecrets: [],
  });
  const server = routeServer();
  registerModelRoutes(server, store, new OpenWA(store));
  await server.ready();
  return {
    store,
    task,
    server,
    seen,
    async close() {
      await server.close();
      await provider.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('the model catalog is fetched with the stored key and sorted', async () => {
  const f = await fixture({ status: 200, body: { data: [{ id: 'zeta' }, { id: 'alpha' }] } });
  try {
    const response = await f.server.inject({
      method: 'POST',
      url: '/api/models',
      payload: { profileId: 'fake' },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { models: ['alpha', 'zeta'] });
    assert.deepEqual(f.seen, ['Bearer fixture-key']);
  } finally {
    await f.close();
  }
});

test('profiles without a catalog return an empty list instead of failing', async () => {
  const f = await fixture({ status: 404, body: { error: 'nope' } });
  try {
    const missing = await f.server.inject({
      method: 'POST',
      url: '/api/models',
      payload: { profileId: 'fake' },
    });
    assert.equal(missing.statusCode, 200);
    assert.deepEqual(missing.json().models, []);
    assert.match(missing.json().error, /Enter a model ID manually/);
    const codex = await f.server.inject({
      method: 'POST',
      url: '/api/models',
      payload: { profileId: 'codex' },
    });
    assert.deepEqual(codex.json(), { models: [] });
  } finally {
    await f.close();
  }
});

test('prompts are served and handoff validates the task and connection first', async () => {
  const f = await fixture({ status: 200, body: { data: [] } });
  try {
    const prompts = await f.server.inject({ method: 'GET', url: '/api/prompts' });
    assert.equal(prompts.statusCode, 200);
    assert.deepEqual(Object.keys(prompts.json()).sort(), [
      'completion',
      'handoff',
      'review',
      'triage',
      'vision',
    ]);
    const unknownTask = await f.server.inject({
      method: 'POST',
      url: '/api/handoff',
      payload: { id: 'missing' },
    });
    assert.equal(unknownTask.statusCode, 400);
    assert.equal(unknownTask.json().error, 'Task not found');
    const unknownProfile = await f.server.inject({
      method: 'POST',
      url: '/api/test-model',
      payload: { profileId: 'ghost' },
    });
    assert.equal(unknownProfile.statusCode, 400);
    assert.equal(unknownProfile.json().error, 'Unknown model connection');
  } finally {
    await f.close();
  }
});
