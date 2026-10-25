import { readFile } from 'node:fs/promises';
import { callModel } from './ai.js';
import { Threads } from './threads.js';
import { ThreadPlanSchema } from '../shared/threads.js';

export class Threading {
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private running = false;
  private waiting: ReturnType<typeof setTimeout> | undefined;
  private job: Promise<void> | undefined;
  constructor(
    readonly threads: Threads,
    readonly enabled: boolean,
    readonly busy: () => boolean,
  ) {}
  start() {
    if (this.threads.status().kind !== 'error') this.threads.status({ kind: 'idle' });
    this.timer = setInterval(() => {
      const store = this.threads.store;
      if (store.metaValue('threads_enabled') && store.settings().trigger.mode === 'automatic')
        this.request(false);
    }, 15000);
    this.timer.unref();
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.waiting);
    return this.job;
  }
  private pending() {
    const active = new Set(
      this.threads.store
        .settings()
        .chats.filter((c) => c.enabled)
        .map((c) => c.id),
    );
    return this.threads.pending().filter((m) => active.has(m.conversationId));
  }
  enable() {
    if (!this.threads.store.metaValue('threads_enabled')) return this.request();
    if (this.threads.store.settings().trigger.mode === 'automatic') return this.request(false);
  }
  request(manual = true) {
    if (!this.enabled) return;
    if (!this.threads.store.metaValue('threads_enabled'))
      this.threads.store.setMeta('threads_enabled', true);
    if (this.running || this.stopped) return;
    if (!manual && this.threads.status().kind === 'error') return;
    if (!this.pending().length) {
      if (this.threads.status().kind !== 'idle') this.threads.status({ kind: 'idle' });
      return;
    }
    if (this.busy()) {
      this.threads.status({ kind: 'queued' });
      if (!this.waiting)
        this.waiting = setTimeout(() => {
          this.waiting = undefined;
          this.request(manual);
        }, 2000);
      return;
    }
    clearTimeout(this.waiting);
    this.waiting = undefined;
    this.job = this.run();
    return this.job;
  }
  private async run() {
    this.running = true;
    const store = this.threads.store;
    try {
      for (let pass = 0; pass < 20 && !this.stopped; pass++) {
        const profile = store
          .settings()
          .profiles.find((p) => p.id === store.settings().activeProfileId);
        if (!profile) throw new Error('Choose a model connection in Settings.');
        const pending = this.pending();
        if (!pending.length) break;
        const batch = pending.slice(0, 80);
        this.threads.status({ kind: 'running', remaining: pending.length });
        const snapshot = this.threads.snapshot();
        const active = new Set(snapshot.chats.filter((c) => c.enabled).map((c) => c.id));
        const context = snapshot.threads
          .filter((t) =>
            snapshot.messages.some((m) => m.threadId === t.id && active.has(m.conversationId)),
          )
          .slice(0, 200)
          .map((t) => ({
            id: t.id,
            title: t.title,
            recentMessages: snapshot.messages
              .filter((m) => m.threadId === t.id && active.has(m.conversationId))
              .slice(-2)
              .map((m) => ({
                conversationId: m.conversationId,
                body: m.body.slice(0, 600),
                timestamp: m.timestamp,
              })),
          }));
        const prompt = await readFile('prompts/threads.txt', 'utf8');
        const plan = ThreadPlanSchema.parse(
          await callModel(
            store,
            profile,
            prompt +
              '\n' +
              JSON.stringify({
                CHATS: snapshot.chats
                  .filter((c) => c.enabled)
                  .map(({ id, name }) => ({ id, name })),
                EXISTING_THREADS: context,
                MESSAGES_TO_GROUP: batch.map((m) => ({
                  id: m.id,
                  conversationId: m.conversationId,
                  timestamp: m.timestamp,
                  body: m.body.slice(0, 6000),
                  bodyTruncated: m.body.length > 6000,
                  type: m.type,
                  entity_link: m.entity_link,
                  reply_to_id: m.reply_to_id,
                  reply_to_wa_id: m.reply_to_wa_id,
                  reply_quote: m.reply_quote?.slice(0, 3000),
                  image_reading: m.image_reading,
                })),
              }),
            'threads-schema.json',
            'conversation threading',
          ),
        );
        if (this.stopped) return;
        this.threads.apply(plan, batch);
      }
      if (!this.stopped) this.threads.status({ kind: 'idle' });
    } catch {
      if (!this.stopped)
        this.threads.status({
          kind: 'error',
          message:
            'Could not organise threads. Check your model connection and try again. Your original messages are safe.',
        });
    } finally {
      this.running = false;
    }
  }
}
