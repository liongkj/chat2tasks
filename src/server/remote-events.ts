import { io, type Socket } from 'socket.io-client';
import { z } from 'zod';
import { Store } from './store.js';
import { Sync } from './sync.js';
import { Webhooks } from './webhooks.js';

const EVENTS = [
  'message.received',
  'message.sent',
  'message.edited',
  'message.revoked',
  'session.status',
];
const Frame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), payload: z.unknown() }),
  z.object({ type: z.literal('subscribed'), sessionId: z.string() }),
  z.object({ type: z.literal('error') }),
]);

export class RemoteEvents {
  private socket?: Socket;
  private sessions = '';
  private stopped = true;
  constructor(
    readonly store: Store,
    readonly webhooks: Webhooks,
    readonly sync: Sync,
  ) {}
  start() {
    this.stopped = false;
    const url = this.store.settings().openwaUrl;
    const key = this.store.secret('openwa');
    if (!url || !key) return;
    const base = new URL(url);
    this.socket = io(base.origin + '/events', {
      path: base.pathname.replace(/\/$/, '') + '/socket.io',
      auth: { apiKey: key },
      autoConnect: false,
    });
    this.socket.on('connect', () => {
      if (this.stopped) return;
      for (const sessionId of this.activeSessions())
        this.socket?.emit('message', { type: 'subscribe', sessionId, events: EVENTS });
    });
    this.socket.on('message', (raw: unknown) => {
      if (this.stopped) return;
      const result = Frame.safeParse(raw);
      if (!result.success) return;
      const frame = result.data;
      if (frame.type === 'event') {
        try {
          this.webhooks.receiveRemote(frame.payload);
        } catch {
          /* Ignore malformed remote events. */
        }
      } else if (frame.type === 'subscribed') {
        this.store.status({ error: null });
        for (const chat of this.store
          .settings()
          .chats.filter((item) => item.enabled && item.sessionId === frame.sessionId))
          this.store.queueChat(chat.id, 0, true, false);
        this.sync.notify();
      } else {
        this.store.status({
          error:
            'Could not subscribe to WhatsApp updates. Check the server key and session access.',
        });
      }
    });
    this.socket.on('connect_error', () => {
      if (this.stopped) return;
      this.store.status({
        error: 'Could not connect to the remote WhatsApp server. Check its address and key.',
      });
    });
    this.socket.on('disconnect', (reason) => {
      if (this.stopped) return;
      if (reason !== 'io client disconnect')
        this.store.status({ error: 'Reconnecting to the remote WhatsApp server…' });
    });
    this.sessions = JSON.stringify(this.activeSessions());
    this.socket.connect();
  }
  private activeSessions() {
    return [
      ...new Set(
        this.store
          .settings()
          .chats.filter((chat) => chat.enabled)
          .map((chat) => chat.sessionId),
      ),
    ].sort();
  }
  reconfigure() {
    const sessions = JSON.stringify(this.activeSessions());
    if (sessions !== this.sessions && this.socket) {
      this.sessions = sessions;
      this.socket.disconnect().connect();
    }
  }
  stop() {
    this.stopped = true;
    this.socket?.disconnect();
    this.socket = undefined;
  }
}
