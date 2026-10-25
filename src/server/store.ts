import { DatabaseSync } from 'node:sqlite';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  MessageSchema,
  TaskSchema,
  TaskTriageUpdateSchema,
  SettingsSchema,
  StatusSchema,
  QuestionSchema,
  type Message,
  type TaskChange,
  type Decision,
  type SettingsUpdate,
  type Status,
  type Settings,
} from '../shared/schema.js';

export const now = () => Date.now() / 1000;
export const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const fingerprint = (message: Message) => {
  return hash({
    id: message.id,
    sessionId: message.sessionId,
    chatId: message.chatId,
    waMessageId: message.waMessageId ?? null,
    body: message.body,
    type: message.type,
    direction: message.direction,
    timestamp: message.timestamp,
    reply_to_wa_id: message.reply_to_wa_id ?? null,
    reply_to_id: message.reply_to_id ?? null,
    reply_quote: message.reply_quote ?? null,
    mediaMimetype: message.mediaMimetype ?? null,
    image_digest: message.image_digest ?? null,
    entity_link: message.entity_link ?? null,
    ...(message.browser_source ? { browser_source: message.browser_source } : {}),
  });
};
const PayloadRow = z.object({ payload: z.string() });
const ValueRow = z.object({ value: z.string() });
const IdRow = z.object({ id: z.string() });
const RefRow = z.object({ message_id: z.string() });
const SeenRow = z.object({ id: z.string(), digest: z.string() });
const legacySchema = z.object({
  session_id: z.string().optional(),
  chat_id: z.string().optional(),
  openwa_api_url: z.string().optional(),
  openwa_api_key_file: z.string().optional(),
  model: z.string().optional(),
});

export class TaskTriageError extends Error {}

