import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from './store.js';
import type { OpenWA } from './openwa.js';
import { callModel } from './ai.js';
import { decideTrigger } from './decisions.js';
import { prompt } from './sync.js';
import { TaskSchema } from '../shared/schema.js';
import { UserError } from './errors.js';

/** Routes that talk to model providers or the WhatsApp gateway on the user's behalf. */
export function registerModelRoutes(server: FastifyInstance, store: Store, openwa: OpenWA) {
  server.get('/api/prompts', async () =>
    Object.fromEntries(
      await Promise.all(
        ['triage', 'review', 'vision', 'completion', 'handoff'].map(async (name) => [
          name,
          await prompt(name),
        ]),
      ),
    ),
  );
  server.post('/api/discover', async (request) => {
    const { sessionId } = z.object({ sessionId: z.string().optional() }).parse(request.body);
    const response = await openwa.request(
      sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}/chats` : '/api/sessions',
    );
    return z
      .array(z.object({ id: z.string(), name: z.string().nullish() }))
      .parse(await response.json())
      .map((row) => ({ id: row.id, name: row.name ?? row.id }));
  });
  server.post('/api/models', async (request) => {
    const { profileId } = z.object({ profileId: z.string() }).parse(request.body),
      profile = store.settings().profiles.find((p) => p.id === profileId);
    if (!profile || profile.kind !== 'compatible') return { models: [] };
    const key = store.secret(profile.id + ':key');
    const response = await fetch(profile.baseUrl.replace(/\/$/, '') + '/models', {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      return {
        models: [],
        error: 'This endpoint does not expose a model catalog. Enter a model ID manually.',
      };
    const payload = z
      .object({ data: z.array(z.object({ id: z.string() })) })
      .parse(await response.json());
    return { models: payload.data.map((m) => m.id).sort() };
  });
  server.post('/api/test-model', async (request) => {
    const { profileId } = z.object({ profileId: z.string() }).parse(request.body),
      profile = store.settings().profiles.find((p) => p.id === profileId);
    if (!profile) throw new UserError('Unknown model connection');
    if (profile.kind === 'decision') {
      await decideTrigger(store, profile, [], [], 0);
      return { ok: true };
    }
    const result = z
      .object({ handoff: z.string() })
      .parse(
        await callModel(
          store,
          profile,
          'Connection test. Return {"handoff":"Connection works"}. Do not use tools.',
          'handoff-schema.json',
          'connection test',
        ),
      );
    return { ok: Boolean(result.handoff) };
  });
  let handoffRunning = false;
  server.post('/api/handoff', async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.body);
    const snapshot = store.snapshot(),
      task = snapshot.tasks.find((t) => t.id === id);
    if (!task) throw new UserError('Task not found');
    if (handoffRunning)
      return reply.code(409).send({ error: 'A handoff is already being prepared' });
    const settings = store.settings(),
      profile = settings.profiles.find((p) => p.id === settings.activeProfileId);
    if (!profile) throw new UserError('Unknown model connection');
    handoffRunning = true;
    try {
      const sources = snapshot.messages.filter((m) => task.source_ids.includes(m.id));
      const result = z
        .object({ handoff: z.string().min(1).max(100000) })
        .parse(
          await callModel(
            store,
            profile,
            (await prompt('handoff')) +
              JSON.stringify({ task: TaskSchema.parse(task), source_messages: sources }),
            'handoff-schema.json',
            'task handoff',
          ),
        );
      return { filename: `chat2tasks-${task.id.slice(0, 8)}.md`, content: result.handoff };
    } finally {
      handoffRunning = false;
    }
  });
}
