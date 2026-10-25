import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, fingerprint, hash, now } from './store.js';
import type { Message } from '../shared/schema.js';
import {
  ThreadStatusSchema,
  whatsappMessageKey,
  type ThreadMove,
  type ThreadPlan,
  type ThreadSnapshot,
  type ThreadStatus,
} from '../shared/threads.js';

const Membership = z.object({
  message_id: z.string(),
  thread_id: z.string().nullable(),
  manual: z.number(),
  digest: z.string(),
  updated: z.number(),
});
const Topic = z.object({ id: z.string(), title: z.string(), created: z.number() });
const digest = (m: Message) => hash([fingerprint(m), m.image_reading ?? null]);

export class ThreadError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export class Threads {
  constructor(readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS discussion_threads(id TEXT PRIMARY KEY,title TEXT NOT NULL,created REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_memberships(message_id TEXT PRIMARY KEY REFERENCES messages(id),thread_id TEXT REFERENCES discussion_threads(id),manual INTEGER NOT NULL,digest TEXT NOT NULL,updated REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS thread_memberships_topic ON thread_memberships(thread_id);
    `);
  }
  private memberships() {
    return new Map(
      this.store.db
        .prepare('SELECT * FROM thread_memberships')
        .all()
        .map((row) => Membership.parse(row))
        .map((row) => [row.message_id, row]),
    );
  }
  private revision(message: Message, row: z.infer<typeof Membership> | undefined) {
    return hash([message.id, row ?? null, digest(message)]);
  }
  status(value?: ThreadStatus) {
    if (value) this.store.setMeta('thread_status', value);
    return ThreadStatusSchema.parse(this.store.metaValue('thread_status') ?? { kind: 'idle' });
  }
  snapshot(): Omit<ThreadSnapshot, 'canOrganise'> {
    const snapshot = this.store.snapshot(),
      chats = this.store.settings().chats;
    const memberships = this.memberships();
    const messages = snapshot.messages.flatMap((message) => {
      const chat = chats.find(
        (c) => c.sessionId === message.sessionId && c.chatId === message.chatId,
      );
      if (!chat) return [];
      const row = memberships.get(message.id);
      return [
        {
          ...message,
          conversationId: chat.id,
          threadId: row?.thread_id ?? null,
          groupingRevision: this.revision(message, row),
        },
      ];
    });
    const topics = this.store.db
      .prepare('SELECT * FROM discussion_threads')
      .all()
      .map((row) => Topic.parse(row));
    const threads = topics
      .flatMap((topic) => {
        const linked = messages.filter((m) => m.threadId === topic.id);
        if (!linked.length) return [];
        const ids = new Set(linked.map((m) => m.id));
        return [
          {
            ...topic,
            updated: Math.max(...linked.map((m) => m.timestamp)),
            messageIds: [...ids],
            taskIds: snapshot.tasks
              .filter((t) => t.source_ids.some((id) => ids.has(id)))
              .map((t) => t.id),
          },
        ];
      })
      .sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id));
    return { threads, messages, chats, tasks: snapshot.tasks, status: this.status() };
  }
  pending() {
    const memberships = this.memberships();
    return this.snapshot().messages.filter((m) => {
      const row = memberships.get(m.id);
      return !row || (!row.manual && row.digest !== digest(m));
    });
  }
  apply(plan: ThreadPlan, input: Message[]) {
    const expected = new Map(input.map((m) => [m.id, m]));
    const assigned = [...plan.threads.flatMap((t) => t.messageIds), ...plan.otherMessageIds];
    if (
      assigned.length !== expected.size ||
      new Set(assigned).size !== assigned.length ||
      assigned.some((id) => !expected.has(id))
    )
      throw new ThreadError(
        422,
        'Thread organisation must account for each supplied message exactly once.',
      );
    const existing = new Set(
      this.store.db
        .prepare('SELECT id FROM discussion_threads')
        .all()
        .map((row) => z.string().parse(row.id)),
    );
    if (plan.threads.some((t) => t.id !== null && !existing.has(t.id)))
      throw new ThreadError(422, 'Thread organisation referenced an unknown thread.');
    const current = new Map(this.snapshot().messages.map((m) => [m.id, m]));
    const active = new Set(
      this.store
        .settings()
        .chats.filter((c) => c.enabled)
        .map((c) => c.id),
    );
    const memberships = this.memberships();
    const writable = new Set(
      input
        .filter((before) => {
          const after = current.get(before.id);
          return (
            after &&
            active.has(after.conversationId) &&
            !memberships.get(before.id)?.manual &&
            digest(before) === digest(after)
          );
        })
        .map((m) => m.id),
    );
    this.store.transaction(() => {
      const write = this.store.db.prepare(`INSERT INTO thread_memberships VALUES(?,?,0,?,?)
        ON CONFLICT(message_id) DO UPDATE SET thread_id=excluded.thread_id,digest=excluded.digest,updated=excluded.updated WHERE thread_memberships.manual=0`);
      const put = (id: string, threadId: string | null) => {
        const before = expected.get(id);
        if (before && writable.has(id)) write.run(id, threadId, digest(before), now());
      };
      for (const group of plan.threads) {
        if (!group.messageIds.some((id) => writable.has(id))) continue;
        const id = group.id ?? randomUUID();
        if (group.id === null)
          this.store.db
            .prepare('INSERT INTO discussion_threads VALUES(?,?,?)')
            .run(id, group.title, now());
        for (const messageId of group.messageIds) put(messageId, id);
      }
      for (const id of plan.otherMessageIds) put(id, null);
    });
  }
  move(input: ThreadMove) {
    return this.store.transaction(() => {
      const source = this.snapshot().messages.find((m) => m.id === input.messageId);
      if (!source)
        throw new ThreadError(404, 'Original message not found in your connected chats.');
      if (source.groupingRevision !== input.expectedRevision)
        throw new ThreadError(409, 'This message or its thread changed. Refresh and try again.');
      let threadId: string | null;
      switch (input.target.kind) {
        case 'other':
          threadId = null;
          break;
        case 'thread':
          threadId = input.target.id;
          if (!this.store.db.prepare('SELECT id FROM discussion_threads WHERE id=?').get(threadId))
            throw new ThreadError(404, 'Thread not found.');
          break;
        case 'new':
          threadId = randomUUID();
          this.store.db
            .prepare('INSERT INTO discussion_threads VALUES(?,?,?)')
            .run(threadId, input.target.title, now());
          break;
      }
      this.store.db
        .prepare(
          `INSERT INTO thread_memberships VALUES(?,?,1,'',?)
        ON CONFLICT(message_id) DO UPDATE SET thread_id=excluded.thread_id,manual=1,updated=excluded.updated`,
        )
        .run(input.messageId, threadId, now());
      return { threadId };
    });
  }
  annotations(waIds: string[]) {
    const snapshot = this.snapshot();
    const index = new Map<string, typeof snapshot.messages>();
    for (const m of snapshot.messages) {
      if (!m.waMessageId) continue;
      const key = whatsappMessageKey(m.waMessageId);
      index.set(key, [...(index.get(key) ?? []), m]);
    }
    const matches = waIds.flatMap((waId) => {
      const matches = index.get(whatsappMessageKey(waId));
      const m = matches?.length === 1 ? matches[0] : undefined;
      return m ? [{ waId, conversationId: m.conversationId, message: m }] : [];
    });
    return {
      matches: matches.map(({ waId, conversationId }) => ({ waId, conversationId })),
      annotations: matches.flatMap(({ waId, message: m }) =>
        snapshot.tasks
          .filter((t) => t.source_ids.includes(m.id))
          .map((t) => ({
            waId,
            conversationId: m.conversationId,
            taskId: t.id,
            reference: t.reference,
            title: t.title,
            done: t.done,
          })),
      ),
    };
  }
}
