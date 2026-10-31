import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Snapshot } from '../shared/schema.js';
import {
  SearchRequestSchema,
  SearchSettingsSchema,
  type SearchResponse,
  type SearchSettings,
} from '../shared/search.js';

const model = 'embeddinggemma-2:270m-q8_0-text';
const dimensions = 256;
const minSimilarity = 0.7;
const chunkLength = 1000;
type Document = { kind: 'task' | 'message'; id: string; title: string; text: string };
type Part = Document & { index: number; digest: string; prompt: string };
type Embed = (args: { input: string[]; url: string; signal: AbortSignal }) => Promise<number[][]>;
const EmbeddingRow = z.object({
  kind: z.enum(['task', 'message']),
  id: z.string(),
  part: z.number(),
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
  private unavailable = false;
  private generation = 0;
  constructor(
    private db: DatabaseSync,
    private source: () => Pick<Snapshot, 'tasks' | 'messages'>,
    private embed: Embed = ollamaEmbed,
    private localUrl = process.env.LOCAL_SEARCH_OLLAMA_URL ?? 'http://127.0.0.1:11434',
  ) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS search_embeddings (
      kind TEXT NOT NULL, id TEXT NOT NULL, part INTEGER NOT NULL, digest TEXT NOT NULL,
      vector BLOB NOT NULL, PRIMARY KEY(kind,id,part));
      CREATE TABLE IF NOT EXISTS search_settings (id INTEGER PRIMARY KEY CHECK (id=1), value TEXT NOT NULL);`);
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
      this.unavailable = false;
      this.db.prepare('DELETE FROM search_embeddings').run();
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
  async find(rawQuery: string, retry = false): Promise<SearchResponse> {
    const { query } = SearchRequestSchema.parse({ query: rawQuery, retry });
    if (retry) this.unavailable = false;
    const docs = documents(this.source());
    const exact = docs.filter((doc) =>
      doc.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    );
    const moreExact = exact.length > 50;
    const exactKeys = new Set(exact.map((doc) => JSON.stringify([doc.kind, doc.id])));
    const exactResults = exact
      .slice(0, 50)
      .map(({ kind, id }) => ({ kind, id, match: 'exact' as const }));
    const parts = partsFor(docs, this.url());
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
    if (missing.length && !this.indexJob && !this.unavailable) this.startIndex(missing, this.url());
    if (this.indexJob)
      return {
        moreExact,
        results: exactResults,
        status: { kind: 'indexing', indexed: parts.length - missing.length, total: parts.length },
      };
    if (this.unavailable)
      return { moreExact, results: exactResults, status: { kind: 'unavailable' } };
    if (!rows.length) return { moreExact, results: exactResults, status: { kind: 'ready' } };
    const generation = this.generation;
    try {
      const vectors = await this.embed({
        input: [`task: search result | query: ${query}`],
        url: this.url(),
        signal: new AbortController().signal,
      });
      if (generation !== this.generation || !vectors[0])
        return { moreExact, results: exactResults, status: { kind: 'unavailable' } };
      const queryVector = normalize(vectors[0]);
      const matches = new Map<string, { kind: 'task' | 'message'; id: string; score: number }>();
      for (const row of rows) {
        const id = JSON.stringify([row.kind, row.id]);
        if (exactKeys.has(id)) continue;
        const score = similarity(row.vector, queryVector);
        if (score >= minSimilarity && score > (matches.get(id)?.score ?? -1))
          matches.set(id, { kind: row.kind, id: row.id, score });
      }
      const related = [...matches.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, 20)
        .map(({ kind, id }) => ({ kind, id, match: 'related' as const }));
      return { moreExact, results: [...exactResults, ...related], status: { kind: 'ready' } };
    } catch {
      if (generation === this.generation) this.unavailable = true;
      return { moreExact, results: exactResults, status: { kind: 'unavailable' } };
    }
  }
}
