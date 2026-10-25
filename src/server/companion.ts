import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { Store, hash, now } from './store.js';
import type { Sync } from './sync.js';
import { MessageSchema } from '../shared/schema.js';
import {
  CaptureSchema,
  DeviceSchema,
  ExtensionIdSchema,
  PairRequestSchema,
} from '../shared/companion.js';

export class CompanionError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
const digest = (value: string) => hash(value);
const DeviceRow = z.object({ id: z.string(), origin: z.string(), expires: z.number() });
export class Companion {
  constructor(
    readonly store: Store,
    readonly sync: Pick<Sync, 'notify' | 'wake' | 'reconfigure'>,
    readonly enabled: boolean,
  ) {
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS companion_codes(digest TEXT PRIMARY KEY,expires REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_digest TEXT NOT NULL UNIQUE,origin TEXT NOT NULL,created REAL NOT NULL,last_used REAL,expires REAL NOT NULL,revoked REAL);
      CREATE TABLE IF NOT EXISTS companion_captures(id TEXT PRIMARY KEY,message_id TEXT NOT NULL REFERENCES messages(id),device_id TEXT NOT NULL REFERENCES companion_devices(id),digest TEXT NOT NULL);`);
  }
  createCode() {
    const raw = randomBytes(8).toString('hex').toUpperCase(),
      expiresAt = now() + 300;
    this.store.transaction(() => {
      this.store.db.exec('DELETE FROM companion_codes');
      this.store.db.prepare('INSERT INTO companion_codes VALUES(?,?)').run(digest(raw), expiresAt);
    });
    return { code: raw.match(/.{4}/g)?.join('-') ?? raw, expiresAt };
  }
  pair(code: string, name: string, extensionId: string) {
    ExtensionIdSchema.parse(extensionId);
    const token = 'c2t_' + randomBytes(32).toString('base64url'),
      deviceId = randomUUID(),
      timestamp = now(),
      expiresAt = timestamp + 90 * 86400;
    return this.store.transaction(() => {
      const row = this.store.db
        .prepare('DELETE FROM companion_codes WHERE digest=? AND expires>? RETURNING digest')
        .get(digest(code.replace(/[-\s]/g, '').toUpperCase()), timestamp);
      if (!row)
        throw new CompanionError(
          401,
          'The pairing code expired or was already used. Create a new code in your workspace.',
        );
      this.store.db
        .prepare('INSERT INTO companion_devices VALUES(?,?,?,?,?,?,?,NULL)')
        .run(
          deviceId,
          name,
          digest(token),
          'chrome-extension://' + extensionId,
          timestamp,
          null,
          expiresAt,
        );
      return { token, deviceId, expiresAt };
    });
  }
  authenticate(token: string, extensionId: string) {
    const parsed = DeviceRow.safeParse(
      this.store.db
        .prepare(
          'SELECT id,origin,expires FROM companion_devices WHERE token_digest=? AND revoked IS NULL AND expires>?',
        )
        .get(digest(token), now()),
    );
    if (!parsed.success || parsed.data.origin !== 'chrome-extension://' + extensionId)
      throw new CompanionError(
        401,
        'This connection expired or was revoked. Pair the extension again.',
      );
    this.store.db
      .prepare(
        'UPDATE companion_devices SET last_used=? WHERE id=? AND (last_used IS NULL OR last_used<?)',
      )
      .run(now(), parsed.data.id, now() - 60);
    return parsed.data.id;
  }
  devices() {
    return {
      devices: this.store.db
        .prepare(
          'SELECT id,name,created,last_used AS lastUsed,expires AS expiresAt FROM companion_devices WHERE revoked IS NULL AND expires>? ORDER BY created DESC',
        )
        .all(now())
        .map((row) => DeviceSchema.parse(row)),
    };
  }
  revoke(id: string) {
    this.store.db.prepare('UPDATE companion_devices SET revoked=? WHERE id=?').run(now(), id);
  }
  state() {
    const snapshot = this.store.snapshot(),
      chats = this.store.settings().chats;
    const sourceChats = new Map(
      snapshot.messages.map((m) => [
        m.id,
        chats.find((c) => c.sessionId === m.sessionId && c.chatId === m.chatId)?.id,
      ]),
    );
    return {
      tasks: snapshot.tasks.map((task) => ({
        ...task,
        chatIds: [
          ...new Set(
            task.source_ids.flatMap((id) => {
              const chat = sourceChats.get(id);
              return chat ? [chat] : [];
            }),
          ),
        ],
      })),
      chats: chats.map(({ id, name, enabled }) => ({ id, name, enabled })),
      status: snapshot.status,
      analysisMode: this.store.settings().trigger.mode,
      quietSeconds: this.store.settings().quietSeconds,
    };
  }
  task(id: string) {
    return this.store.taskEvidence(id);
  }
  capture(deviceId: string, input: z.infer<typeof CaptureSchema>) {
    const chat = this.store.settings().chats.find((c) => c.id === input.chatId);
    if (!chat?.enabled)
      throw new CompanionError(409, 'Activate this conversation before capturing text.');
    const key = hash([deviceId, input.id]),
      contentDigest = hash(input);
    const result = this.store.transaction(() => {
      const previous = this.store.db
        .prepare('SELECT message_id,digest FROM companion_captures WHERE id=?')
        .get(key);
      if (previous) {
        if (previous.digest !== contentDigest)
          throw new CompanionError(
            409,
            'This capture was already saved with different text. Start a new capture.',
          );
        return {
          saved: true satisfies true,
          duplicate: true,
          messageId: z.string().parse(previous.message_id),
          queued: this.enabled && this.store.settings().trigger.mode === 'automatic',
        };
      }
      const message = MessageSchema.parse({
        id: 'browser-' + randomUUID(),
        sessionId: chat.sessionId,
        chatId: chat.chatId,
        body: input.text,
        direction: 'incoming',
        type: 'text',
        timestamp: now(),
        browser_source: { url: input.url, title: input.title, capturedAt: now() },
      });
      this.store.db
        .prepare('INSERT INTO messages VALUES(?,?)')
        .run(message.id, JSON.stringify(message));
      this.store.db
        .prepare('INSERT INTO companion_captures VALUES(?,?,?,?)')
        .run(key, message.id, deviceId, contentDigest);
      const queued = this.enabled && this.store.settings().trigger.mode === 'automatic';
      if (queued) this.store.queueChat(chat.id, this.store.settings().quietSeconds, false);
      const activeChats = this.store.settings().chats.filter((item) => item.enabled);
      const messages = this.store
        .messages()
        .filter((m) =>
          activeChats.some((item) => item.sessionId === m.sessionId && item.chatId === m.chatId),
        );
      this.store.status({
        pending: this.store.pending(messages).length + this.store.pendingReplies(messages).length,
        debouncing: queued,
        phase: queued
          ? 'Browser selection saved · waiting for a quiet moment'
          : 'Browser selection saved · ready for Run now',
      });
      return { saved: true satisfies true, duplicate: false, messageId: message.id, queued };
    });
    if (this.enabled) this.sync.notify();
    return result;
  }
}

export async function registerCompanion(server: FastifyInstance, companion: Companion) {
  server.get('/api/extensions', () => companion.devices());
  server.post('/api/extensions/pairing', () => companion.createCode());
  server.post('/api/extensions/:id/revoke', (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    companion.revoke(id);
    return { ok: true };
  });
  await server.register(async (routes) => {
    const attempts = new Map<string, { count: number; until: number }>();
    routes.addHook('onRequest', async (request, reply) => {
      const origin = request.headers.origin;
      const id =
        request.method === 'OPTIONS'
          ? origin?.replace(/^chrome-extension:\/\//, '')
          : request.headers['x-chat2tasks-extension'];
      const parsed = ExtensionIdSchema.safeParse(id);
      if (!parsed.success || (origin && origin !== 'chrome-extension://' + parsed.data))
        return reply.code(403).send({ error: 'Use the paired Chat2Tasks extension.' });
      if (origin)
        reply.headers({
          'Access-Control-Allow-Origin': origin,
          Vary: 'Origin',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Chat2Tasks-Extension',
        });
      if (request.method === 'OPTIONS') return reply.code(204).send();
      if (request.url.split('?')[0] === '/api/companion/pair') {
        const prior = attempts.get(request.ip),
          current = prior && prior.until > now() ? prior : { count: 0, until: now() + 60 };
        current.count++;
        attempts.set(request.ip, current);
        for (const [key, value] of attempts) if (value.until < now()) attempts.delete(key);
        if (current.count > 10)
          return reply
            .header('Retry-After', '60')
            .code(429)
            .send({ error: 'Too many pairing attempts. Wait a minute and try again.' });
        return;
      }
      try {
        companion.authenticate(
          (request.headers.authorization ?? '').replace(/^Bearer /, ''),
          parsed.data,
        );
      } catch (error) {
        if (error instanceof CompanionError)
          return reply.code(error.statusCode).send({ error: error.message });
        throw error;
      }
    });
    routes.options('/api/companion/*', () => ({}));
    routes.post('/api/companion/pair', (request) => {
      const input = PairRequestSchema.parse(request.body),
        id = ExtensionIdSchema.parse(request.headers['x-chat2tasks-extension']);
      return companion.pair(input.code, input.name, id);
    });
    routes.get('/api/companion/state', () => companion.state());
    routes.get('/api/companion/tasks/:id', (request) =>
      companion.task(z.object({ id: z.string() }).parse(request.params).id),
    );
    routes.post('/api/companion/tick', (request) => {
      const input = z.object({ id: z.string(), done: z.boolean() }).parse(request.body);
      if (!companion.store.db.prepare('SELECT id FROM tasks WHERE id=?').get(input.id))
        throw new CompanionError(404, 'Task not found');
      companion.store.transaction(() => companion.store.tick(input.id, input.done));
      return { ok: true };
    });
    routes.post('/api/companion/note', (request) => {
      const input = z.object({ id: z.string(), remark: z.string().max(4000) }).parse(request.body);
      companion.task(input.id);
      companion.store.remark(input.id, input.remark);
      return { ok: true };
    });
    routes.post('/api/companion/activation', (request) => {
      const input = z.object({ id: z.string(), enabled: z.boolean() }).parse(request.body),
        settings = companion.store.settings();
      if (!settings.chats.some((c) => c.id === input.id))
        throw new CompanionError(404, 'Conversation not found');
      companion.store.saveSettings({
        settings: {
          ...settings,
          chats: settings.chats.map((c) =>
            c.id === input.id ? { ...c, enabled: input.enabled } : c,
          ),
        },
        secrets: {},
        removeSecrets: [],
      });
      if (companion.enabled) companion.sync.reconfigure();
      return { ok: true };
    });
    routes.post('/api/companion/run', () => {
      if (!companion.enabled)
        throw new CompanionError(409, 'Task analysis is disabled in this workspace.');
      companion.sync.wake();
      return { ok: true };
    });
    routes.post('/api/companion/disconnect', (request) => {
      const id = companion.authenticate(
        (request.headers.authorization ?? '').replace(/^Bearer /, ''),
        ExtensionIdSchema.parse(request.headers['x-chat2tasks-extension']),
      );
      companion.revoke(id);
      return { ok: true };
    });
    routes.post('/api/companion/capture', (request) => {
      const id = companion.authenticate(
        (request.headers.authorization ?? '').replace(/^Bearer /, ''),
        ExtensionIdSchema.parse(request.headers['x-chat2tasks-extension']),
      );
      return companion.capture(id, CaptureSchema.parse(request.body));
    });
  });
}
