import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  DecisionSchema,
  ImageReadingSchema,
  TaskChangeSchema,
  type Chat,
  type Profile,
} from '../shared/schema.js';
import { Store, now } from './store.js';
import { OpenWA } from './openwa.js';
import { callModel } from './ai.js';
import { decideTrigger, GateSchema } from './decisions.js';

export class Sync {
  running = false;
  timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  constructor(
    readonly store: Store,
    readonly openwa: OpenWA,
  ) {}
  active(chat: Chat) {
    return this.store
      .settings()
      .chats.some(
        (c) =>
          c.id === chat.id &&
          c.enabled &&
          c.sessionId === chat.sessionId &&
          c.chatId === chat.chatId,
      );
  }
  start() {
    this.stopped = false;
    this.reconfigure();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
  wake() {
    for (const chat of this.store.settings().chats.filter((c) => c.enabled))
      this.store.queueChat(chat.id, 0, true, true);
    this.notify();
  }
  reconfigure() {
    for (const chat of this.store.settings().chats.filter((c) => c.enabled))
      this.store.queueChat(chat.id, 0, true, false);
    this.notify();
  }
  notify() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped || this.running) return;
    const active = new Set(
      this.store
        .settings()
        .chats.filter((c) => c.enabled)
        .map((c) => c.id),
    );
    for (const job of this.store.jobs())
      if (!active.has(job.chat_id))
        this.store.db.prepare('DELETE FROM chat_jobs WHERE chat_id=?').run(job.chat_id);
    const next = this.store.jobs()[0];
    if (next)
      this.timer = setTimeout(
        () =>
          void this.run(
            this.store
              .jobs()
              .filter((job) => job.due <= now())
              .map((job) => job.chat_id),
          ),
        Math.max(0, next.due - now()) * 1000,
      );
  }
  async run(chatIds?: string[]) {
    if (this.running) return;
    this.running = true;
    let lastError: string | null = null;
    try {
      const settings = this.store.settings(),
        profile = settings.profiles.find((p) => p.id === settings.activeProfileId);
      if (!profile) throw new Error('Select a model connection in Settings.');
      const chats = settings.chats.filter((c) => c.enabled && (!chatIds || chatIds.includes(c.id)));
      for (const chat of chats) {
        if (!this.active(chat)) continue;
        const job = this.store.jobs().find((job) => job.chat_id === chat.id);
        try {
          const result = await this.runChat(
            chat,
            profile,
            job ? Boolean(job.reconcile) : true,
            !chatIds || Boolean(job?.manual),
            job ? now() - job.first : 0,
          );
          if (job)
            this.store.db
              .prepare('DELETE FROM chat_jobs WHERE chat_id=? AND generation=?')
              .run(chat.id, job.generation);
          const messages = this.store
            .messages()
            .filter((m) => m.sessionId === chat.sessionId && m.chatId === chat.chatId);
          if (
            result === 'done' &&
            this.active(chat) &&
            (this.store.pending(messages).length || this.store.pendingReplies(messages).length)
          )
            this.store.queueChat(chat.id, 0, false);
          this.store.setMeta('failures:' + chat.id, 0);
        } catch (error) {
          lastError = error instanceof Error ? error.message : 'Sync failed';
          const failures = z.number().parse(this.store.metaValue('failures:' + chat.id) ?? 0) + 1;
          const delay = Math.min(3600, 60 * 2 ** Math.min(failures, 6));
          this.store.setMeta('failures:' + chat.id, failures);
          this.store.db.prepare('DELETE FROM chat_jobs WHERE chat_id=?').run(chat.id);
          this.store.queueChat(chat.id, delay, true);
          this.store.status({ retry_at: now() + delay });
        }
      }
      const pendingCount = this.store
        .settings()
        .chats.filter((c) => c.enabled)
        .reduce((count, chat) => {
          const messages = this.store
            .messages()
            .filter((m) => m.sessionId === chat.sessionId && m.chatId === chat.chatId);
          return (
            count + this.store.pending(messages).length + this.store.pendingReplies(messages).length
          );
        }, 0);
      const queued = this.store.jobs().length > 0;
      this.store.status({
        syncing: false,
        error: lastError,
        pending: pendingCount,
        retry_at: lastError ? this.store.status().retry_at : undefined,
        debouncing: queued && !lastError,
        phase: lastError
          ? 'Waiting to retry a failed request'
          : queued
            ? 'Messages saved · waiting for task analysis'
            : pendingCount
              ? 'Messages saved · ready for Run now'
              : 'Listening for OpenWA events',
      });
    } catch (error) {
      this.store.status({
        syncing: false,
        error: error instanceof Error ? error.message : 'Sync failed',
      });
    } finally {
      this.running = false;
      this.notify();
    }
  }
  private async runChat(
    chat: Chat,
    profile: Profile,
    reconcile: boolean,
    manual: boolean,
    elapsed: number,
  ): Promise<'done' | 'deferred'> {
    this.store.status({ syncing: true, phase: `Checking ${chat.name}`, error: null });
    let messages = reconcile
      ? await this.openwa.messages(chat)
      : this.store
          .messages()
          .filter((m) => m.sessionId === chat.sessionId && m.chatId === chat.chatId);
    if (!this.active(chat)) return 'done';
    // Recover a bounded number of uncached older images without rereading all history.
    for (const m of messages.filter((m) => m.type === 'image' && !m.image_digest).slice(0, 3)) {
      const image = await this.openwa.media(m);
      if (image) {
        m.image_digest = hashImage(image.bytes);
        m.mediaMimetype = image.mime;
      }
    }
    this.store.cache(messages);
    const pending = this.store.pending(messages),
      replies = this.store.pendingReplies(messages);
    this.store.status({
      last_poll: now(),
      pending: pending.length + replies.length,
      syncing: false,
    });
    if (!pending.length && !replies.length) {
      this.store.status({ phase: 'Everything is up to date', debouncing: false });
      return 'done';
    }
    if (!manual) {
      const trigger = this.store.settings().trigger;
      if (trigger.mode === 'manual') {
        this.store.status({
          phase: 'Messages saved · ready when you choose Run now',
          pending: pending.length + replies.length,
        });
        return 'deferred';
      }
      if (reconcile) {
        this.store.queueChat(chat.id, this.store.settings().quietSeconds, false);
        return 'deferred';
      }
      const gateProfile = trigger.decisionProfileId
        ? this.store.settings().profiles.find((p) => p.id === trigger.decisionProfileId)
        : undefined;
      if (gateProfile) {
        const existing = this.store
          .snapshot()
          .tasks.filter((t) => t.source_ids.some((id) => messages.some((m) => m.id === id)));
        let decision: z.infer<typeof GateSchema>;
        try {
          decision = await decideTrigger(
            this.store,
            gateProfile,
            [
              ...new Map(
                [...pending.slice(0, 80), ...replies.slice(0, 40)].map((m) => [m.id, m]),
              ).values(),
            ],
            existing,
            elapsed,
          );
        } catch {
          decision = {
            choice: 'run' satisfies 'run' | 'wait' | 'skip',
            confidence: 0,
            reason:
              'The decision service was unavailable. Keeping the evidence by running task analysis.',
          };
        }
        this.store.status({ last_decision: { ...decision, connection: gateProfile.name } });
        if (!this.active(chat)) return 'done';
        if (decision.choice === 'wait') {
          this.store.queueChat(chat.id, Math.min(15, Math.max(0, 180 - elapsed)), false);
          return 'deferred';
        }
        if (decision.choice === 'skip') {
          this.store.apply([], pending.slice(0, 80));
          return 'done';
        }
      }
    }
    if (!this.active(chat)) return 'done';
    this.store.status({
      syncing: true,
      phase: `Reading evidence from ${chat.name}`,
      debouncing: false,
    });
    for (const m of messages.filter((m) => m.type === 'image' && m.image_digest)) {
      const reading = this.store.db
        .prepare('SELECT image_digest FROM image_readings WHERE message_id=?')
        .get(m.id);
      if (reading && reading.image_digest === m.image_digest) continue;
      const image = await this.openwa.media(m);
      if (!image) continue;
      const index = messages.findIndex((x) => x.id === m.id);
      const result = z.object({ readings: z.array(ImageReadingSchema).length(1) }).parse(
        await callModel(
          this.store,
          profile,
          (await prompt('vision')) +
            JSON.stringify([
              {
                image_number: 1,
                message_id: m.id,
                caption: m.body,
                nearby_messages: messages.slice(Math.max(0, index - 3), index + 4),
              },
            ]),
          'vision-schema.json',
          'screenshot reading',
          [image],
        ),
      );
      const value = result.readings[0];
      if (!value || value.message_id !== m.id)
        throw new Error('Screenshot evidence was assigned to the wrong message');
      if (!this.active(chat)) return 'done';
      this.store.db
        .prepare('INSERT OR REPLACE INTO image_readings VALUES(?,?,?)')
        .run(m.id, m.image_digest ?? '', JSON.stringify(value));
    }
    messages = this.store
      .snapshot()
      .messages.filter((m) => m.sessionId === chat.sessionId && m.chatId === chat.chatId);
    const snapshot = this.store.snapshot(),
      ids = new Set(messages.map((m) => m.id));
    const tasks = snapshot.tasks.filter((t) => t.source_ids.some((id) => ids.has(id)));
    const required = new Set(tasks.flatMap((t) => t.source_ids));
    for (const m of [...pending, ...replies]) if (m.reply_to_id) required.add(m.reply_to_id);
    const context = messages.filter((m, i) => required.has(m.id) || i >= messages.length - 80);
    const batch = messages.filter((m) => pending.some((p) => p.id === m.id)).slice(0, 80);
    if (batch.length) {
      this.store.status({ phase: `Finding next actions in ${chat.name}` });
      const candidate = z
        .object({ changes: z.array(TaskChangeSchema).max(40) })
        .parse(
          await callModel(
            this.store,
            profile,
            (await prompt('triage')) +
              JSON.stringify({ EXISTING_TASKS: tasks, CONTEXT: context, NEW_OR_EDITED: batch }),
            'schema.json',
            'task triage',
          ),
        );
      if (!this.active(chat)) return 'done';
      let changes = candidate.changes;
      if (changes.length) {
        const reviewed = z
          .object({ changes: z.array(TaskChangeSchema).max(40) })
          .parse(
            await callModel(
              this.store,
              profile,
              (await prompt('review')) +
                JSON.stringify({ CANDIDATES: changes, MESSAGES: [...context, ...batch] }),
              'schema.json',
              'evidence review',
            ),
          );
        if (
          reviewed.changes.length !== changes.length ||
          reviewed.changes.some((t, i) => t.id !== changes[i]?.id)
        )
          throw new Error('Evidence review changed task identity');
        changes = reviewed.changes;
      }
      if (!this.active(chat)) return 'done';
      this.store.apply(changes, batch, context);
    }
    if (replies.length) {
      if (!this.active(chat)) return 'done';
      this.store.status({ phase: `Matching completion replies in ${chat.name}` });
      const started = now(),
        part = replies.slice(0, 40);
      const result = z.object({ decisions: z.array(DecisionSchema) }).parse(
        await callModel(
          this.store,
          profile,
          (await prompt('completion')) +
            JSON.stringify({
              REPLIES_TO_CLASSIFY: part,
              CONVERSATION: context,
              TASKS: this.store
                .snapshot()
                .tasks.filter((t) => t.source_ids.some((id) => ids.has(id))),
            }),
          'completion-schema.json',
          'completion matching',
        ),
      );
      if (!this.active(chat)) return 'done';
      this.store.decide(result.decisions, part, started);
    }
    this.store.status({
      last_extract: now(),
      pending: this.store.pending(messages).length + this.store.pendingReplies(messages).length,
      phase: 'Everything is up to date',
    });
    return 'done';
  }
}
import { createHash } from 'node:crypto';
const hashImage = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export const prompt = (name: string) => readFile(`prompts/${name}.txt`, 'utf8');