export class Store {
  readonly db: DatabaseSync;
  readonly key: Buffer;
  constructor(
    readonly dir: string,
    legacyConfig = 'config.json',
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const keyPath = join(dir, 'vault.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32)
      throw new Error('The vault key is invalid. Restore data/vault.key from your backup.');
    this.db = new DatabaseSync(join(dir, 'tasks.sqlite'));
    chmodSync(join(dir, 'tasks.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,scope TEXT NOT NULL,note TEXT NOT NULL,created REAL NOT NULL,updated REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS task_references(number INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE);
      CREATE TRIGGER IF NOT EXISTS assign_task_reference AFTER INSERT ON tasks BEGIN
        INSERT INTO task_references(task_id) VALUES(NEW.id);
      END;
      CREATE TABLE IF NOT EXISTS completion(task_id TEXT PRIMARY KEY REFERENCES tasks(id),done INTEGER NOT NULL,updated REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources(task_id TEXT NOT NULL REFERENCES tasks(id),message_id TEXT NOT NULL REFERENCES messages(id),PRIMARY KEY(task_id,message_id));
      CREATE TABLE IF NOT EXISTS processed(id TEXT PRIMARY KEY,digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS triage(task_id TEXT PRIMARY KEY REFERENCES tasks(id),payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS image_readings(message_id TEXT PRIMARY KEY,image_digest TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS completion_history(task_id TEXT,done INTEGER,changed REAL);
      CREATE TABLE IF NOT EXISTS task_remarks(task_id TEXT PRIMARY KEY REFERENCES tasks(id),remark TEXT NOT NULL,updated REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS completion_seen(message_id TEXT PRIMARY KEY,digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS completion_questions(id TEXT PRIMARY KEY,message_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS completion_events(id INTEGER PRIMARY KEY,task_id TEXT NOT NULL,message_id TEXT,kind TEXT NOT NULL,reason TEXT,created REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_usage(id INTEGER PRIMARY KEY,started REAL NOT NULL,finished REAL NOT NULL,model TEXT NOT NULL,purpose TEXT NOT NULL,input_tokens INTEGER,cached_input_tokens INTEGER,output_tokens INTEGER,reasoning_output_tokens INTEGER,total_tokens INTEGER,outcome TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_settings(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_secrets(id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS webhook_events(id TEXT PRIMARY KEY,received REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_jobs(chat_id TEXT PRIMARY KEY,due REAL NOT NULL,first REAL NOT NULL,generation INTEGER NOT NULL,reconcile INTEGER NOT NULL,manual INTEGER NOT NULL DEFAULT 0);`);
    this.transaction(() =>
      this.db.exec(`
      INSERT INTO task_references(task_id)
      SELECT t.id FROM tasks t LEFT JOIN task_references ref ON ref.task_id=t.id
      WHERE ref.task_id IS NULL ORDER BY t.created,t.id;
    `),
    );
    if (
      !this.db
        .prepare('PRAGMA table_info(chat_jobs)')
        .all()
        .some((row) => row.name === 'manual')
    )
      this.db.exec('ALTER TABLE chat_jobs ADD COLUMN manual INTEGER NOT NULL DEFAULT 0');
    if (!this.db.prepare('SELECT id FROM app_settings WHERE id=1').get()) {
      const legacy = existsSync(legacyConfig)
        ? legacySchema.parse(JSON.parse(readFileSync(legacyConfig, 'utf8')))
        : {};
      this.saveSettings({
        settings: {
          openwaUrl: legacy.openwa_api_url ?? '',
          chats:
            legacy.session_id && legacy.chat_id
              ? [
                  {
                    id: hash([legacy.session_id, legacy.chat_id]),
                    name: 'Imported conversation',
                    sessionId: legacy.session_id,
                    chatId: legacy.chat_id,
                    enabled: true,
                  },
                ]
              : [],
          profiles: [
            { id: 'codex', name: 'Codex', kind: 'codex', model: legacy.model ?? 'gpt-6-luna' },
          ],
          activeProfileId: 'codex',
          webhookUrl: '',
          quietSeconds: 45,
          trigger: { mode: 'automatic', decisionProfileId: 'codex' },
        },
        secrets: {},
        removeSecrets: [],
      });
      if (legacy.openwa_api_key_file) {
        const path = resolve(legacy.openwa_api_key_file);
        if (existsSync(path)) this.putSecret('openwa', readFileSync(path, 'utf8').trim());
      }
      const cursor = this.metaValue('source_cursor');
      if (cursor && legacy.session_id && legacy.chat_id)
        this.setMeta('cursor:' + hash([legacy.session_id, legacy.chat_id]), cursor);
    }
    if (this.metaValue('source_fingerprint_version') !== 2)
      this.transaction(() => {
        const legacy = !this.metaValue('typescript_migrated');
        for (const m of this.messages()) {
          const { image_reading: _reading, ...source } = m;
          for (const [table, key] of [
            ['processed', 'id'],
            ['completion_seen', 'message_id'],
          ]) {
            const row = this.db.prepare(`SELECT digest FROM ${table} WHERE ${key}=?`).get(m.id);
            // Preserve pending edits when upgrading an already-running TypeScript workspace.
            if (row && (legacy || row.digest === hash(source)))
              this.db
                .prepare(`UPDATE ${table} SET digest=? WHERE ${key}=?`)
                .run(fingerprint(m), m.id);
          }
        }
        this.setMeta('typescript_migrated', true);
        this.setMeta('source_fingerprint_version', 2);
      });
    if (!this.metaValue('auto_completion_since')) this.setMeta('auto_completion_since', now());
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  metaValue(key: string): unknown {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return row ? JSON.parse(ValueRow.parse(row).value) : undefined;
  }
  setMeta(key: string, value: unknown) {
    this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key, JSON.stringify(value));
  }
  status(values?: Partial<Status>): Status {
    const old = StatusSchema.parse(this.metaValue('app_status') ?? {});
    if (!values) return old;
    const next = { ...old, ...values };
    this.setMeta('app_status', next);
    return next;
  }
  settings(): Settings {
    return SettingsSchema.parse(
      JSON.parse(
        PayloadRow.parse(this.db.prepare('SELECT payload FROM app_settings WHERE id=1').get())
          .payload,
      ),
    );
  }
  publicSettings() {
    return {
      settings: this.settings(),
      configuredSecrets: this.db
        .prepare('SELECT id FROM app_secrets')
        .all()
        .map((r) => IdRow.parse(r).id)
        .filter((id) => id !== 'webhook-signing'),
      webhook: {
        registeredSessions:
          this.settings().webhookUrl === this.metaValue('registered_webhook_url')
            ? Object.keys(
                z.record(z.string(), z.string()).parse(this.metaValue('managed_webhooks') ?? {}),
              ).length
            : 0,
        lastReceivedAt: this.status().last_webhook ?? null,
      },
    };
  }
  secret(id: string) {
    const row = this.db.prepare('SELECT value FROM app_secrets WHERE id=?').get(id);
    if (!row) return '';
    const [iv, tag, content] = ValueRow.parse(row).value.split('.');
    if (!iv || !tag || !content) throw new Error('Could not unlock a stored key');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(content, 'base64')),
      decipher.final(),
    ]).toString();
  }
  private putSecret(id: string, value: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const content = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    this.db
      .prepare('INSERT OR REPLACE INTO app_secrets VALUES(?,?)')
      .run(id, [iv, cipher.getAuthTag(), content].map((b) => b.toString('base64')).join('.'));
  }
  webhookSecret() {
    const existing = this.secret('webhook-signing');
    if (existing) return existing;
    const value = randomBytes(32).toString('hex');
    this.putSecret('webhook-signing', value);
    return value;
  }
  queueChat(id: string, delay: number, reconcile = true, manual = false) {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO chat_jobs VALUES(?,?,?,1,?,?) ON CONFLICT(chat_id) DO UPDATE SET due=min(excluded.due,chat_jobs.first+180),generation=chat_jobs.generation+1,reconcile=max(chat_jobs.reconcile,excluded.reconcile),manual=excluded.manual`,
      )
      .run(id, timestamp + delay, timestamp, Number(reconcile), Number(manual));
  }
  jobs() {
    return this.db
      .prepare('SELECT * FROM chat_jobs ORDER BY due')
      .all()
      .map((row) =>
        z
          .object({
            chat_id: z.string(),
            due: z.number(),
            first: z.number(),
            generation: z.number(),
            reconcile: z.number(),
            manual: z.number(),
          })
          .parse(row),
      );
  }
  saveSettings(update: SettingsUpdate) {
    const allowed = new Set([
      'openwa',
      ...update.settings.profiles.flatMap((p) => [p.id + ':key', p.id + ':gateway']),
    ]);
    if ([...Object.keys(update.secrets), ...update.removeSecrets].some((id) => !allowed.has(id)))
      throw new Error('Unknown credential slot');
    this.transaction(() => {
      this.db
        .prepare('INSERT OR REPLACE INTO app_settings VALUES(1,?)')
        .run(JSON.stringify(update.settings));
      for (const [id, value] of Object.entries(update.secrets))
        if (value.trim()) this.putSecret(id, value.trim());
      for (const id of update.removeSecrets)
        this.db.prepare('DELETE FROM app_secrets WHERE id=?').run(id);
      for (const r of this.db.prepare('SELECT id FROM app_secrets').all()) {
        const { id } = IdRow.parse(r);
        if (!allowed.has(id) && id !== 'webhook-signing')
          this.db.prepare('DELETE FROM app_secrets WHERE id=?').run(id);
      }
    });
  }
  messages(): Message[] {
    return this.db
      .prepare('SELECT payload FROM messages')
      .all()
      .map((r) => MessageSchema.parse(JSON.parse(PayloadRow.parse(r).payload)))
      .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  }
  cache(messages: Message[]) {
    this.transaction(() => {
      for (const m of messages)
        this.db.prepare('INSERT OR REPLACE INTO messages VALUES(?,?)').run(m.id, JSON.stringify(m));
    });
  }
  pending(messages: Message[]) {
    const seen = new Map(
      this.db
        .prepare('SELECT id,digest FROM processed')
        .all()
        .map((r) => {
          const s = SeenRow.parse(r);
          return [s.id, s.digest];
        }),
    );
    return messages.filter((m) => seen.get(m.id) !== fingerprint(m));
  }
  apply(changes: TaskChange[], batch: Message[], context: Message[] = []) {
    const messages = new Map([...batch, ...context].map((m) => [m.id, m]));
    if (changes.length > 40) throw new Error('Task batch is too large');
    return this.transaction(() => {
      let added = 0;
      for (const t of changes) {
        const sources = t.source_ids.map((id) => messages.get(id));
        const first = sources[0];
        if (
          !first ||
          sources.some((m) => !m || m.chatId !== first.chatId || m.sessionId !== first.sessionId)
        )
          throw new Error('A task must cite evidence from one supplied conversation');
        const identity =
          t.id ??
          hash([
            first.sessionId,
            first.chatId,
            [...t.source_ids].sort()[0],
            t.title.toLocaleLowerCase(),
          ]);
        const existing = this.db.prepare('SELECT id FROM tasks WHERE id=?').get(identity);
        if (t.id && !existing) throw new Error('Unknown task ID');
        if (existing && !this.taskInChat(identity, first))
          throw new Error('Cannot update a task from another conversation');
        const timestamp = now();
        this.db
          .prepare(
            'INSERT INTO tasks VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,scope=excluded.scope,note=excluded.note,updated=excluded.updated',
          )
          .run(identity, t.title, t.scope, t.note, timestamp, timestamp);
        for (const id of t.source_ids)
          this.db.prepare('INSERT OR IGNORE INTO sources VALUES(?,?)').run(identity, id);
        const { action_steps, done_when, priority, triage_state, blocking_question } = t;
        this.db
          .prepare('INSERT OR REPLACE INTO triage VALUES(?,?)')
          .run(
            identity,
            JSON.stringify({ action_steps, done_when, priority, triage_state, blocking_question }),
          );
        if (!existing) added++;
      }
      for (const m of batch)
        this.db.prepare('INSERT OR REPLACE INTO processed VALUES(?,?)').run(m.id, fingerprint(m));
      return added;
    });
  }
  private taskInChat(id: string, message: Message) {
    const sources = this.db
      .prepare(
        'SELECT m.payload FROM sources s JOIN messages m ON m.id=s.message_id WHERE s.task_id=?',
      )
      .all(id)
      .map((r) => MessageSchema.parse(JSON.parse(PayloadRow.parse(r).payload)));
    return (
      sources.length > 0 &&
      sources.every((m) => m.sessionId === message.sessionId && m.chatId === message.chatId)
    );
  }
  taskEvidence(id: string) {
    const snapshot = this.snapshot();
    const task = snapshot.tasks.find(
      (item) => item.id === id || item.reference === id.toUpperCase(),
    );
    if (!task) throw new TaskTriageError('Task not found');
    const messages = snapshot.messages.filter((message) => task.source_ids.includes(message.id));
    return { task, messages, revision: hash({ task, messages }) };
  }
  triageTask(input: z.infer<typeof TaskTriageUpdateSchema>) {
    const update = TaskTriageUpdateSchema.parse(input);
    return this.transaction(() => {
      const current = this.taskEvidence(update.id);
      if (current.revision !== update.expected_revision)
        throw new TaskTriageError(
          'Task or source evidence changed. Read the task again before triage.',
        );
      this.db
        .prepare('UPDATE tasks SET title=?,scope=?,note=?,updated=? WHERE id=?')
        .run(update.title, update.scope, update.note, now(), current.task.id);
      const { action_steps, done_when, priority, triage_state, blocking_question } = update;
      this.db
        .prepare('INSERT OR REPLACE INTO triage VALUES(?,?)')
        .run(
          current.task.id,
          JSON.stringify({ action_steps, done_when, priority, triage_state, blocking_question }),
        );
      return this.taskEvidence(current.task.id);
    });
  }
  tick(id: string, done: boolean) {
    if (!this.db.prepare('SELECT id FROM tasks WHERE id=?').get(id))
      throw new Error('Task not found');
    const timestamp = now();
    this.db
      .prepare('INSERT OR REPLACE INTO completion VALUES(?,?,?)')
      .run(id, Number(done), timestamp);
    this.db
      .prepare('INSERT INTO completion_history VALUES(?,?,?)')
      .run(id, Number(done), timestamp);
  }
  remark(id: string, remark: string) {
    if (!this.db.prepare('SELECT id FROM tasks WHERE id=?').get(id))
      throw new Error('Task not found');
    this.db.prepare('INSERT OR REPLACE INTO task_remarks VALUES(?,?,?)').run(id, remark, now());
  }
  pendingReplies(messages: Message[]) {
    const since = z.number().parse(this.metaValue('auto_completion_since'));
    return messages.filter((m) => {
      const row = this.db
        .prepare('SELECT digest FROM completion_seen WHERE message_id=?')
        .get(m.id);
      return (
        m.direction === 'outgoing' &&
        m.timestamp >= since &&
        (!row || z.object({ digest: z.string() }).parse(row).digest !== fingerprint(m))
      );
    });
  }
  decide(decisions: Decision[], batch: Message[], started: number) {
    if (
      decisions.length !== batch.length ||
      new Set(decisions.map((d) => d.message_id)).size !== batch.length
    )
      throw new Error('Decisions must cover every supplied reply exactly once');
    this.transaction(() => {
      for (const d of decisions) {
        const m = batch.find((m) => m.id === d.message_id);
        if (!m || m.direction !== 'outgoing')
          throw new Error('Only your outgoing reply can complete a task');
        if (
          new Set(d.task_ids).size !== d.task_ids.length ||
          d.task_ids.some((id) => !this.taskInChat(id, m))
        )
          throw new Error('Completion cannot cross conversations');
        if (
          d.action === 'complete' &&
          (d.task_ids.length !== 1 || !d.evidence_quote || !m.body.includes(d.evidence_quote))
        )
          throw new Error('Completion needs one task and exact evidence from your reply');
        if (d.action === 'ask' && !d.question?.trim())
          throw new Error('Ambiguous completion needs a question');
      }
      for (const d of decisions) {
        const m = batch.find((m) => m.id === d.message_id);
        if (!m) throw new Error('Missing reply');
        const row = this.db
          .prepare('SELECT digest FROM completion_seen WHERE message_id=?')
          .get(m.id);
        if (row && z.object({ digest: z.string() }).parse(row).digest === fingerprint(m)) continue;
        this.db
          .prepare(
            "UPDATE completion_questions SET status='superseded' WHERE message_id=? AND status='pending'",
          )
          .run(m.id);
        let decision = d;
        const id = d.task_ids[0];
        const prior = this.db
          .prepare('SELECT id FROM completion_events WHERE message_id=?')
          .get(m.id);
        if (d.action === 'complete' && id) {
          const changed = this.db.prepare('SELECT updated FROM completion WHERE task_id=?').get(id);
          if (
            prior ||
            (changed &&
              z.object({ updated: z.number() }).parse(changed).updated >
                Math.min(started, m.timestamp))
          )
            decision = {
              ...d,
              action: 'ask',
              question: 'You changed this task after the reply. Mark it complete now?',
            };
          else this.completeFromReply(id, m.id, 'auto', d.reason);
        } else if (prior)
          decision = {
            ...d,
            action: 'ask',
            question: 'This completion reply was edited. Should its task remain completed?',
          };
        if (decision.action === 'ask')
          this.db
            .prepare('INSERT OR REPLACE INTO completion_questions VALUES(?,?,?,?)')
            .run(hash([m.id, hash(m)]), m.id, JSON.stringify(decision), 'pending');
        this.db
          .prepare('INSERT OR REPLACE INTO completion_seen VALUES(?,?)')
          .run(m.id, fingerprint(m));
      }
    });
  }
  private completeFromReply(id: string, mid: string, kind: string, reason: string) {
    this.tick(id, true);
    const timestamp = now();
    this.db
      .prepare(
        'INSERT INTO completion_events(task_id,message_id,kind,reason,created) VALUES(?,?,?,?,?)',
      )
      .run(id, mid, kind, reason, timestamp);
    this.db.prepare('INSERT OR IGNORE INTO sources VALUES(?,?)').run(id, mid);
  }
  resolve(id: string, taskId: string | null) {
    this.transaction(() => {
      const row = this.db
        .prepare("SELECT message_id FROM completion_questions WHERE id=? AND status='pending'")
        .get(id);
      if (!row) throw new Error('Question already resolved');
      const mid = RefRow.parse(row).message_id,
        m = this.messages().find((m) => m.id === mid);
      if (taskId) {
        if (!m || !this.taskInChat(taskId, m))
          throw new Error('Choose a task in this conversation');
        this.completeFromReply(taskId, mid, 'confirmed', 'You confirmed the completion');
      }
      this.db.prepare("UPDATE completion_questions SET status='resolved' WHERE id=?").run(id);
    });
  }
  snapshot() {
    const messages = this.messages().map((m) => {
      const row = this.db
        .prepare('SELECT image_digest,payload FROM image_readings WHERE message_id=?')
        .get(m.id);
      if (!row) return m;
      const reading = z.object({ image_digest: z.string(), payload: z.string() }).parse(row);
      return reading.image_digest === m.image_digest
        ? MessageSchema.parse({ ...m, image_reading: JSON.parse(reading.payload) })
        : m;
    });
    const tasks = this.db
      .prepare(
        "SELECT t.*,'TODO-' || printf('%03d',ref.number) reference,coalesce(c.done,0) done,coalesce(r.remark,'') own_remark FROM tasks t JOIN task_references ref ON ref.task_id=t.id LEFT JOIN completion c ON c.task_id=t.id LEFT JOIN task_remarks r ON r.task_id=t.id ORDER BY t.created,t.id",
      )
      .all()
      .map((row) => {
        const id = IdRow.parse(row).id,
          triage = this.db.prepare('SELECT payload FROM triage WHERE task_id=?').get(id);
        const detail: unknown = triage ? JSON.parse(PayloadRow.parse(triage).payload) : {};
        return TaskSchema.parse({
          ...row,
          ...z.record(z.string(), z.unknown()).parse(detail),
          done: Boolean(row.done),
          source_ids: this.db
            .prepare('SELECT message_id FROM sources WHERE task_id=?')
            .all(id)
            .map((r) => RefRow.parse(r).message_id),
        });
      });
    const questions = this.db
      .prepare("SELECT id,payload FROM completion_questions WHERE status='pending'")
      .all()
      .map((r) =>
        QuestionSchema.parse({ ...JSON.parse(PayloadRow.parse(r).payload), id: IdRow.parse(r).id }),
      );
    const usage = z
      .object({ calls: z.number(), totalTokens: z.number() })
      .parse(
        this.db
          .prepare('SELECT count(*) calls, coalesce(sum(total_tokens),0) totalTokens FROM ai_usage')
          .get(),
      );
    return {
      demo: this.metaValue('demo') === true,
      tasks,
      messages,
      questions,
      status: this.status(),
      usage: {
        ...usage,
        model:
          this.settings().profiles.find((p) => p.id === this.settings().activeProfileId)?.model ??
          '',
      },
    };
  }
}
