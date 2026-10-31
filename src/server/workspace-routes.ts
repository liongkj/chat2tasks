import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from './store.js';
import type { OpenWA } from './openwa.js';
import { TaskMergeSchema } from '../shared/schema.js';
import { exportWorkspace } from './workspace-transfer.js';
import { UserError } from './errors.js';

/** Snapshot, preferences, resolve, merge, import/export and media routes backed only by the store. */
export function registerWorkspaceRoutes(server: FastifyInstance, store: Store, openwa: OpenWA) {
  server.get('/api/state', () => store.snapshot());
  server.post('/api/tasks/merge', (request) =>
    store.mergeTasks(TaskMergeSchema.parse(request.body)),
  );
  server.get('/api/settings', () => store.publicSettings());
  server.get('/api/preferences', () => store.preferences());
  server.post('/api/preferences', (request) => store.savePreferences(request.body));
  server.post('/api/sound-preferences', (request) => store.saveSoundPreferences(request.body));
  server.post('/api/resolve', async (request) => {
    const value = z.object({ id: z.string(), task_id: z.string().nullable() }).parse(request.body);
    store.resolve(value.id, value.task_id);
    return { ok: true };
  });
  server.get('/api/export', () => store.snapshot());
  server.post('/api/workspace/transfer', async (request, reply) => {
    const { passphrase } = z
      .object({ passphrase: z.string().min(8).max(1024) })
      .parse(request.body);
    const directory = await mkdtemp(join(tmpdir(), 'chat2tasks-download-'));
    const path = join(directory, 'workspace.c2t');
    try {
      await exportWorkspace(store, path, passphrase);
      const stream = createReadStream(path);
      stream.once('close', () => void rm(directory, { recursive: true, force: true }));
      return reply
        .header('Content-Disposition', 'attachment; filename="chat2tasks-workspace.c2t"')
        .type('application/octet-stream')
        .send(stream);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  });
  server.post('/api/import', async (request) => {
    const { tasks } = z
      .object({ tasks: z.array(z.object({ id: z.string(), done: z.boolean() })).max(10000) })
      .parse(request.body);
    const valid = new Set(store.snapshot().tasks.map((t) => t.id));
    store.transaction(() => {
      for (const t of tasks) {
        if (!valid.has(t.id)) throw new UserError('Task not found');
        store.tick(t.id, t.done);
      }
    });
    return { ok: true };
  });
  server.get('/api/media', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.query),
      message = store.messages().find((m) => m.id === id);
    if (!message) return reply.code(404).send({ error: 'Attachment not found' });
    const attachment = await openwa.attachment(message);
    return attachment
      ? reply.type(attachment.mime).send(attachment.bytes)
      : reply.code(404).send({ error: 'OpenWA no longer serves this attachment' });
  });
}
