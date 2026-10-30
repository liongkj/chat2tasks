import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Store, TaskTriageError } from './store.js';
import { OpenWA } from './openwa.js';
import { Sync, prompt } from './sync.js';
import { callModel } from './ai.js';
import {
  ItemKindSchema,
  SettingsUpdateSchema,
  TaskSchema,
  TaskMergeSchema,
} from '../shared/schema.js';
import { seedDemo } from './demo.js';
import { Webhooks } from './webhooks.js';
import { decideTrigger } from './decisions.js';
import { Companion, CompanionError, registerCompanion } from './companion.js';
import { registerMcp } from './mcp.js';
import { Threads, ThreadError } from './threads.js';
import { Threading } from './threading.js';
import { registerThreadRoutes } from './thread-routes.js';
import { seedDemoThreads } from './thread-demo.js';

const port = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .parse(process.env.PORT ?? 2786);
const store = new Store(resolve(process.env.DATA_DIR ?? 'data'));
const demo = process.env.DEMO === 'true';
const syncEnabled = !demo && process.env.SYNC_DISABLED !== 'true';
if (demo) seedDemo(store);
const openwa = new OpenWA(store),
  sync = new Sync(store, openwa);
const threads = new Threads(store);
if (demo) seedDemoThreads(threads);
const organiser = new Threading(
  threads,
  syncEnabled,
  () => sync.running || store.status().debouncing,
);
const webhooks = new Webhooks(store, openwa, sync);
const server = Fastify({
  logger: { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] },
  bodyLimit: 2_000_000,
  disableRequestLogging: true,
});
const origins = new Set([
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
  ...(process.env.NODE_ENV !== 'production'
    ? ['http://127.0.0.1:5173', 'http://localhost:5173']
    : []),
  ...(process.env.PUBLIC_ORIGIN ? [new URL(process.env.PUBLIC_ORIGIN).origin] : []),
]);
const allowedHosts = new Set([...origins].map((origin) => new URL(origin).host));
if (
  process.env.PUBLIC_ORIGIN &&
  !['localhost', '127.0.0.1'].includes(new URL(process.env.PUBLIC_ORIGIN).hostname) &&
  !process.env.APP_PASSWORD &&
  process.env.TRUST_PROXY_AUTH !== 'true'
)
  throw new Error(
    'Set APP_PASSWORD or TRUST_PROXY_AUTH=true behind an authenticated proxy before exposing a public origin.',
  );

