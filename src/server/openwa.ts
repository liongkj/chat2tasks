import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MessageSchema, type Chat, type Message } from '../shared/schema.js';
import { Store, hash } from './store.js';
import type { Image } from './ai.js';

const RawSchema = z.object({
  id: z.string(),
  sessionId: z.string().optional(),
  chatId: z.string().optional(),
  waMessageId: z.string().nullish(),
  body: z.string().nullish(),
  type: z.string().nullish(),
  direction: z.enum(['incoming', 'outgoing']),
  timestamp: z.number().nullish(),
  metadata: z
    .object({
      quotedMessage: z
        .object({ id: z.string().optional(), body: z.string().optional() })
        .optional(),
      media: z.object({ mimetype: z.string().optional(), data: z.string().optional() }).optional(),
    })
    .nullish(),
});
export class OpenWA {
  constructor(readonly store: Store) {}
  async request(path: string, method = 'GET', body?: unknown) {
    const settings = this.store.settings(),
      key = this.store.secret('openwa');
    if (!settings.openwaUrl || !key)
      throw new Error('Connect OpenWA in Settings → Chats to start syncing.');
    const response = await fetch(settings.openwaUrl.replace(/\/$/, '') + path, {
      method,
      headers: {
        'X-API-Key': key,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(
        `OpenWA returned HTTP ${response.status}. ${response.status === 429 ? 'Sync will retry after a pause.' : 'Check the connection and session.'}`,
      );
    return response;
  }
  mediaPath(id: string) {
    return join(this.store.dir, 'media', hashString(id) + '.bin');
  }
  async saveMedia(id: string, bytes: Buffer) {
    if (!bytes.length || bytes.length > 20_000_000)
      throw new Error('Image is empty or larger than 20 MB');
    await mkdir(join(this.store.dir, 'media'), { recursive: true, mode: 0o700 });
    const path = this.mediaPath(id),
      temp = path + '.' + randomUUID();
    await writeFile(temp, bytes, { mode: 0o600 });
    await rename(temp, path);
  }
  async media(message: Message): Promise<Image | null> {
    if (message.type !== 'image') return null;
    try {
      const file = this.mediaPath(message.id);
      if ((await stat(file)).size <= 20_000_000)
        return { mime: message.mediaMimetype ?? 'image/jpeg', bytes: await readFile(file) };
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (!message.waMessageId) return null;
    try {
      const response = await this.request(
        `/api/sessions/${encodeURIComponent(message.sessionId)}/messages/${encodeURIComponent(message.chatId)}/${encodeURIComponent(message.waMessageId)}/media`,
      );
      const mime = response.headers.get('Content-Type')?.split(';')[0] ?? '';
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime)) return null;
      const bytes = await boundedBytes(response, 20_000_000);
      await this.saveMedia(message.id, bytes);
      return { mime, bytes };
    } catch (error) {
      if (error instanceof Error && error.message.includes('HTTP 404')) return null;
      throw error;
    }
  }
  async messages(chat: Chat) {
    const cursorKey = 'cursor:' + hash([chat.sessionId, chat.chatId]);
    const cursor = z.string().optional().parse(this.store.metaValue(cursorKey));
    const cached = this.store
      .messages()
      .filter((m) => m.sessionId === chat.sessionId && m.chatId === chat.chatId);
    const old = new Map(cached.map((m) => [m.waMessageId ?? m.openwaId ?? m.id, m]));
    const raw: z.infer<typeof RawSchema>[] = [],
      pages = new Set<string>();
    let after: string | undefined, newest: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const query = new URLSearchParams({
        chatId: chat.chatId,
        limit: '100',
        inlineMedia: cursor ? 'false' : 'true',
      });
      if (after) query.set('after', after);
      const response = await this.request(
        `/api/sessions/${encodeURIComponent(chat.sessionId)}/messages?${query}`,
      );
      const result = z.object({ messages: z.array(RawSchema) }).parse(await response.json());
      if (!newest) newest = result.messages[0]?.id;
      const found = result.messages.some((row) => row.id === cursor);
      raw.push(...result.messages);
      const next = result.messages.at(-1)?.id;
      if (found || result.messages.length < 100 || !next) break;
      if (pages.has(next))
        throw new Error('OpenWA repeated a history page. Sync paused to avoid skipping messages.');
      pages.add(next);
      after = next;
      if (page === 999)
        throw new Error('History is too large for one pass. No cursor was advanced.');
    }
    const normalized: Message[] = [];
    for (const row of raw) {
      const previous = old.get(row.waMessageId ?? row.id);
      let m = MessageSchema.parse({
        ...row,
        id: previous?.id ?? hash([chat.sessionId, chat.chatId, row.waMessageId ?? row.id]),
        sessionId: chat.sessionId,
        chatId: chat.chatId,
        timestamp: row.timestamp ?? 0,
        openwaId: row.id,
        reply_to_wa_id: row.metadata?.quotedMessage?.id,
        reply_quote: row.metadata?.quotedMessage?.body,
        mediaMimetype: row.metadata?.media?.mimetype ?? previous?.mediaMimetype,
        image_digest: previous?.image_digest,
      });
      if (m.type === 'image' && (row.metadata?.media?.data || !previous)) {
        const encoded = row.metadata?.media?.data;
        if (encoded) {
          await this.saveMedia(m.id, Buffer.from(encoded, 'base64'));
        }
        const image = await this.media(m);
        if (image) m = { ...m, mediaMimetype: image.mime, image_digest: hashBytes(image.bytes) };
      }
      normalized.push(m);
    }
    const combined = new Map(cached.map((m) => [m.id, m]));
    for (const m of normalized) combined.set(m.id, m);
    const messages = [...combined.values()].sort(
      (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id),
    );
    for (const m of messages) {
      if (!m.reply_to_wa_id) continue;
      const quoted = messages.filter(
        (p) =>
          p.waMessageId === m.reply_to_wa_id ||
          p.id === m.reply_to_wa_id ||
          p.waMessageId?.split('_').at(-1) === m.reply_to_wa_id,
      );
      m.reply_to_id = quoted.length === 1 ? quoted[0]?.id : null;
    }
    this.store.cache(messages);
    if (newest) this.store.setMeta(cursorKey, newest);
    return messages;
  }
}
import { createHash } from 'node:crypto';
const hashString = (text: string) => createHash('sha256').update(text).digest('hex');
const hashBytes = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export async function boundedBytes(response: Response, maximum: number) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!response.body) throw new Error('The image response was empty');
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) {
        await reader.cancel();
        throw new Error('The image is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
