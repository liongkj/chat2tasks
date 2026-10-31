import { z } from 'zod';
import {
  MessageSchema,
  SoundPreferencesSchema,
  StatusSchema,
  TaskSchema,
  WaitSchema,
  defaultSoundPreferences,
} from './schema.js';

export const ExtensionIdSchema = z.string().regex(/^[a-p]{32}$/);
export const BackendUrlSchema = z
  .string()
  .url()
  .transform((value, context) => {
    const url = new URL(value);
    if (
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Use an HTTPS server address, or HTTP localhost for a local server.',
      });
      return z.NEVER;
    }
    return url.origin;
  });
export const PairCodeSchema = z.object({ code: z.string(), expiresAt: z.number() });
export const PairRequestSchema = z.object({
  code: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(80),
});
export const PairResultSchema = z.object({
  token: z.string(),
  deviceId: z.string(),
  expiresAt: z.number(),
});
export const DeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  created: z.number(),
  lastUsed: z.number().nullable(),
  expiresAt: z.number(),
});
export const DevicesSchema = z.object({ devices: z.array(DeviceSchema) });
export const CompanionChatSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
});
export const CompanionStateSchema = z.object({
  sound: SoundPreferencesSchema.default(defaultSoundPreferences),
  tasks: z.array(TaskSchema.extend({ chatIds: z.array(z.string()) })),
  waiting_for: z.array(WaitSchema).default([]),
  chats: z.array(CompanionChatSchema),
  status: StatusSchema,
  analysisMode: z.enum(['automatic', 'manual']),
  quietSeconds: z.number(),
});
export const CompanionTaskSchema = z.object({ task: TaskSchema, messages: z.array(MessageSchema) });
export const CaptureDraftSchema = z.object({
  id: z.uuid(),
  text: z.string().max(16000),
  url: z.url().max(2000),
  title: z.string().max(256),
});
export const CaptureSchema = CaptureDraftSchema.extend({
  text: z.string().trim().min(1).max(16000),
  url: z
    .url()
    .max(2000)
    .refine(
      (value) => new URL(value).origin === 'https://web.whatsapp.com',
      'Capture text from WhatsApp Web.',
    ),
  chatId: z.string().min(1),
});
export const CaptureResultSchema = z.object({
  saved: z.literal(true),
  duplicate: z.boolean(),
  messageId: z.string(),
  queued: z.boolean(),
});
export const ConnectionSchema = z.object({
  serverUrl: BackendUrlSchema,
  token: z.string().min(1),
  deviceId: z.string(),
  expiresAt: z.number(),
});
export type Connection = z.infer<typeof ConnectionSchema>;
export type CaptureDraft = z.infer<typeof CaptureDraftSchema>;
export type CompanionState = z.infer<typeof CompanionStateSchema>;