server.addHook('onRequest', async (request, reply) => {
  reply.headers({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  if (request.url === '/api/webhooks/openwa') return;
  if (!allowedHosts.has(request.headers.host ?? ''))
    return reply
      .code(403)
      .send({ error: 'Host is not allowed. Set PUBLIC_ORIGIN for your reverse proxy.' });
  if (request.url === '/api/health') return;
  if (request.url.startsWith('/api/companion/')) return;
  if (request.routeOptions.url === '/mcp') return;
  const password = process.env.APP_PASSWORD;
  if (password) {
    const expected = Buffer.from(`Basic ${Buffer.from(`admin:${password}`).toString('base64')}`),
      actual = Buffer.from(request.headers.authorization ?? '');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      return reply
        .header('WWW-Authenticate', 'Basic realm="Chat2Tasks", charset="UTF-8"')
        .code(401)
        .send({ error: 'Sign in to your workspace' });
  }
  if (
    ['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method) &&
    (!request.headers.origin ||
      !origins.has(request.headers.origin) ||
      !request.headers['content-type']?.startsWith('application/json'))
  )
    return reply.code(403).send({ error: 'Invalid request origin or content type' });
});
server.setErrorHandler((error, request, reply) => {
  if (error instanceof ThreadError)
    return reply.code(error.statusCode).send({ error: error.message });
  if (error instanceof TaskTriageError)
    return reply.code(error.statusCode).send({ error: error.message });
  if (error instanceof CompanionError)
    return reply.code(error.statusCode).send({ error: error.message });
  if (error instanceof z.ZodError)
    return reply.code(400).send({ error: error.issues.map((x) => x.message).join('. ') });
  // Provider response bodies and supplied credentials never enter logs or API errors.
  const safe =
    error instanceof Error &&
    /^(Task not found|Question already|Choose a task|Unknown credential|Completion|A task|Cannot update|Unknown task|Enter the webhook|The callback|Add a conversation|OpenWA could not|OpenWA returned)/.test(
      error.message,
    );
  if (safe) return reply.code(400).send({ error: error.message });
  request.log.error({ event: 'request_failed', route: request.routeOptions.url }, 'Request failed');
  return reply.code(503).send({
    error: 'The request could not be completed. Check your connection settings and retry.',
  });
});
server.get('/api/health', () => ({ ok: true }));
await registerCompanion(
  server,
  new Companion(store, sync, syncEnabled),
  threads,
  organiser,
  openwa,
);
registerThreadRoutes(server, '/api', threads, organiser, openwa);
await registerMcp(server, store, { token: process.env.MCP_TOKEN, origins });
await server.register(async (receiver) => {
  receiver.removeContentTypeParser('application/json');
  receiver.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: 20_000_000 },
    (_request, body, done) => done(null, body),
  );
  receiver.post('/api/webhooks/openwa', { bodyLimit: 20_000_000 }, async (request, reply) => {
    if (!syncEnabled) return reply.code(503).send({ error: 'Webhook processing is disabled' });
    if (!Buffer.isBuffer(request.body))
      return reply.code(400).send({ error: 'Expected a JSON webhook body' });
    try {
      return webhooks.receive(
        request.body,
        z.string().parse(request.headers['x-openwa-signature']),
        z.string().optional().parse(request.headers['x-openwa-event']),
        z.string().optional().parse(request.headers['x-openwa-idempotency-key']),
      );
    } catch (error) {
      return reply
        .code(error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 401)
        .send({ error: 'Invalid webhook signature or payload' });
    }
  });
});
server.get('/api/state', () => store.snapshot());
server.get('/api/tasks/:id', (request) =>
  store.taskEvidence(z.object({ id: z.string() }).parse(request.params).id),
);
server.post('/api/tasks/merge', (request) => store.mergeTasks(TaskMergeSchema.parse(request.body)));
server.post('/api/tasks/kind', (request) => {
  const value = z.object({ id: z.string(), kind: ItemKindSchema }).parse(request.body);
  store.setTaskKind(value.id, value.kind);
  return { ok: true };
});
server.get('/api/settings', () => store.publicSettings());
server.post('/api/webhooks/connect', async () => webhooks.connect());
server.post('/api/settings', async (request) => {
  const update = SettingsUpdateSchema.parse(request.body);
  store.saveSettings(update);
  if (syncEnabled) sync.reconfigure();
  return store.publicSettings();
});
server.post('/api/tick', async (request) => {
  const value = z.object({ id: z.string(), done: z.boolean() }).parse(request.body);
  store.transaction(() => store.tick(value.id, value.done));
  return { ok: true };
});
server.post('/api/remark', async (request) => {
  const value = z.object({ id: z.string(), remark: z.string().max(4000) }).parse(request.body);
  store.remark(value.id, value.remark);
  return { ok: true };
});
server.post('/api/resolve', async (request) => {
  const value = z.object({ id: z.string(), task_id: z.string().nullable() }).parse(request.body);
  store.resolve(value.id, value.task_id);
  return { ok: true };
});
server.post('/api/sync', async () => {
  if (syncEnabled) sync.wake();
  return { ok: true };
});
server.get('/api/export', () => store.snapshot());
server.post('/api/import', async (request) => {
  const { tasks } = z
    .object({ tasks: z.array(z.object({ id: z.string(), done: z.boolean() })).max(10000) })
    .parse(request.body);
  const valid = new Set(store.snapshot().tasks.map((t) => t.id));
  store.transaction(() => {
    for (const t of tasks) {
      if (!valid.has(t.id)) throw new Error('Task not found');
      store.tick(t.id, t.done);
    }
  });
  return { ok: true };
});
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
server.get('/api/media', async (request, reply) => {
  const { id } = z.object({ id: z.string() }).parse(request.query),
    message = store.messages().find((m) => m.id === id);
  if (!message) return reply.code(404).send({ error: 'Image not found' });
  const image = await openwa.media(message);
  return image
    ? reply.type(image.mime).send(image.bytes)
    : reply.code(404).send({ error: 'OpenWA no longer serves this image' });
});
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
  if (!profile) throw new Error('Unknown model connection');
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
  if (!task) throw new Error('Task not found');
  if (handoffRunning) return reply.code(409).send({ error: 'A handoff is already being prepared' });
  const settings = store.settings(),
    profile = settings.profiles.find((p) => p.id === settings.activeProfileId);
  if (!profile) throw new Error('Unknown model connection');
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
await server.register(staticFiles, { root: resolve('dist/client'), wildcard: false });
await server.listen({ port, host: process.env.BIND_HOST ?? '127.0.0.1' });
if (syncEnabled) sync.start();
organiser.start();
async function shutdown() {
  const threadJob = organiser.stop();
  sync.stop();
  await server.close();
  await threadJob;
  store.close();
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
