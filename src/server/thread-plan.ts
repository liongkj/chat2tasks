import { z } from 'zod';
import { ThreadPlanSchema, type ThreadSnapshot } from '../shared/threads.js';
import { ThreadError } from './threads.js';

type Topic = Pick<ThreadSnapshot['threads'][number], 'id' | 'title'>;

export function threadPlanContract(messageIds: string[], topics: Topic[]) {
  const messageKeys = new Map(messageIds.map((id, i) => [id, `m${i + 1}`]));
  const threadKeys = new Map(topics.map((topic, i) => [topic.id, `t${i + 1}`]));
  const topicsByKey = new Map(topics.map((topic, i) => [`t${i + 1}`, topic]));
  const destination = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('thread'), id: z.enum([...threadKeys.values()]) }).strict(),
    z.object({ kind: z.literal('new'), title: z.string().trim().min(1).max(160) }).strict(),
    z.object({ kind: z.literal('other') }).strict(),
  ]);
  const response = z
    .object({
      assignments: z
        .object(Object.fromEntries([...messageKeys.values()].map((key) => [key, destination])))
        .strict(),
    })
    .strict();
  const variants = [
    ...(topics.length
      ? [
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'id'],
            properties: {
              kind: { type: 'string', enum: ['thread'] },
              id: { type: 'string', enum: [...threadKeys.values()] },
            },
          },
        ]
      : []),
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'title'],
      properties: {
        kind: { type: 'string', enum: ['new'] },
        title: { type: 'string', minLength: 1, maxLength: 160 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: { kind: { type: 'string', enum: ['other'] } },
    },
  ];
  const schema: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['assignments'],
    properties: {
      assignments: {
        type: 'object',
        additionalProperties: false,
        required: [...messageKeys.values()],
        properties: Object.fromEntries(
          [...messageKeys.values()].map((key) => [key, { anyOf: variants }]),
        ),
      },
    },
  };
  return {
    schema,
    messageKeys,
    threadKeys,
    parse(value: unknown) {
      const plan = response.parse(value);
      const groups = new Map<string, { id: string | null; title: string; messageIds: string[] }>();
      const otherMessageIds: string[] = [];
      for (const [id, key] of messageKeys) {
        const assignment = plan.assignments[key];
        if (!assignment) throw new ThreadError(422, 'Thread organisation omitted a message.');
        if (assignment.kind === 'other') {
          otherMessageIds.push(id);
          continue;
        }
        let topic: Topic | { id: null; title: string };
        let groupKey: string;
        if (assignment.kind === 'thread') {
          const existing = topicsByKey.get(assignment.id);
          if (!existing)
            throw new ThreadError(422, 'Thread organisation referenced an unknown thread.');
          topic = existing;
          groupKey = 'thread:' + existing.id;
        } else {
          topic = { id: null, title: assignment.title };
          groupKey = 'new:' + assignment.title.replace(/\s+/g, ' ').toLowerCase();
        }
        const group = groups.get(groupKey) ?? { ...topic, messageIds: [] };
        group.messageIds.push(id);
        groups.set(groupKey, group);
      }
      return ThreadPlanSchema.parse({ threads: [...groups.values()], otherMessageIds });
    },
  };
}
