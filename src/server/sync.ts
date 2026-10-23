import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {DecisionSchema, ImageReadingSchema, TaskChangeSchema, type Chat, type Profile} from '../shared/schema.js';
import {Store, hash, now} from './store.js';
import {OpenWA} from './openwa.js';
import {callModel} from './ai.js';

export class Sync {
  running = false;
  force = false;
  timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private settle = new Map<string, {signature: string; first: number; last: number}>();
  private retry = new Map<string, {at: number; failures: number}>();
  constructor(readonly store: Store, readonly openwa: OpenWA) {}
  active(chat: Chat) {return this.store.settings().chats.some(c => c.id === chat.id && c.enabled && c.sessionId === chat.sessionId && c.chatId === chat.chatId);}
  start() {this.stopped = false; this.schedule(0);}
  stop() {this.stopped = true; clearTimeout(this.timer);}
  wake() {this.force = true; this.retry.clear(); if (!this.running) this.schedule(0);}
  reconfigure() {if (!this.running) this.schedule(0);}
  private schedule(delay: number) {clearTimeout(this.timer); if (!this.stopped) this.timer = setTimeout(() => void this.run(), delay);}
  async run() {
    if (this.running) return;
    this.running = true;
    let lastError: string | null = null, earliestRetry: number | undefined;
    try {
      const settings = this.store.settings();
      const profile = settings.profiles.find(p => p.id === settings.activeProfileId);
      if (!profile) throw new Error('Select a model connection in Settings.');
      const chats = settings.chats.filter(c => c.enabled);
      if (!chats.length) {this.store.status({phase: 'Activate a chat to get started', syncing: false, error: null, pending: 0, debouncing: false}); return;}
      for (const chat of chats) {
        if (!this.active(chat)) continue;
        const retry = this.retry.get(chat.id);
        if (retry && retry.at > now()) {earliestRetry = Math.min(earliestRetry ?? Infinity, retry.at); lastError = 'A connection is waiting to retry'; continue;}
        try {await this.runChat(chat, profile); this.retry.delete(chat.id);}
        catch (error) {
          lastError = error instanceof Error ? error.message : 'Sync failed';
          const failures = (retry?.failures ?? 0) + 1, at = now() + Math.min(3600, 60 * 2 ** Math.min(failures, 6));
          this.retry.set(chat.id, {at, failures}); earliestRetry = Math.min(earliestRetry ?? Infinity, at);
        }
      }
      this.store.status({syncing: false, error: lastError, ...(earliestRetry ? {retry_at: earliestRetry} : {})});
    } catch (error) {this.store.status({syncing: false, error: error instanceof Error ? error.message : 'Sync failed'});}
    finally {this.running = false; this.force = false; this.schedule(this.store.settings().pollSeconds * 1000);}
  }
  private async runChat(chat: Chat, profile: Profile) {
    this.store.status({syncing: true, phase: `Checking ${chat.name}`, error: null});
    let messages = await this.openwa.messages(chat);
    if (!this.active(chat)) return;
    // Recover a bounded number of uncached older images without rereading all history.
    for (const m of messages.filter(m => m.type === 'image' && !m.image_digest).slice(0, 3)) {
      const image = await this.openwa.media(m);
      if (image) {m.image_digest = hashImage(image.bytes); m.mediaMimetype = image.mime;}
    }
    this.store.cache(messages);
    const pending = this.store.pending(messages), replies = this.store.pendingReplies(messages);
    this.store.status({last_poll: now(), pending: pending.length + replies.length, syncing: false});
    if (!pending.length && !replies.length) {this.settle.delete(chat.id); this.store.status({phase: 'Everything is up to date', debouncing: false}); return;}
    const signature = hash([pending, replies]), time = now(), quiet = this.store.settings().quietSeconds;
    const old = this.settle.get(chat.id), current = old ? {...old, last: old.signature === signature ? old.last : time, signature} : {signature, first: time, last: time};
    this.settle.set(chat.id, current);
    if (!this.force && time - current.last < quiet && time - current.first < 180) {this.store.status({phase: 'Waiting for a quiet moment', debouncing: true}); return;}
    if (!this.active(chat)) return;
    this.store.status({syncing: true, phase: `Reading evidence from ${chat.name}`, debouncing: false});
    for (const m of messages.filter(m => m.type === 'image' && m.image_digest)) {
      const reading = this.store.db.prepare('SELECT image_digest FROM image_readings WHERE message_id=?').get(m.id);
      if (reading && reading.image_digest === m.image_digest) continue;
      const image = await this.openwa.media(m); if (!image) continue;
      const index = messages.findIndex(x => x.id === m.id);
      const result = z.object({readings: z.array(ImageReadingSchema).length(1)}).parse(await callModel(this.store, profile, await prompt('vision') + JSON.stringify([{image_number: 1, message_id: m.id, caption: m.body, nearby_messages: messages.slice(Math.max(0, index - 3), index + 4)}]), 'vision-schema.json', 'screenshot reading', [image]));
      const value = result.readings[0]; if (!value || value.message_id !== m.id) throw new Error('Screenshot evidence was assigned to the wrong message');
      if (!this.active(chat)) return;
      this.store.db.prepare('INSERT OR REPLACE INTO image_readings VALUES(?,?,?)').run(m.id, m.image_digest ?? '', JSON.stringify(value));
    }
    messages = this.store.snapshot().messages.filter(m => m.sessionId === chat.sessionId && m.chatId === chat.chatId);
    const snapshot = this.store.snapshot(), ids = new Set(messages.map(m => m.id));
    const tasks = snapshot.tasks.filter(t => t.source_ids.some(id => ids.has(id)));
    const required = new Set(tasks.flatMap(t => t.source_ids));
    for (const m of [...pending, ...replies]) if (m.reply_to_id) required.add(m.reply_to_id);
    const context = messages.filter((m,i) => required.has(m.id) || i >= messages.length - 80);
    const batch = messages.filter(m => pending.some(p => p.id === m.id)).slice(0, 80);
    if (batch.length) {
      this.store.status({phase: `Finding next actions in ${chat.name}`});
      const candidate = z.object({changes: z.array(TaskChangeSchema).max(40)}).parse(await callModel(this.store, profile, await prompt('triage') + JSON.stringify({EXISTING_TASKS: tasks, CONTEXT: context, NEW_OR_EDITED: batch}), 'schema.json', 'task triage'));
      if (!this.active(chat)) return;
      let changes = candidate.changes;
      if (changes.length) {
        const reviewed = z.object({changes: z.array(TaskChangeSchema).max(40)}).parse(await callModel(this.store, profile, await prompt('review') + JSON.stringify({CANDIDATES: changes, MESSAGES: [...context, ...batch]}), 'schema.json', 'evidence review'));
        if (reviewed.changes.length !== changes.length || reviewed.changes.some((t,i) => t.id !== changes[i]?.id)) throw new Error('Evidence review changed task identity');
        changes = reviewed.changes;
      }
      if (!this.active(chat)) return;
      this.store.apply(changes, batch, context);
    }
    if (replies.length) {
      if (!this.active(chat)) return;
      this.store.status({phase: `Matching completion replies in ${chat.name}`});
      const started = now(), part = replies.slice(0, 40);
      const result = z.object({decisions: z.array(DecisionSchema)}).parse(await callModel(this.store, profile, await prompt('completion') + JSON.stringify({REPLIES_TO_CLASSIFY: part, CONVERSATION: context, TASKS: this.store.snapshot().tasks.filter(t => t.source_ids.some(id => ids.has(id)))}), 'completion-schema.json', 'completion matching'));
      if (!this.active(chat)) return;
      this.store.decide(result.decisions, part, started);
    }
    this.settle.delete(chat.id);
    this.store.status({last_extract: now(), pending: this.store.pending(messages).length + this.store.pendingReplies(messages).length, phase: 'Everything is up to date'});
  }
}
import {createHash} from 'node:crypto';
const hashImage = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export const prompt = (name: string) => readFile(`prompts/${name}.txt`, 'utf8');
