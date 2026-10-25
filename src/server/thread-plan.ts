import { z } from 'zod';
import { ThreadPlanSchema } from '../shared/threads.js';
import { ThreadError } from './threads.js';

export function threadPlanContract(messageIds: string[], threadIds: string[]) {
  const messageKeys = new Map(messageIds.map((id, i) => [id, `m${i + 1}`]));
  const threadKeys = new Map(threadIds.map((id, i) => [id, `t${i + 1}`]));
  const threadsByKey = new Map([...threadKeys].map(([id, key]) => [key, id]));
  const destination = z.number().int().nonnegative().nullable();
  const response = z
    .object({
      threads: z
        .array(
          z
            .object({
              id: z.enum([...threadKeys.values()]).nullable(),
              title: z.string().trim().min(1).max(160),
            })
            .strict(),
        )
        .max(messageIds.length),
      assignments: z
        .object(Object.fromEntries([...messageKeys.values()].map((key) => [key, destination])))
        .strict(),
    })
    .strict();
  const schema: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['threads', 'assignments'],
    properties: {
      threads: {
        type: 'array',
        maxItems: messageIds.length,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'title'],
          properties: {
            id: { type: ['string', 'null'], enum: [...threadKeys.values(), null] },
            title: { type: 'string', minLength: 1, maxLength: 160 },
          },
        },
      },
      assignments: {
        type: 'object',
        additionalProperties: false,
        required: [...messageKeys.values()],
        properties: Object.fromEntries(
          [...messageKeys.values()].map((key) => [
            key,
            {
              type: ['integer', 'null'],
              minimum: 0,
              maximum: messageIds.length - 1,
            },
          ]),
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
      const threads = plan.threads.map((thread) => {
        const id = thread.id === null ? null : threadsByKey.get(thread.id);
        if (id === undefined)
          throw new ThreadError(422, 'Thread organisation referenced an unknown thread.');
        return { id, title: thread.title, messageIds: [] as string[] };
      });
      const otherMessageIds: string[] = [];
      for (const [id, key] of messageKeys) {
        const index = plan.assignments[key];
        if (index === null) otherMessageIds.push(id);
        else {
          const thread = index === undefined ? undefined : threads[index];
          if (!thread)
            throw new ThreadError(422, 'Thread organisation referenced a missing destination.');
          thread.messageIds.push(id);
        }
      }
      return ThreadPlanSchema.parse({
        threads: threads.filter((t) => t.messageIds.length),
        otherMessageIds,
      });
    },
  };
}
