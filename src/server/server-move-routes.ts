import { createReadStream, existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MoveGate } from './move-gate.js';
import { ServerMove } from './server-move.js';
import type { Store } from './store.js';
import { MoveProposalSchema, type WorkspaceOwnership } from './workspace-ownership.js';

const MoveId = z.object({ id: z.uuid() });

export function registerServerMoveRoutes(
  server: FastifyInstance,
  parts: {
    gate: MoveGate;
    ownership: WorkspaceOwnership;
    store: Store;
    stopBackground: () => Promise<void>;
    completed: (moveId: string, targetOrigin: string) => Promise<void>;
  },
) {
  const root = join(parts.store.dir, '.server-moves');
  const archive = (id: string) => join(root, id + '.c2t');
  let running: { id: string } | null = null;

  server.get('/api/workspace/move/identity', () => parts.ownership.identity());
  server.post('/api/workspace/move/start', async (request, reply) => {
    const proposal = MoveProposalSchema.parse(request.body);
    if (running) {
      if (running.id !== proposal.id)
        return reply.code(409).send({ error: 'Another server move is already in progress.' });
      return reply.code(202).send({ kind: 'preparing', source: parts.ownership.identity() });
    }
    const role = parts.ownership.role();
    if (role === 'fenced') {
      const move = parts.ownership.move(proposal.id);
      if (JSON.stringify(move.proposal) !== JSON.stringify(proposal))
        return reply.code(409).send({ error: 'This server is fenced for a different move.' });
      return { kind: 'ready', source: parts.ownership.identity() };
    }
    if (role !== 'active' && role !== 'active_moved' && role !== 'preparing')
      return reply.code(409).send({ error: 'This computer cannot start a server move.' });
    if (role === 'preparing') {
      const move = parts.ownership.move(proposal.id);
      if (JSON.stringify(move.proposal) !== JSON.stringify(proposal))
        return reply.code(409).send({ error: 'A different server move needs recovery.' });
      if (parts.gate.isPaused())
        return reply.code(409).send({ error: 'Restart the old server to retry the move.' });
    }
    running = { id: proposal.id };
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      if (role === 'preparing') await rm(archive(proposal.id), { force: true });
      const work = new ServerMove(parts).begin({
        move: proposal,
        archivePath: archive(proposal.id),
      });
      void work.then(
        () => {
          running = null;
        },
        () => {
          running = null;
        },
      );
      return reply.code(202).send({ kind: 'preparing', source: parts.ownership.identity() });
    } catch (error) {
      running = null;
      throw error;
    }
  });

  server.get('/api/workspace/move/:id', async (request, reply) => {
    const { id } = MoveId.parse(request.params);
    if (running?.id === id) return { kind: 'preparing' };
    let move: ReturnType<WorkspaceOwnership['move']>;
    try {
      move = parts.ownership.move(id);
    } catch {
      return reply.code(404).send({ error: 'Server move not found.' });
    }
    if (move.kind === 'preparing') return { kind: 'needs_retry' };
    if (!existsSync(archive(id))) return { kind: 'recovery_required' };
    return { kind: 'ready', grant: move.grant };
  });

  server.get('/api/workspace/move/:id/archive', (request, reply) => {
    const { id } = MoveId.parse(request.params);
    const move = parts.ownership.move(id);
    if (move.kind !== 'fenced' || !existsSync(archive(id)))
      return reply.code(409).send({ error: 'The move snapshot is not ready.' });
    return reply.type('application/octet-stream').send(createReadStream(archive(id)));
  });

  server.post('/api/workspace/move/:id/complete', async (request) => {
    const { id } = MoveId.parse(request.params);
    const { acknowledgement } = z
      .object({ acknowledgement: z.string().min(1).max(1024) })
      .parse(request.body);
    const target = parts.ownership.verifyActivation(id, acknowledgement);
    await parts.completed(id, target);
    return { ok: true };
  });
}
