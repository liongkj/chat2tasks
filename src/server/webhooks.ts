import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Store, hash, now } from './store.js';
import { OpenWA } from './openwa.js';
import { Sync } from './sync.js';
import { MessageSchema } from '../shared/schema.js';

const EventSchema = z.object({
  event: z.string(),
  sessionId: z.string(),
  idempotencyKey: z.string().optional(),
  timestamp: z.string().optional(),
  data: z
    .object({
      id: z.string().optional(),
      messageId: z.string().optional(),
      chatId: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      body: z.string().optional(),
      type: z.string().optional(),
      timestamp: z.number().optional(),
      media: z.object({ mimetype: z.string().optional() }).optional(),
      quotedMessage: z
        .object({ id: z.string().optional(), body: z.string().optional() })
        .optional(),
    })
    .default({}),
});
const HookSchema = z.object({ id: z.string(), url: z.string() });
const EVENTS = [
  'message.received',
  'message.sent',
  'message.edited',
  'message.revoked',
  'session.status',
];

export class Webhooks {
  constructor(
    readonly store: Store,
    readonly openwa: OpenWA,
    readonly sync: Sync,
  ) {}
  receive(raw: Buffer, signature: string, eventHeader?: string, idempotencyHeader?: string) {
    const expected = Buffer.from(
      'sha256=' + createHmac('sha256', this.store.webhookSecret()).update(raw).digest('hex'),
    );
    const actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error('Invalid webhook signature');
    const event = EventSchema.parse(JSON.parse(raw.toString('utf8')));
    if (eventHeader && eventHeader !== event.event)
      throw new Error('Webhook event header mismatch');
    if (idempotencyHeader && event.idempotencyKey && idempotencyHeader !== event.idempotencyKey)
      throw new Error('Webhook identity mismatch');
    return this.acceptEvent(event, raw, idempotencyHeader);
  }
  receiveRemote(payload: unknown) {
    const event = EventSchema.parse(payload);
    return this.acceptEvent(event, Buffer.from(JSON.stringify(event)));
  }
  private acceptEvent(event: z.infer<typeof EventSchema>, raw: Buffer, idempotencyHeader?: string) {
    const key = hash([
      event.sessionId,
      event.event,
      event.idempotencyKey ?? idempotencyHeader ?? hash(raw.toString('utf8')),
    ]);
    const result = this.store.transaction(() => {
      if (this.store.db.prepare('SELECT id FROM webhook_events WHERE id=?').get(key))
        return { accepted: true, duplicate: true, ignored: false };
      this.store.db.prepare('INSERT INTO webhook_events VALUES(?,?)').run(key, now());
      this.store.status({ last_webhook: now() });
      const settings = this.store.settings(),
        active = settings.chats.filter((c) => c.enabled && c.sessionId === event.sessionId);
      if (event.event === 'session.status') {
        for (const chat of active) this.store.queueChat(chat.id, 0, true);
        return { accepted: true, duplicate: false, ignored: !active.length };
      }
      if (!EVENTS.includes(event.event)) return { accepted: true, duplicate: false, ignored: true };
      const mid = event.data.messageId ?? event.data.id;
      const prior = mid
        ? this.store
            .messages()
            .filter(
              (m) =>
                m.sessionId === event.sessionId &&
                (m.waMessageId === mid ||
                  m.openwaId === mid ||
                  m.id === mid ||
                  m.waMessageId?.split('_').at(-1) === mid),
            )
        : [];
      const chatId =
        event.data.chatId ??
        (event.event === 'message.sent' ? event.data.to : event.data.from) ??
        (prior.length === 1 ? prior[0]?.chatId : undefined);
      const chat = active.find((c) => c.chatId === chatId);
      if (!chat) return { accepted: true, duplicate: false, ignored: true };
      if ((event.event === 'message.received' || event.event === 'message.sent') && mid) {
        const previous = prior.find((m) => m.chatId === chat.chatId);
        const quoteId = event.data.quotedMessage?.id;
        const quoted = quoteId
          ? this.store
              .messages()
              .filter(
                (m) =>
                  m.sessionId === chat.sessionId &&
                  m.chatId === chat.chatId &&
                  (m.waMessageId === quoteId ||
                    m.id === quoteId ||
                    m.waMessageId?.split('_').at(-1) === quoteId),
              )
          : [];
        const message = MessageSchema.parse({
          ...previous,
          id: previous?.id ?? hash([chat.sessionId, chat.chatId, mid]),
          sessionId: chat.sessionId,
          chatId: chat.chatId,
          waMessageId: mid,
          body: event.data.body ?? '',
          type: event.data.type ?? 'text',
          timestamp: event.data.timestamp ?? now(),
          direction: event.event === 'message.sent' ? 'outgoing' : 'incoming',
          mediaMimetype: event.data.media?.mimetype ?? previous?.mediaMimetype,
          reply_to_wa_id: event.data.quotedMessage?.id,
          reply_to_id: quoted.length === 1 ? quoted[0]?.id : previous?.reply_to_id,
          reply_quote: event.data.quotedMessage?.body,
        });
        this.store.upsertMessage(message);
      }
      if (event.event === 'message.edited' || event.event === 'message.revoked') {
        const message = prior.find((m) => m.chatId === chat.chatId);
        if (message) {
          const updated =
            event.event === 'message.revoked'
              ? { ...message, type: 'revoked', body: '[Message deleted]', image_digest: null }
              : { ...message, body: event.data.body ?? message.body };
          this.store.upsertMessage(updated);
        }
      }
      if (settings.trigger.mode === 'automatic')
        this.store.queueChat(chat.id, settings.quietSeconds, false);
      this.store.status({
        phase:
          settings.trigger.mode === 'automatic'
            ? 'Messages saved · waiting for a quiet moment'
            : 'Messages saved · ready for Run now',
        debouncing: settings.trigger.mode === 'automatic',
        pending: this.store.pending(
          this.store
            .messages()
            .filter((m) => m.sessionId === chat.sessionId && m.chatId === chat.chatId),
        ).length,
      });
      return { accepted: true, duplicate: false, ignored: false };
    });
    this.sync.notify();
    return result;
  }
  async connect(onlySessions?: string[]) {
    const settings = this.store.settings();
    if (!settings.webhookUrl)
      throw new Error('Enter the webhook callback URL reachable from OpenWA');
    if (new URL(settings.webhookUrl).pathname !== '/api/webhooks/openwa')
      throw new Error('The callback URL must end with /api/webhooks/openwa');
    const configured = new Set(settings.chats.map((c) => c.sessionId));
    const sessions = onlySessions ?? [...configured];
    if (sessions.some((session) => !configured.has(session)))
      throw new Error('Add a conversation before connecting its webhooks');
    if (!sessions.length) throw new Error('Add a conversation before connecting its webhooks');
    const registered = z
      .record(z.string(), z.string())
      .parse(this.store.metaValue('managed_webhooks') ?? {});
    for (const session of sessions) {
      const route = `/api/sessions/${encodeURIComponent(session)}/webhooks`;
      const existing = z
        .array(HookSchema)
        .parse(await (await this.openwa.request(route)).json())
        .find((h) => h.url === settings.webhookUrl || h.id === registered[session]);
      const payload = {
        url: settings.webhookUrl,
        events: EVENTS,
        secret: this.store.webhookSecret(),
        retryCount: 5,
      };
      const hook = HookSchema.parse(
        await (
          await this.openwa.request(
            existing ? route + '/' + encodeURIComponent(existing.id) : route,
            existing ? 'PUT' : 'POST',
            existing ? { ...payload, active: true } : payload,
          )
        ).json(),
      );
      registered[session] = hook.id;
      this.store.setMeta('managed_webhooks', registered);
      const result = z
        .object({ success: z.boolean() })
        .parse(
          await (
            await this.openwa.request(
              route + '/' + encodeURIComponent(hook.id) + '/test',
              'POST',
              {},
            )
          ).json(),
        );
      if (!result.success)
        throw new Error(
          'OpenWA could not deliver its signed test. Check the callback URL, Docker network, and SSRF host allowlist.',
        );
    }
    this.store.setMeta('registered_webhook_url', settings.webhookUrl);
    return this.store.publicSettings();
  }
}
