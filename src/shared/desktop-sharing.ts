import { z } from 'zod';

const origin = z
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    );
  }, 'Use an HTTPS server address without a path, login, or query.')
  .transform((value) => new URL(value).origin);

const enabled = z.object({
  kind: z.literal('enabled'),
  origin,
  port: z.number().int().min(1024).max(65535),
});

export const DesktopSharingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('disabled') }),
  enabled,
]);
export const DesktopSharingUpdateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('disabled') }),
  enabled.extend({ password: z.string().min(12).max(1024) }),
]);
export const DesktopSharingStatusSchema = z.object({
  configured: DesktopSharingSchema,
  active: DesktopSharingSchema,
  restartRequired: z.boolean(),
  unavailableReason: z.enum(['port_in_use']).nullable(),
});

export type DesktopSharing = z.infer<typeof DesktopSharingSchema>;
