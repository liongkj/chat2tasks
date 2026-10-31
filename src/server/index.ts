import Fastify, { type FastifyRequest } from 'fastify';
import staticFiles from '@fastify/static';
import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { acquireLock } from '../../desktop/process-lock.mjs';
import type { DesktopSharing } from '../shared/desktop-sharing.js';
import { Store, TaskTriageError } from './store.js';
import { LocalSearch } from './search.js';
import { prepareSearchMedia } from './search-media.js';
import { SearchRequestSchema, SearchSettingsSchema } from '../shared/search.js';
import { OpenWA } from './openwa.js';
import { Sync, prompt } from './sync.js';
import { callModel } from './ai.js';
import {
  ItemKindSchema,
  GtdSchema,
  WaitInputSchema,
  WaitStateSchema,
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
import { exportWorkspace } from './workspace-transfer.js';
import {
  configureDesktopGateway,
  registerDesktop,
  stopManagedGateway,
  waitForDesktopGateway,
} from './desktop.js';
import { RemoteEvents } from './remote-events.js';
import { WorkspaceOwnership } from './workspace-ownership.js';
import { MoveGate } from './move-gate.js';
import { registerServerMoveRoutes } from './server-move-routes.js';
import {
  desktopSessionCookie,
  desktopSignInCsp,
  desktopSignInPage,
  validDesktopSession,
} from './desktop-session.js';

const port = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .parse(process.env.PORT ?? 2786);
const managedServer = process.env.WAWA_MANAGED_SERVER === 'true';
const desktop = process.env.CHAT2TASKS_DESKTOP === 'true' || managedServer;
const dataDirectory = resolve(process.env.DATA_DIR ?? 'data');
const workspaceLock = desktop
  ? acquireLock(join(dirname(dataDirectory), 'workspace-server-control'))
  : undefined;
const moveEnabled = desktop && process.env.CHAT2TASKS_SERVER_MOVE === 'true';
const moveRecovery = moveEnabled && process.env.CHAT2TASKS_MOVE_RECOVERY === 'true';
const ownership = desktop
  ? WorkspaceOwnership.open(join(dataDirectory, '.ownership'), 'server')
  : undefined;
if (ownership) {
  if (moveRecovery) {
    if (!['preparing', 'fenced'].includes(ownership.role()))
      throw new Error('This workspace does not need move recovery.');
  } else ownership.assertCanRun();
}
const store = new Store(dataDirectory);
const openwa = new OpenWA(store);
const localSearch = new LocalSearch(store.db, () => store.snapshot(), undefined, undefined, {
  workspaceUrl: process.env.LOCAL_SEARCH_MEDIA_OLLAMA_URL,
  load: (message) => openwa.attachment(message),
  prepare: prepareSearchMedia,
});
const configuredDesktopSharing: DesktopSharing = desktop
  ? store.desktopSharing()
  : { kind: 'disabled' };
const sharingUnavailable =
  configuredDesktopSharing.kind === 'enabled' &&
  process.env.CHAT2TASKS_SHARING_UNAVAILABLE === 'port_in_use';
const recoveryOnly = sharingUnavailable || moveRecovery;
const desktopSharing: DesktopSharing = sharingUnavailable
  ? { kind: 'disabled' }
  : configuredDesktopSharing;
const sharingPassword =
  desktopSharing.kind === 'enabled' ? store.secret('desktop-sharing-password') : '';
const workspacePassword = sharingPassword || process.env.APP_PASSWORD || '';
if (desktopSharing.kind === 'enabled' && !workspacePassword)
  throw new Error('The desktop sharing password is missing. Configure sharing again.');
const remoteGateway = desktop && process.env.DESKTOP_GATEWAY_MODE === 'remote';
if (desktop && !recoveryOnly) await configureDesktopGateway(store);
const demo = process.env.DEMO === 'true';
const syncEnabled = !demo && !recoveryOnly && process.env.SYNC_DISABLED !== 'true';
if (demo) seedDemo(store);
const sync = new Sync(store, openwa);
const threads = new Threads(store);
if (demo) seedDemoThreads(threads);
const organiser = new Threading(
  threads,
  syncEnabled,
  () => sync.running || store.status().debouncing,
);
const webhooks = new Webhooks(store, openwa, sync);
const remoteEvents =
  remoteGateway && syncEnabled ? new RemoteEvents(store, webhooks, sync) : undefined;
const server = Fastify({
  logger: { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] },
  bodyLimit: 2_000_000,
  disableRequestLogging: true,
});
const moveGate = moveEnabled ? new MoveGate(server) : undefined;
const startupAbort = new AbortController();
let starting: Promise<void> = Promise.resolve();
const additionalOrigins = (process.env.ADDITIONAL_ORIGINS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error(
        'ADDITIONAL_ORIGINS must contain exact HTTP(S) origins without paths or credentials.',
      );
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      if (url.protocol !== 'https:') throw new Error('Remote workspace addresses must use HTTPS.');
      if (!workspacePassword)
        throw new Error('Set APP_PASSWORD before adding a remote workspace address.');
    }
    return url.origin;
  });
