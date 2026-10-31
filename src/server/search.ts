import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Message, Snapshot } from '../shared/schema.js';
import {
  SearchRequestSchema,
  SearchSettingsSchema,
  type SearchResponse,
  type SearchSettings,
} from '../shared/search.js';
import type { Attachment } from './openwa.js';
import { mediaKind, type MediaInput, type MediaKind } from './search-media.js';

const model = 'embeddinggemma-2:270m-q8_0-text';
const mediaModel = 'embeddinggemma-2:740m-q8_0';
const dimensions = 256;
const minSimilarity = 0.7;
const chunkLength = 1000;
type Document = { kind: 'task' | 'message'; id: string; title: string; text: string };
type Part = Document & { index: number; digest: string; prompt: string };
type Embed = (args: { input: string[]; url: string; signal: AbortSignal }) => Promise<number[][]>;
type MediaEmbed = (args: {
  input: MediaInput[];
  url: string;
  signal: AbortSignal;
}) => Promise<number[][]>;
type MediaOptions = {
  load: (message: Message) => Promise<Attachment | null>;
  prepare: (
    attachment: Attachment,
    kind: MediaKind,
    signal: AbortSignal,
  ) => AsyncIterable<MediaInput> | Promise<MediaInput[]>;
  embed?: MediaEmbed;
};
type MediaCandidate = { message: Message; kind: MediaKind; digest: string };
type Scored = { kind: 'task' | 'message'; id: string; score: number };
type MediaStatus = NonNullable<SearchResponse['media']>;
type MediaEmbedding = { id: string; digest: string; vector: Uint8Array };
const EmbeddingRow = z.object({
  kind: z.enum(['task', 'message']),
  id: z.string(),
  part: z.number(),
  digest: z.string(),
  vector: z.instanceof(Uint8Array),
});
const MediaStateRow = z.object({ id: z.string(), digest: z.string(), failed: z.number() });
const MediaEmbeddingRow = z.object({
  id: z.string(),
  digest: z.string(),
  vector: z.instanceof(Uint8Array),
});

async function ollamaEmbed({ input, url, signal }: Parameters<Embed>[0]) {
  const response = await fetch(new URL('/api/embed', url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input, dimensions, truncate: false, keep_alive: '10m' }),
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
  });
  if (!response.ok) throw new Error('Local search model unavailable');
  return z
    .object({ embeddings: z.array(z.array(z.number().finite()).length(dimensions)) })
    .parse(await response.json()).embeddings;
}

async function ollamaMediaEmbed({ input, url, signal }: Parameters<MediaEmbed>[0]) {
  const response = await fetch(new URL('/api/embed', url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: mediaModel,
      input,
      dimensions,
      truncate: false,
      keep_alive: '10m',
    }),
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
  });
  if (!response.ok) throw new Error('Local media search model unavailable');
  return z
    .object({ embeddings: z.array(z.array(z.number().finite()).length(dimensions)) })
    .parse(await response.json()).embeddings;
}

function documents(snapshot: Pick<Snapshot, 'tasks' | 'messages'>): Document[] {
  return [
    ...snapshot.tasks.map((task): Document => ({
      kind: 'task',
      id: task.id,
      title: task.title,
      text: [
        task.reference,
        task.title,
        task.scope,
        task.note,
        task.own_remark,
        ...task.action_steps,
        ...task.done_when,
        ...task.merged_from.flatMap((item) => [
          item.reference,
          item.title,
          item.note,
          item.own_remark,
        ]),
      ].join('\n'),
    })),
    ...snapshot.messages
      .map((message): Document => ({
        kind: 'message',
        id: message.id,
        title: 'Conversation message',
        text: [
          message.body,
          ...(message.image_reading?.observations ?? []),
          ...(message.image_reading?.uncertainties ?? []),
        ]
          .filter(Boolean)
          .join('\n'),
      }))
      .filter((item) => item.text.trim()),
  ];
}
function key(part: Pick<Part, 'kind' | 'id' | 'index'>) {
  return JSON.stringify([part.kind, part.id, part.index]);
}
function partsFor(docs: Document[], url: string): Part[] {
  return docs.flatMap((doc) => {
    const chunks = doc.text.match(new RegExp(`[\\s\\S]{1,${chunkLength}}`, 'g')) ?? [];
    return chunks.map((chunk, index) => {
      const prompt = `title: ${doc.title.slice(0, 200)} | text: ${chunk}`;
      const digest = createHash('sha256')
        .update(JSON.stringify([model, dimensions, url, prompt]))
        .digest('hex');
      return { ...doc, index, prompt, digest };
    });
  });
}
function normalize(values: number[]) {
  const norm = Math.hypot(...values);
  if (!norm || values.length !== dimensions || !Number.isFinite(norm))
    throw new Error('Invalid embedding');
  const out = Buffer.alloc(dimensions * 4);
  values.forEach((value, index) => out.writeFloatLE(value / norm, index * 4));
  return out;
}
function similarity(a: Uint8Array, b: Uint8Array) {
  const left = Buffer.from(a.buffer, a.byteOffset, a.byteLength);
  const right = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (left.length !== dimensions * 4 || right.length !== dimensions * 4) return 0;
  let score = 0;
  for (let i = 0; i < dimensions; i++) score += left.readFloatLE(i * 4) * right.readFloatLE(i * 4);
  return score;
}

