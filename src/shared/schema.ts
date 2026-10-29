import { z } from 'zod';
const text = z.string().trim().min(1).max(4000);
export const ChatSchema = z.object({
  id: text,
  name: text,
  sessionId: text,
  chatId: text,
  enabled: z.boolean(),
});
const profileBase = { id: text, name: text, model: text };
const endpoint = z.url().refine((value) => {
  const url = new URL(value);
  return (
    ['https:', 'http:'].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}, 'Use an HTTP(S) base URL without credentials or query parameters');
export const ProfileSchema = z.discriminatedUnion('kind', [
  z.object({ ...profileBase, kind: z.literal('codex') }),
  z.object({ ...profileBase, kind: z.literal('compatible'), baseUrl: endpoint }),
  z.object({
    ...profileBase,
    kind: z.literal('decision'),
    provider: z.enum(['openai', 'jev']),
    baseUrl: endpoint,
  }),
  z.object({
    ...profileBase,
    kind: z.literal('cloudflare'),
    accountId: z
      .string()
      .regex(/^[a-fA-F0-9]{32}$/, 'Account ID must be 32 hexadecimal characters'),
    gatewayId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    route: z.enum(['proxy', 'unified']),
  }),
]);
export const SettingsSchema = z
  .object({
    openwaUrl: z.union([z.literal(''), endpoint]),
    chats: z.array(ChatSchema).max(100),
    profiles: z.array(ProfileSchema).min(1).max(30),
    activeProfileId: text,
    webhookUrl: z.union([z.literal(''), endpoint]).default(''),
    quietSeconds: z.number().int().min(0).max(300),
    trigger: z
      .discriminatedUnion('mode', [
        z.object({ mode: z.literal('manual') }),
        z.object({ mode: z.literal('automatic'), decisionProfileId: z.string().nullable() }),
      ])
      .default({ mode: 'automatic', decisionProfileId: null }),
  })
  .superRefine((settings, ctx) => {
    for (const [name, list] of [
      ['chats', settings.chats],
      ['profiles', settings.profiles],
    ] satisfies [string, { id: string }[]][]) {
      if (new Set(list.map((x) => x.id)).size !== list.length)
        ctx.addIssue({ code: 'custom', message: `Duplicate ${name} IDs` });
    }
    if (
      new Set(settings.chats.map((x) => `${x.sessionId}\0${x.chatId}`)).size !==
      settings.chats.length
    )
      ctx.addIssue({ code: 'custom', message: 'Each conversation can only be added once' });
    if (!settings.profiles.some((p) => p.id === settings.activeProfileId && p.kind !== 'decision'))
      ctx.addIssue({ code: 'custom', message: 'Choose an existing model connection' });
    const gateId =
      settings.trigger.mode === 'automatic' ? settings.trigger.decisionProfileId : null;
    if (gateId && !settings.profiles.some((p) => p.id === gateId))
      ctx.addIssue({ code: 'custom', message: 'Choose an existing decision connection' });
  });
export const SettingsUpdateSchema = z.object({
  settings: SettingsSchema,
  secrets: z.record(z.string(), z.string().max(8192)).default({}),
  removeSecrets: z.array(z.string()).default([]),
});
export const ImageReadingSchema = z.object({
  message_id: text,
  observations: z.array(text),
  uncertainties: z.array(text),
});
export const MessageSchema = z.object({
  id: text,
  sessionId: text,
  chatId: text,
  waMessageId: z.string().nullish(),
  body: z
    .string()
    .nullish()
    .transform((v) => v ?? ''),
  type: z
    .string()
    .nullish()
    .transform((v) => v ?? 'text'),
  direction: z.enum(['incoming', 'outgoing']),
  timestamp: z
    .number()
    .nullable()
    .transform((v) => v ?? 0),
  openwaId: z.string().optional(),
  reply_to_wa_id: z.string().nullish(),
  reply_to_id: z.string().nullish(),
  reply_quote: z.string().nullish(),
  mediaMimetype: z.string().nullish(),
  image_digest: z.string().nullish(),
  image_reading: ImageReadingSchema.optional(),
  browser_source: z.object({ url: z.url(), title: z.string(), capturedAt: z.number() }).optional(),
  entity_link: z.object({ plant: z.string(), basis: z.string() }).optional(),
});
export const TaskTriageSchema = z
  .object({
    title: text,
    scope: text,
    note: text,
    action_steps: z.array(text).min(1).max(8),
    done_when: z.array(text).min(1).max(8),
    priority: z.enum(['high', 'normal', 'low']),
    triage_state: z.enum(['ready', 'needs_info', 'waiting', 'reported_done']),
    blocking_question: z.string().nullable(),
  })
  .strict()
  .refine(
    (t) => t.triage_state !== 'needs_info' || Boolean(t.blocking_question?.trim()),
    'A blocked task needs a concrete question',
  );
export const TaskChangeSchema = TaskTriageSchema.safeExtend({
  id: z.string().nullable(),
  source_ids: z.array(text).min(1),
});
export const TaskTriageUpdateSchema = TaskTriageSchema.safeExtend({
  id: text,
  expected_revision: z.string().regex(/^[a-f0-9]{64}$/),
});
const TaskBaseSchema = z.object({
  id: text,
  reference: z.string().regex(/^TODO-\d{3,}$/),
  title: text,
  scope: text,
  note: z.string(),
  created: z.number(),
  updated: z.number(),
  done: z.boolean(),
  resolution: z
    .object({ kind: z.enum(['filtered', 'reply']), reason: z.string() })
    .nullable()
    .default(null),
  source_ids: z.array(z.string()),
  own_remark: z.string().default(''),
  action_steps: z.array(z.string()).default([]),
  done_when: z.array(z.string()).default([]),
  priority: z.enum(['high', 'normal', 'low']).default('normal'),
  triage_state: z.enum(['ready', 'needs_info', 'waiting', 'reported_done']).default('ready'),
  blocking_question: z.string().nullable().default(null),
});
export const TaskSchema = TaskBaseSchema.extend({
  merged_from: z
    .array(
      TaskBaseSchema.pick({
        id: true,
        reference: true,
        title: true,
        note: true,
        own_remark: true,
        done: true,
        source_ids: true,
      }),
    )
    .default([]),
});
export const TaskEvidenceSchema = z.object({
  task: TaskSchema,
  messages: z.array(MessageSchema),
  revision: z.string(),
});
export const TaskMergeSchema = z
  .object({
    source_id: text,
    target_id: text,
    source_revision: z.string().regex(/^[a-f0-9]{64}$/),
    target_revision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const DecisionSchema = z
  .object({
    message_id: text,
    action: z.enum(['none', 'complete', 'ask']),
    task_ids: z.array(text),
    evidence_quote: z.string(),
    reason: text,
    question: z.string().nullable(),
  })
  .strict();
export const QuestionSchema = DecisionSchema.extend({ id: text });
export const StatusSchema = z.object({
  syncing: z.boolean().default(false),
  phase: z.string().default('Ready'),
  error: z.string().nullable().default(null),
  last_poll: z.number().optional(),
  last_extract: z.number().optional(),
  retry_at: z.number().optional(),
  pending: z.number().default(0),
  debouncing: z.boolean().default(false),
  last_webhook: z.number().optional(),
  last_decision: z
    .object({
      choice: z.enum(['run', 'wait', 'skip']),
      reason: z.string(),
      connection: z.string(),
      confidence: z.number().nullable(),
    })
    .optional(),
});
export const SnapshotSchema = z.object({
  demo: z.boolean().default(false),
  tasks: z.array(TaskSchema),
  messages: z.array(MessageSchema),
  questions: z.array(QuestionSchema),
  status: StatusSchema,
  usage: z.object({ calls: z.number(), totalTokens: z.number(), model: z.string() }),
});
export const PublicSettingsSchema = z.object({
  settings: SettingsSchema,
  configuredSecrets: z.array(z.string()),
  webhook: z
    .object({ registeredSessions: z.number(), lastReceivedAt: z.number().nullable() })
    .default({ registeredSessions: 0, lastReceivedAt: null }),
});
export type Chat = z.infer<typeof ChatSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsUpdate = z.infer<typeof SettingsUpdateSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type TaskEvidence = z.infer<typeof TaskEvidenceSchema>;
export type TaskChange = z.infer<typeof TaskChangeSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type Question = z.infer<typeof QuestionSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type Status = z.infer<typeof StatusSchema>;
export type PublicSettings = z.infer<typeof PublicSettingsSchema>;
