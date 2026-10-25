import { z } from 'zod';
import { AnnotationRequestSchema, ThreadMoveSchema } from '../../src/shared/threads.js';

export const PageRequestSchema = z.discriminatedUnion('kind', [
  AnnotationRequestSchema.extend({
    kind: z.literal('annotations'),
    chatTitle: z.string().max(256),
  }),
  z.object({ kind: z.literal('threads') }),
  z.object({ kind: z.literal('enable-threads') }),
  z.object({ kind: z.literal('organise') }),
  z.object({ kind: z.literal('move'), input: ThreadMoveSchema }),
  z.object({ kind: z.literal('open-task'), id: z.string().min(1) }),
  z.object({ kind: z.literal('media'), id: z.string().min(1) }),
  z.object({ kind: z.literal('open-panel') }),
]);
export const PageResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type PageRequest = z.infer<typeof PageRequestSchema>;

export async function pageRequest<T>(input: PageRequest, schema: z.ZodType<T>): Promise<T> {
  let payload: unknown;
  try {
    payload = await chrome.runtime.sendMessage(input);
  } catch {
    throw new Error('The companion is unavailable. Refresh WhatsApp Web and try again.');
  }
  const response = PageResponseSchema.parse(payload);
  if (!response.ok) throw new Error(response.error);
  return schema.parse(response.data);
}