const origins = new Set([
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
  ...(process.env.NODE_ENV !== 'production'
    ? ['http://127.0.0.1:5173', 'http://localhost:5173']
    : []),
  ...(process.env.PUBLIC_ORIGIN ? [new URL(process.env.PUBLIC_ORIGIN).origin] : []),
  ...(desktopSharing.kind === 'enabled' ? [desktopSharing.origin] : []),
  ...additionalOrigins,
]);
const allowedHosts = new Set([...origins].map((origin) => new URL(origin).host));
const tauriOrigin = process.env.CHAT2TASKS_TAURI_ORIGIN;
const tauriToken = process.env.CHAT2TASKS_TAURI_TOKEN;
if (
  (tauriOrigin || tauriToken) &&
  (!tauriOrigin ||
    !['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'].includes(
      tauriOrigin,
    ) ||
    !tauriToken ||
    !/^[a-f0-9]{64}$/.test(tauriToken))
)
  throw new Error('Invalid Tauri workspace configuration.');
if (tauriOrigin) origins.add(tauriOrigin);
function localTauriSession(request: FastifyRequest) {
  if (!tauriOrigin || !tauriToken || request.headers.origin !== tauriOrigin) return false;
  const expected = Buffer.from(tauriToken);
  const supplied = Buffer.from(String(request.headers['x-chat2tasks-session'] ?? ''));
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
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
  if (recoveryOnly && request.routeOptions.url === '/mcp')
    return reply.code(503).send({ error: 'The workspace is in recovery.' });
  if (
    recoveryOnly &&
    request.url.startsWith('/api/') &&
    !(request.method === 'OPTIONS' && request.headers.origin === tauriOrigin)
  ) {
    const readable = [
      '/api/health',
      '/api/state',
      '/api/settings',
      '/api/preferences',
      '/api/desktop/status',
      '/api/desktop/sharing',
    ].includes(request.url);
    const permitted = moveRecovery
      ? (request.method === 'GET' && request.url === '/api/health') ||
        request.url.startsWith('/api/workspace/move/')
      : (request.method === 'GET' && readable) ||
        (request.method === 'POST' && request.url === '/api/desktop/sharing');
    if (!permitted) return reply.code(503).send({ error: 'The workspace is in recovery.' });
  }
  if (request.url === '/api/webhooks/openwa') return;
  if (!allowedHosts.has(request.headers.host ?? ''))
    return reply
      .code(403)
      .send({ error: 'Host is not allowed. Set PUBLIC_ORIGIN for your reverse proxy.' });
  if (request.url === '/api/health') return;
  if (request.url === '/desktop-sign-in' && ['GET', 'POST'].includes(request.method)) {
    // WebKit sends a null Origin for form posts under no-referrer, so retain the
    // origin only for this same-origin sign-in page.
    reply.header('Referrer-Policy', 'same-origin');
    return;
  }
  if (request.url.startsWith('/api/companion/')) return;
  if (request.routeOptions.url === '/mcp') return;
  if (tauriOrigin && request.headers.origin === tauriOrigin) {
    reply.headers({
      'Access-Control-Allow-Origin': tauriOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Chat2Tasks-Session',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    });
    if (request.method === 'OPTIONS') return reply.code(204).send();
  }
  const localSession = localTauriSession(request);
  const sharedHost =
    desktopSharing.kind === 'enabled' &&
    request.headers.host === new URL(desktopSharing.origin).host;
  if (tauriToken && request.url.startsWith('/api/') && !localSession && !sharedHost)
    return reply.code(403).send({ error: 'The workspace session is not authorized.' });
  if (workspacePassword && !localSession) {
    const expected = Buffer.from(
        `Basic ${Buffer.from(`admin:${workspacePassword}`).toString('base64')}`,
      ),
      actual = Buffer.from(request.headers.authorization ?? '');
    if (
      (expected.length !== actual.length || !timingSafeEqual(expected, actual)) &&
      !validDesktopSession(request.headers.cookie ?? '', store.key, workspacePassword)
    )
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
    /^(Task not found|Question already|Choose a task|Unknown credential|Completion|A task|Cannot update|Unknown task|Enter the webhook|Enter the remote WhatsApp|The callback|Add a conversation|OpenWA could not|OpenWA returned|Connect WhatsApp|Sign in to Codex|Choose conversations|Conversation not found|A conversation needs)/.test(
      error.message,
    );
  if (safe) return reply.code(400).send({ error: error.message });
  request.log.error({ event: 'request_failed', route: request.routeOptions.url }, 'Request failed');
  return reply.code(503).send({
    error: 'The request could not be completed. Check your connection settings and retry.',
  });
});
server.get('/api/health', () => ({ ok: true }));
server.get('/api/setup-mode', () => ({ managedServer }));
server.get('/api/search/settings', () => localSearch.settings());
server.post('/api/search/settings', (request) =>
  localSearch.saveSettings(SearchSettingsSchema.parse(request.body)),
);
server.post('/api/search', async (request) => {
  const { query, retry } = SearchRequestSchema.parse(request.body);
  return localSearch.find(query, retry);
});
server.addContentTypeParser(
  'application/x-www-form-urlencoded',
  { parseAs: 'string', bodyLimit: 4096 },
  (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  },
);
server.get('/desktop-sign-in', (request, reply) => {
  if (
    !workspacePassword ||
    validDesktopSession(request.headers.cookie ?? '', store.key, workspacePassword)
  )
    return reply.code(303).header('Location', '/').send();
  return reply
    .header('Content-Security-Policy', desktopSignInCsp)
    .type('text/html')
    .send(desktopSignInPage());
});
server.post('/desktop-sign-in', (request, reply) => {
  const origin = request.headers.origin;
  if (!origin || !origins.has(origin) || new URL(origin).host !== request.headers.host)
    return reply.code(403).send({ error: 'Invalid request origin' });
  const password = workspacePassword;
  if (!password) return reply.code(303).header('Location', '/').send();
  const input = z.object({ password: z.string().max(1024) }).safeParse(request.body);
  const expected = Buffer.from(password);
  const actual = Buffer.from(input.success ? input.data.password : '');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return reply
      .code(401)
      .header('Content-Security-Policy', desktopSignInCsp)
      .type('text/html')
      .send(desktopSignInPage(true));
  return reply
    .code(303)
    .header('Location', '/')
    .header('Set-Cookie', desktopSessionCookie(store.key, password, origin.startsWith('https://')))
    .send();
});
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
server.post('/api/tasks/gtd', (request) => {
  const value = z.object({ id: z.string(), gtd: GtdSchema }).parse(request.body);
  return store.setGtd(value.id, value.gtd);
});
server.post('/api/tasks/occurrence', (request) => {
  const value = z.object({ id: z.string(), date: z.iso.date() }).parse(request.body);
  return { ok: store.completeOccurrence(value.id, value.date) };
});
server.get('/api/waiting/:id', (request) =>
  store.waitEvidence(z.object({ id: z.string() }).parse(request.params).id),
);
server.post('/api/waiting', (request) => store.createWait(WaitInputSchema.parse(request.body)));
server.post('/api/waiting/state', (request) => {
  const value = z.object({ id: z.string(), state: WaitStateSchema }).parse(request.body);
  return store.setWaitState(value.id, value.state);
});
server.post('/api/waiting/confirm', (request) => {
  const value = z.object({ id: z.string() }).parse(request.body);
  return store.confirmWait(value.id);
});
server.get('/api/settings', () => store.publicSettings());
server.get('/api/preferences', () => store.preferences());
server.post('/api/preferences', (request) => store.savePreferences(request.body));
server.post('/api/sound-preferences', (request) => store.saveSoundPreferences(request.body));
server.post('/api/webhooks/connect', async () => webhooks.connect());
server.post('/api/settings', async (request) => {
  const update = SettingsUpdateSchema.parse(request.body);
  const previous = store.settings();
  if (desktop && update.settings.desktopGateway.mode === 'remote') {
    const hasKey =
      Boolean(update.secrets['remote-openwa']?.trim()) ||
      (!update.removeSecrets.includes('remote-openwa') && Boolean(store.secret('remote-openwa')));
    if (!update.settings.desktopGateway.remoteUrl || !hasKey)
      throw new Error('Enter the remote WhatsApp server address and API key.');
  }
  store.saveSettings(update);
  if (
    remoteGateway &&
    (previous.desktopGateway.remoteUrl !== update.settings.desktopGateway.remoteUrl ||
      Boolean(update.secrets['remote-openwa']?.trim()) ||
      update.removeSecrets.includes('remote-openwa'))
  )
    store.setMeta('desktop_gateway_restart_required', true);
  remoteEvents?.reconfigure();
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
server.post('/api/workspace/transfer', async (request, reply) => {
  const { passphrase } = z.object({ passphrase: z.string().min(8).max(1024) }).parse(request.body);
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
  if (!message) return reply.code(404).send({ error: 'Attachment not found' });
  const attachment = await openwa.attachment(message);
  return attachment
    ? reply.type(attachment.mime).send(attachment.bytes)
    : reply.code(404).send({ error: 'OpenWA no longer serves this attachment' });
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
if (desktop) {
  function sharingStatus() {
    const configured = store.desktopSharing();
    return {
      configured,
      active: desktopSharing,
      unavailableReason: sharingUnavailable && configured.kind === 'enabled' ? 'port_in_use' : null,
      restartRequired:
        JSON.stringify(configured) !== JSON.stringify(desktopSharing) ||
        (configured.kind === 'enabled' &&
          store.secret('desktop-sharing-password') !== sharingPassword),
    };
  }
  server.get('/api/desktop/sharing', (request, reply) => {
    if (!localTauriSession(request))
      return reply.code(403).send({ error: 'Use the server computer to change sharing.' });
    return sharingStatus();
  });
  server.post('/api/desktop/sharing', (request, reply) => {
    if (!localTauriSession(request))
      return reply.code(403).send({ error: 'Use the server computer to change sharing.' });
    store.saveDesktopSharing(request.body);
    return sharingStatus();
  });
  await registerDesktop(server, store, openwa, sync, webhooks, managedServer);
}
if (moveGate && ownership) {
  registerServerMoveRoutes(server, {
    gate: moveGate,
    ownership,
    store,
    stopBackground: async () => {
      startupAbort.abort();
      remoteEvents?.stop();
      sync.stop();
      const threadJob = organiser.stop();
      await Promise.all([moveGate.pause(), starting, threadJob]);
      await localSearch.stopAndWait();
      await sync.stopAndWait();
      if (!remoteGateway && !moveRecovery) await stopManagedGateway();
    },
    completed: async (id, targetOrigin) => {
      const directory = dirname(dataDirectory);
      const temporary = join(directory, `workspace-target.${id}.tmp`);
      await writeFile(temporary, JSON.stringify({ kind: 'remote', url: targetOrigin }), {
        mode: 0o600,
      });
      await rename(temporary, join(directory, 'workspace-target.json'));
    },
  });
}
await server.register(staticFiles, { root: resolve('dist/client'), wildcard: false });
if (desktop && !recoveryOnly) {
  sync.stop();
  store.status({ syncing: true, phase: 'Starting WhatsApp connection…', error: null });
}
await server.listen({ port, host: process.env.BIND_HOST ?? '127.0.0.1' });
async function startBackground() {
  if (recoveryOnly) return;
  if (desktop) {
    try {
      if (!remoteGateway)
        await waitForDesktopGateway(process.env.DESKTOP_OPENWA_URL ?? '', startupAbort.signal);
    } catch {
      if (!startupAbort.signal.aborted)
        store.status({
          syncing: false,
          error: 'WhatsApp could not start. Quit Chat2Tasks and try again.',
        });
      return;
    }
    if (startupAbort.signal.aborted) return;
    if (!remoteGateway && store.metaValue('desktop_setup_complete') === true) {
      const sessions = [
        ...new Set(
          store
            .settings()
            .chats.filter((chat) => chat.enabled)
            .map((chat) => chat.sessionId),
        ),
      ];
      if (sessions.length) {
        store.status({ phase: 'Connecting your conversations…' });
        try {
          await webhooks.connect(sessions);
        } catch {
          store.status({ error: 'WhatsApp could not reconnect. Open Connections to retry.' });
        }
      }
    }
    if (startupAbort.signal.aborted) return;
    store.status({ syncing: false, phase: 'Workspace ready' });
  }
  if (syncEnabled) sync.start();
  remoteEvents?.start();
  organiser.start();
}
starting = startBackground();
async function shutdown() {
  startupAbort.abort();
  const threadJob = organiser.stop();
  sync.stop();
  remoteEvents?.stop();
  await server.close();
  await starting;
  await threadJob;
  await sync.stopAndWait();
  await localSearch.stopAndWait();
  store.close();
  workspaceLock?.close();
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
