import { z } from 'zod';
import { ChatSchema, MessageSchema, TaskSchema } from './schema.js';

const title = z.string().trim().min(1).max(160);
export const ThreadSchema = z.object({
  id: z.uuid(),
  title,
  created: z.number(),
  updated: z.number(),
  messageIds: z.array(z.string()),
  taskIds: z.array(z.string()),
});
export const ThreadMessageSchema = MessageSchema.extend({
  conversationId: z.string(),
  threadId: z.uuid().nullable(),
  groupingRevision: z.string(),
});
export const ThreadStatusSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('idle') }),
  z.object({ kind: z.literal('queued') }),
  z.object({ kind: z.literal('running'), remaining: z.number() }),
  z.object({ kind: z.literal('error'), message: z.string() }),
]);
export const ThreadSnapshotSchema = z.object({
  canOrganise: z.boolean(),
  threads: z.array(ThreadSchema),
  messages: z.array(ThreadMessageSchema),
  chats: z.array(ChatSchema),
  tasks: z.array(TaskSchema),
  status: ThreadStatusSchema,
});
export const ThreadMoveSchema = z.object({
  messageId: z.string().min(1),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('thread'), id: z.uuid() }),
    z.object({ kind: z.literal('new'), title }),
    z.object({ kind: z.literal('other') }),
  ]),
});
export const ThreadMoveResultSchema = z.object({
  threadId: z.uuid().nullable(),
});
export const ThreadPlanSchema = z.object({
  threads: z.array(
    z.object({
      id: z.uuid().nullable(),
      title,
      messageIds: z.array(z.string()).min(1),
    }),
  ),
  otherMessageIds: z.array(z.string()),
});
export const AnnotationRequestSchema = z.object({
  waIds: z.array(z.string().min(1).max(240)).max(500),
});
export const AnnotationsSchema = z.object({
  matches: z.array(z.object({ waId: z.string(), conversationId: z.string() })),
  annotations: z.array(
    z.object({
      waId: z.string(),
      conversationId: z.string(),
      taskId: z.string(),
      reference: z.string(),
      title: z.string(),
      done: z.boolean(),
    }),
  ),
});
export const ThreadMediaSchema = z.object({
  dataUrl: z.string().regex(/^data:image\/(?:jpeg|png|webp|gif);base64,/),
});
export type ThreadSnapshot = z.infer<typeof ThreadSnapshotSchema>;
export type ThreadMessage = z.infer<typeof ThreadMessageSchema>;
export type ThreadMove = z.infer<typeof ThreadMoveSchema>;
export type ThreadPlan = z.infer<typeof ThreadPlanSchema>;
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;

export function whatsappMessageKey(id: string) {
  return (id.split('_').at(-1) ?? '').toUpperCase();
}