export class LocalSearch {
  private indexJob: { controller: AbortController; generation: number } | null = null;
  private mediaJob: { controller: AbortController; generation: number } | null = null;
  private unavailable = false;
  private generation = 0;
  constructor(
    private db: DatabaseSync,
    private source: () => Pick<Snapshot, 'tasks' | 'messages'>,
    private embed: Embed = ollamaEmbed,
    private localUrl = process.env.LOCAL_SEARCH_OLLAMA_URL ?? 'http://127.0.0.1:11434',
    private mediaOptions?: MediaOptions,
  ) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS search_embeddings (
      kind TEXT NOT NULL, id TEXT NOT NULL, part INTEGER NOT NULL, digest TEXT NOT NULL,
      vector BLOB NOT NULL, PRIMARY KEY(kind,id,part));
      CREATE TABLE IF NOT EXISTS search_settings (id INTEGER PRIMARY KEY CHECK (id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS search_media_index (id TEXT PRIMARY KEY, digest TEXT NOT NULL, failed INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS search_media_embeddings (id TEXT NOT NULL, part INTEGER NOT NULL, digest TEXT NOT NULL,
        vector BLOB NOT NULL, PRIMARY KEY(id,part));`);
    SearchSettingsSchema.parse({ kind: 'server', url: this.localUrl });
  }
  settings(): SearchSettings {
    const row = this.db.prepare('SELECT value FROM search_settings WHERE id=1').get();
    return row
      ? SearchSettingsSchema.parse(JSON.parse(z.object({ value: z.string() }).parse(row).value))
      : { kind: 'workspace' };
  }
  saveSettings(value: unknown): SearchSettings {
    const next = SearchSettingsSchema.parse(value);
    if (JSON.stringify(next) !== JSON.stringify(this.settings())) {
      this.generation++;
      this.indexJob?.controller.abort();
      this.indexJob = null;
      this.mediaJob?.controller.abort();
      this.mediaJob = null;
      this.unavailable = false;
      this.db.prepare('DELETE FROM search_embeddings').run();
      this.db.exec('DELETE FROM search_media_index; DELETE FROM search_media_embeddings');
      this.db
        .prepare('INSERT OR REPLACE INTO search_settings(id,value) VALUES(1,?)')
        .run(JSON.stringify(next));
    }
    return next;
  }
  private url() {
    const settings = this.settings();
    return settings.kind === 'workspace' ? this.localUrl : settings.url;
  }
  private rows() {
    return this.db
      .prepare('SELECT kind,id,part,digest,vector FROM search_embeddings')
      .all()
      .map((row) => EmbeddingRow.parse(row));
  }
  private startIndex(parts: Part[], url: string) {
    const job = { controller: new AbortController(), generation: this.generation };
    this.indexJob = job;
    void (async () => {
      try {
        const insert = this.db.prepare(
          `INSERT OR REPLACE INTO search_embeddings(kind,id,part,digest,vector) VALUES(?,?,?,?,?)`,
        );
        for (let offset = 0; offset < parts.length; offset += 8) {
          if (job.controller.signal.aborted) return;
          const batch = parts.slice(offset, offset + 8);
          const vectors = await this.embed({
            input: batch.map((part) => part.prompt),
            url,
            signal: job.controller.signal,
          });
          if (job.controller.signal.aborted || job.generation !== this.generation) return;
          if (vectors.length !== batch.length) throw new Error('Incomplete embeddings');
          for (const [index, part] of batch.entries()) {
            const vector = vectors[index];
            if (!vector) throw new Error('Missing embedding');
            insert.run(part.kind, part.id, part.index, part.digest, normalize(vector));
          }
        }
      } catch {
        if (!job.controller.signal.aborted && job.generation === this.generation)
          this.unavailable = true;
      } finally {
        if (this.indexJob === job) this.indexJob = null;
      }
    })();
  }
  private startMediaIndex(candidates: MediaCandidate[], url: string) {
    const options = this.mediaOptions;
    if (!options) return;
    const embed = options.embed ?? ollamaMediaEmbed;
    const job = { controller: new AbortController(), generation: this.generation };
    this.mediaJob = job;
    void (async () => {
      try {
        for (const candidate of candidates) {
          if (job.controller.signal.aborted) return;
          let vectors: Buffer[] = [];
          let failed = false;
          try {
            const attachment = await options.load(candidate.message);
            if (!attachment) throw new Error('Attachment unavailable');
            const parts = await options.prepare(attachment, candidate.kind, job.controller.signal);
            let batch: MediaInput[] = [];
            const flush = async () => {
              const result = await embed({ input: batch, url, signal: job.controller.signal });
              if (result.length !== batch.length) throw new Error('Incomplete media embeddings');
              vectors.push(...result.map(normalize));
              batch = [];
            };
            for await (const part of parts) {
              batch.push(part);
              if (batch.length === 4) await flush();
            }
            if (batch.length) await flush();
            if (!vectors.length) throw new Error('No searchable media');
          } catch {
            vectors = [];
            failed = true;
          }
          if (job.controller.signal.aborted || job.generation !== this.generation) return;
          this.db.exec('BEGIN');
          try {
            this.db
              .prepare('DELETE FROM search_media_embeddings WHERE id=?')
              .run(candidate.message.id);
            const insert = this.db.prepare('INSERT INTO search_media_embeddings VALUES(?,?,?,?)');
            for (const [index, vector] of vectors.entries())
              insert.run(candidate.message.id, index, candidate.digest, vector);
            this.db
              .prepare('INSERT OR REPLACE INTO search_media_index VALUES(?,?,?)')
              .run(candidate.message.id, candidate.digest, failed ? 1 : 0);
            this.db.exec('COMMIT');
          } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
          }
        }
      } finally {
        if (this.mediaJob === job) this.mediaJob = null;
      }
    })().catch(() => {
      if (this.mediaJob === job) this.mediaJob = null;
    });
  }
  private findMedia(
    messages: Message[],
    url: string,
    retry: boolean,
  ): { status: MediaStatus; rows: MediaEmbedding[] } | undefined {
    const options = this.mediaOptions;
    if (!options) return undefined;
    const candidates = messages.flatMap((message): MediaCandidate[] => {
      const kind = mediaKind(message.type);
      if (!kind) return [];
      const digest = createHash('sha256')
        .update(
          JSON.stringify([
            mediaModel,
            dimensions,
            url,
            message.id,
            message.type,
            message.image_digest,
            message.mediaMimetype,
            message.waMessageId,
          ]),
        )
        .digest('hex');
      return [{ message, kind, digest }];
    });
    const current = new Map(candidates.map((item) => [item.message.id, item.digest]));
    let states = this.db
      .prepare('SELECT id,digest,failed FROM search_media_index')
      .all()
      .map((row) => MediaStateRow.parse(row));
    for (const state of states) {
      if (current.get(state.id) !== state.digest || (retry && state.failed)) {
        this.db.prepare('DELETE FROM search_media_index WHERE id=?').run(state.id);
        this.db.prepare('DELETE FROM search_media_embeddings WHERE id=?').run(state.id);
      }
    }
    states = this.db
      .prepare('SELECT id,digest,failed FROM search_media_index')
      .all()
      .map((row) => MediaStateRow.parse(row));
    const complete = new Map(states.map((item) => [item.id, item]));
    const missing = candidates.filter(
      (item) => complete.get(item.message.id)?.digest !== item.digest,
    );
    if (missing.length && !this.mediaJob) this.startMediaIndex(missing, url);
    const indexed = states.filter(
      (item) => !item.failed && current.get(item.id) === item.digest,
    ).length;
    const total = candidates.length;
    const status: MediaStatus = {
      kind: this.mediaJob
        ? 'indexing'
        : states.some((item) => item.failed && current.get(item.id) === item.digest)
          ? 'unavailable'
          : 'ready',
      indexed,
      total,
    };
    const rows = this.db
      .prepare('SELECT id,digest,vector FROM search_media_embeddings')
      .all()
      .map((row) => MediaEmbeddingRow.parse(row))
      .filter((row) => current.get(row.id) === row.digest);
    return { status, rows };
  }
  async find(rawQuery: string, retry = false): Promise<SearchResponse> {
    const { query } = SearchRequestSchema.parse({ query: rawQuery, retry });
    if (retry) this.unavailable = false;
    const generation = this.generation;
    const url = this.url();
    const snapshot = this.source();
    const docs = documents(snapshot);
    const exact = docs.filter((doc) =>
      doc.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    );
    const moreExact = exact.length > 50;
    const exactKeys = new Set(exact.map((doc) => JSON.stringify([doc.kind, doc.id])));
    const exactResults = exact
      .slice(0, 50)
      .map(({ kind, id }) => ({ kind, id, match: 'exact' as const }));
    const media = this.findMedia(snapshot.messages, url, retry);
    const mediaField = media ? { media: media.status } : {};
    const matches = new Map<string, Scored>();
    const relatedResults = () =>
      [...matches.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, 20)
        .map(({ kind, id }) => ({ kind, id, match: 'related' as const }));
    if (generation !== this.generation)
      return { moreExact, results: exactResults, status: { kind: 'unavailable' }, ...mediaField };
    const parts = partsFor(docs, url);
    const current = new Map(parts.map((part) => [key(part), part]));
    let rows = this.rows();
    const remove = this.db.prepare(
      'DELETE FROM search_embeddings WHERE kind=? AND id=? AND part=?',
    );
    for (const row of rows) {
      if (current.get(key({ ...row, index: row.part }))?.digest !== row.digest)
        remove.run(row.kind, row.id, row.part);
    }
    rows = this.rows();
    const indexed = new Set(rows.map((row) => key({ ...row, index: row.part })));
    const missing = parts.filter((part) => !indexed.has(key(part)));
    if (missing.length && !this.indexJob && !this.unavailable) this.startIndex(missing, url);
    if (this.indexJob)
      return {
        moreExact,
        results: [...exactResults, ...relatedResults()],
        status: { kind: 'indexing', indexed: parts.length - missing.length, total: parts.length },
        ...mediaField,
      };
    if (this.unavailable)
      return {
        moreExact,
        results: [...exactResults, ...relatedResults()],
        status: { kind: 'unavailable' },
        ...mediaField,
      };
    if (!rows.length && !media?.rows.length)
      return {
        moreExact,
        results: [...exactResults, ...relatedResults()],
        status: { kind: 'ready' },
        ...mediaField,
      };
    try {
      const vectors = await this.embed({
        input: [`task: search result | query: ${query}`],
        url,
        signal: new AbortController().signal,
      });
      if (generation !== this.generation || !vectors[0])
        return { moreExact, results: exactResults, status: { kind: 'unavailable' }, ...mediaField };
      const queryVector = normalize(vectors[0]);
      for (const row of media?.rows ?? []) {
        const id = JSON.stringify(['message', row.id]);
        if (exactKeys.has(id)) continue;
        const score = similarity(row.vector, queryVector);
        if (score >= minSimilarity && score > (matches.get(id)?.score ?? -1))
          matches.set(id, { kind: 'message', id: row.id, score });
      }
      for (const row of rows) {
        const id = JSON.stringify([row.kind, row.id]);
        if (exactKeys.has(id)) continue;
        const score = similarity(row.vector, queryVector);
        if (score >= minSimilarity && score > (matches.get(id)?.score ?? -1))
          matches.set(id, { kind: row.kind, id: row.id, score });
      }
      return {
        moreExact,
        results: [...exactResults, ...relatedResults()],
        status: { kind: 'ready' },
        ...mediaField,
      };
    } catch {
      if (generation === this.generation) this.unavailable = true;
      return {
        moreExact,
        results: [...exactResults, ...relatedResults()],
        status: { kind: 'unavailable' },
        ...mediaField,
      };
    }
  }
}
