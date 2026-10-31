import { z } from 'zod';

const searchUrl = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}, 'Enter an HTTP(S) server address without a path or credentials.');

export const SearchSettingsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace') }),
  z.object({ kind: z.literal('server'), url: searchUrl }),
]);
export const SearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(500),
  retry: z.boolean().default(false),
});
export const SearchResponseSchema = z.object({
  moreExact: z.boolean(),
  status: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('ready') }),
    z.object({ kind: z.literal('indexing'), indexed: z.number(), total: z.number() }),
    z.object({ kind: z.literal('unavailable') }),
  ]),
  results: z.array(
    z.object({
      kind: z.enum(['task', 'message']),
      id: z.string(),
      match: z.enum(['exact', 'related']),
    }),
  ),
});
export type SearchSettings = z.infer<typeof SearchSettingsSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
