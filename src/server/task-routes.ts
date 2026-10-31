import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GtdSchema, ItemKindSchema, WaitInputSchema, WaitStateSchema } from '../shared/schema.js';
import type { Store } from './store.js';
import { UserError } from './errors.js';

const byId = z.object({ id: z.string() });

/**
 * Task and waiting-item routes shared by the workspace UI (`/api`) and the
 * Chrome companion (`/api/companion`), so the two cannot drift apart.
 */
export function registerTaskRoutes(server: FastifyInstance, prefix: string, store: Store) {
  const requireTask = (id: string) => {
    if (!store.db.prepare('SELECT id FROM tasks WHERE id=?').get(id))
      throw new UserError('Task not found', 404);
  };
  server.get(prefix + '/tasks/:id', (request) => store.taskEvidence(byId.parse(request.params).id));
  server.post(prefix + '/tasks/kind', (request) => {
    const value = byId.extend({ kind: ItemKindSchema }).parse(request.body);
    store.setTaskKind(value.id, value.kind);
    return { ok: true };
  });
  server.post(prefix + '/tasks/gtd', (request) => {
    const value = byId.extend({ gtd: GtdSchema }).parse(request.body);
    return store.setGtd(value.id, value.gtd);
  });
  server.post(prefix + '/tasks/occurrence', (request) => {
    const value = byId.extend({ date: z.iso.date() }).parse(request.body);
    return { ok: store.completeOccurrence(value.id, value.date) };
  });
  server.post(prefix + '/tick', (request) => {
    const value = byId.extend({ done: z.boolean() }).parse(request.body);
    requireTask(value.id);
    store.transaction(() => store.tick(value.id, value.done));
    return { ok: true };
  });
  server.post(prefix + '/remark', (request) => {
    const value = byId.extend({ remark: z.string().max(4000) }).parse(request.body);
    requireTask(value.id);
    store.remark(value.id, value.remark);
    return { ok: true };
  });
  server.get(prefix + '/waiting/:id', (request) =>
    store.waitEvidence(byId.parse(request.params).id),
  );
  server.post(prefix + '/waiting', (request) =>
    store.createWait(WaitInputSchema.parse(request.body)),
  );
  server.post(prefix + '/waiting/state', (request) => {
    const value = byId.extend({ state: WaitStateSchema }).parse(request.body);
    return store.setWaitState(value.id, value.state);
  });
  server.post(prefix + '/waiting/confirm', (request) =>
    store.confirmWait(byId.parse(request.body).id),
  );
}
