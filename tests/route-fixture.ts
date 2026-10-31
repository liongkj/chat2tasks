import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { z } from 'zod';
import { Store } from '../src/server/store.js';
import { UserError } from '../src/server/errors.js';
import { MessageSchema, TaskChangeSchema } from '../src/shared/schema.js';

/** A Fastify instance with the same UserError and Zod handling as the real server. */
export function routeServer() {
  const server = Fastify();
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof UserError)
      return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof z.ZodError)
      return reply.code(400).send({ error: error.issues.map((x) => x.message).join('. ') });
    throw error;
  });
  return server;
}

/** A store in a temporary directory holding one message and one task sourced from it. */
export function seededStore(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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
  return { dir, store, message, task };
}
