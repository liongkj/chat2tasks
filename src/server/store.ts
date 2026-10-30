import { DatabaseSync } from 'node:sqlite';
import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { matchesTaskIdentifier } from '../shared/tasks.js';
import {
  MessageSchema,
  ItemKindSchema,
  GtdSchema,
  WaitInputSchema,
  WaitSchema,
  WaitStateSchema,
  TaskSchema,
  TaskTriageUpdateSchema,
  TaskMergeSchema,
  DecisionSchema,
  SettingsSchema,
  StatusSchema,
  QuestionSchema,
  type Message,
  type ItemKind,
  type Gtd,
  type GtdInput,
  type WaitInput,
  type WaitChange,
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
function nextOccurrence(recurrence: NonNullable<Gtd['recurrence']>) {
  const [year, month, day] = recurrence.next_date.split('-').map(Number);
  const [anchorYear, anchorMonth, anchorDay] = recurrence.anchor_date.split('-').map(Number);
  if (!year || !month || !day || !anchorYear || !anchorMonth || !anchorDay)
    throw new Error('A recurring item needs valid dates');
  let date: Date;
  if (recurrence.frequency === 'daily' || recurrence.frequency === 'weekly')
    date = new Date(Date.UTC(year, month - 1, day + (recurrence.frequency === 'daily' ? 1 : 7)));
  else {
    const targetYear = recurrence.frequency === 'yearly' ? year + 1 : year + Math.floor(month / 12);
    const targetMonth = recurrence.frequency === 'yearly' ? anchorMonth : (month % 12) + 1;
    const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
    date = new Date(Date.UTC(targetYear, targetMonth - 1, Math.min(anchorDay, lastDay)));
  }
  return date.toISOString().slice(0, 10);
}

export class TaskTriageError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

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
      CREATE TABLE IF NOT EXISTS task_merges(source_id TEXT PRIMARY KEY REFERENCES tasks(id),target_id TEXT NOT NULL REFERENCES tasks(id),created REAL NOT NULL,source_ids TEXT NOT NULL,CHECK(source_id<>target_id));
      CREATE INDEX IF NOT EXISTS task_merges_target ON task_merges(target_id);
      CREATE TRIGGER IF NOT EXISTS assign_task_reference AFTER INSERT ON tasks BEGIN
        INSERT INTO task_references(task_id) VALUES(NEW.id);
      END;
      CREATE TABLE IF NOT EXISTS completion(task_id TEXT PRIMARY KEY REFERENCES tasks(id),done INTEGER NOT NULL,updated REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources(task_id TEXT NOT NULL REFERENCES tasks(id),message_id TEXT NOT NULL REFERENCES messages(id),PRIMARY KEY(task_id,message_id));
      CREATE TABLE IF NOT EXISTS processed(id TEXT PRIMARY KEY,digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS triage(task_id TEXT PRIMARY KEY REFERENCES tasks(id),payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS item_kinds(task_id TEXT PRIMARY KEY REFERENCES tasks(id),kind TEXT NOT NULL CHECK(kind IN ('task','action','question','reminder','event','reference')),manual INTEGER NOT NULL CHECK(manual IN (0,1)),suggestion TEXT CHECK(suggestion IS NULL OR suggestion IN ('task','action','question','reminder','event','reference')));
      CREATE TABLE IF NOT EXISTS waiting_for(id TEXT PRIMARY KEY,expected TEXT NOT NULL,person TEXT,task_id TEXT REFERENCES tasks(id),state TEXT NOT NULL CHECK(state IN ('waiting','received','dismissed')),response_id TEXT REFERENCES messages(id),created REAL NOT NULL,updated REAL NOT NULL,manual_state INTEGER NOT NULL DEFAULT 0 CHECK(manual_state IN (0,1)),needs_review INTEGER NOT NULL DEFAULT 0 CHECK(needs_review IN (0,1)));
      CREATE TABLE IF NOT EXISTS waiting_sources(wait_id TEXT NOT NULL REFERENCES waiting_for(id),message_id TEXT NOT NULL REFERENCES messages(id),PRIMARY KEY(wait_id,message_id));
      CREATE TABLE IF NOT EXISTS rejected_wait_responses(wait_id TEXT NOT NULL REFERENCES waiting_for(id),message_id TEXT NOT NULL REFERENCES messages(id),digest TEXT NOT NULL,PRIMARY KEY(wait_id,message_id));
      CREATE TABLE IF NOT EXISTS item_gtd(task_id TEXT PRIMARY KEY REFERENCES tasks(id),payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS item_occurrences(task_id TEXT NOT NULL REFERENCES tasks(id),date TEXT NOT NULL,completed REAL NOT NULL,PRIMARY KEY(task_id,date));
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
    const kindsDefinition = z
      .object({ sql: z.string() })
      .parse(
        this.db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='item_kinds'")
          .get(),
      ).sql;
    if (!kindsDefinition.includes("'action'") || !kindsDefinition.includes("'reference'"))
      this.transaction(() =>
        this.db.exec(`
        ALTER TABLE item_kinds RENAME TO previous_item_kinds;
        CREATE TABLE item_kinds(task_id TEXT PRIMARY KEY REFERENCES tasks(id),kind TEXT NOT NULL CHECK(kind IN ('task','action','question','reminder','event','reference')),manual INTEGER NOT NULL CHECK(manual IN (0,1)),suggestion TEXT CHECK(suggestion IS NULL OR suggestion IN ('task','action','question','reminder','event','reference')));
        INSERT INTO item_kinds(task_id,kind,manual,suggestion) SELECT task_id,kind,manual,suggestion FROM previous_item_kinds;
        DROP TABLE previous_item_kinds;
      `),
      );
    if (
      !this.db
        .prepare('PRAGMA table_info(waiting_for)')
        .all()
        .some((row) => row.name === 'needs_review')
    )
      this.db.exec(
        'ALTER TABLE waiting_for ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0 CHECK(needs_review IN (0,1))',
      );
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
      for (const m of messages) this.upsertMessage(m);
    });
  }
  upsertMessage(message: Message) {
    this.db
      .prepare(
        'INSERT INTO messages(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(message.id, JSON.stringify(message));
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
  apply(
    changes: TaskChange[],
    batch: Message[],
    context: Message[] = [],
    waits: WaitChange[] = [],
  ) {
    const messages = new Map([...batch, ...context].map((m) => [m.id, m]));
    if (changes.length > 40) throw new Error('Task batch is too large');
    return this.transaction(() => {
      let added = 0;
      for (const t of changes) {
        const sources = t.source_ids.map((id) => messages.get(id));
        const first = sources[0];
        if (!first || sources.some((m) => !m))
          throw new Error('A task must cite evidence from one supplied conversation');
        const requestedIdentity =
          t.id ??
          hash([
            first.sessionId,
            first.chatId,
            [...t.source_ids].sort()[0],
            t.title.toLocaleLowerCase(),
          ]);
        const redirect = this.db
          .prepare('SELECT target_id AS id FROM task_merges WHERE source_id=?')
          .get(requestedIdentity);
        const identity = redirect ? IdRow.parse(redirect).id : requestedIdentity;
        const existing = this.db.prepare('SELECT id FROM tasks WHERE id=?').get(identity);
        const ownerLinked = this.db
          .prepare('SELECT source_id FROM task_merges WHERE target_id=? LIMIT 1')
          .get(identity);
        if (
          !ownerLinked &&
          sources.some((m) => m?.chatId !== first.chatId || m?.sessionId !== first.sessionId)
        )
          throw new Error('A task must cite evidence from one supplied conversation');
        if (t.id && !existing) throw new Error('Unknown task ID');
        if (existing && sources.some((m) => !m || !this.taskInChat(identity, m)))
          throw new Error('Cannot update a task from another conversation');
        if (redirect) {
          for (const id of t.source_ids)
            this.db.prepare('INSERT OR IGNORE INTO sources VALUES(?,?)').run(identity, id);
          continue;
        }
        const timestamp = now();
        this.db
          .prepare(
            'INSERT INTO tasks VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,scope=excluded.scope,note=excluded.note,updated=excluded.updated',
          )
          .run(identity, t.title, t.scope, t.note, timestamp, timestamp);
        if (!existing)
          this.db
            .prepare('INSERT INTO item_kinds(task_id,kind,manual,suggestion) VALUES(?,?,0,?)')
            .run(identity, t.kind, t.kind_suggestion ?? null);
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
      for (const wait of waits) {
        if (wait.id) {
          if (!this.db.prepare('SELECT id FROM waiting_for WHERE id=?').get(wait.id))
            throw new TaskTriageError('Unknown waiting item');
          continue;
        }
        const sources = wait.source_ids.map((id) => messages.get(id));
        const first = sources[0];
        if (
          !first ||
          sources.some(
            (source) =>
              !source || source.chatId !== first.chatId || source.sessionId !== first.sessionId,
          ) ||
          !sources.some((source) => source?.direction === 'outgoing')
        )
          throw new TaskTriageError(
            'A proposed wait needs an outgoing request in one conversation',
          );
        const taskId = wait.task_id ? this.taskId(wait.task_id) : null;
        if (taskId && sources.some((source) => source && !this.taskInChat(taskId, source)))
          throw new TaskTriageError('A proposed wait cannot link unrelated conversations');
        const id =
          wait.id ??
          hash([
            'wait',
            first.sessionId,
            first.chatId,
            [...wait.source_ids].sort()[0],
            wait.expected.toLocaleLowerCase(),
          ]);
        const timestamp = now();
        this.db
          .prepare(
            'INSERT OR IGNORE INTO waiting_for(id,expected,person,task_id,state,response_id,created,updated,manual_state,needs_review) VALUES(?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            id,
            wait.expected,
            wait.person,
            taskId,
            'waiting',
            null,
            timestamp,
            timestamp,
            0,
            Number(wait.needs_review),
          );
        for (const source of wait.source_ids)
          this.db.prepare('INSERT OR IGNORE INTO waiting_sources VALUES(?,?)').run(id, source);
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
    return sources.some((m) => m.sessionId === message.sessionId && m.chatId === message.chatId);
  }
  private taskId(identifier: string) {
    const row = this.db
      .prepare(
        "SELECT t.id FROM tasks t JOIN task_references ref ON ref.task_id=t.id WHERE t.id=? OR 'TODO-' || printf('%03d',ref.number)=?",
      )
      .get(identifier, identifier.toUpperCase());
    if (!row) throw new TaskTriageError('Task not found', 404);
    return IdRow.parse(row).id;
  }
  mergeTasks(input: z.infer<typeof TaskMergeSchema>) {
    const value = TaskMergeSchema.parse(input);
    return this.transaction(() => {
      const sourceId = this.taskId(value.source_id);
      const requestedTarget = this.taskId(value.target_id);
      const target = this.taskEvidence(requestedTarget);
      if (sourceId === requestedTarget || sourceId === target.task.id)
        throw new TaskTriageError('A TODO cannot be merged into itself');
      const existing = this.db
        .prepare('SELECT target_id AS id FROM task_merges WHERE source_id=?')
        .get(sourceId);
      if (existing) {
        if (IdRow.parse(existing).id !== target.task.id)
          throw new TaskTriageError(
            'This TODO was already merged into a different destination. Reload it before continuing.',
            409,
          );
        return target;
      }
      const source = this.taskEvidence(sourceId);
      if (source.task.gtd.recurrence)
        throw new TaskTriageError('Stop repeating the source item before merging it');
      if (source.revision !== value.source_revision || target.revision !== value.target_revision)
        throw new TaskTriageError(
          'A TODO changed while the merge was being prepared. Try again after reading the updated tasks.',
          409,
        );
      this.db
        .prepare(
          'INSERT OR IGNORE INTO sources(task_id,message_id) SELECT ?,message_id FROM sources WHERE task_id=?',
        )
        .run(target.task.id, sourceId);
      this.db.prepare('DELETE FROM sources WHERE task_id=?').run(sourceId);
      this.db
        .prepare('UPDATE waiting_for SET task_id=? WHERE task_id=?')
        .run(target.task.id, sourceId);
      this.db
        .prepare('UPDATE task_merges SET target_id=? WHERE target_id=?')
        .run(target.task.id, sourceId);
      this.db
        .prepare('INSERT INTO task_merges VALUES(?,?,?,?)')
        .run(sourceId, target.task.id, now(), JSON.stringify(source.task.source_ids));
      this.db.prepare('UPDATE tasks SET updated=? WHERE id=?').run(now(), target.task.id);
      for (const row of this.db
        .prepare("SELECT id,payload FROM completion_questions WHERE status='pending'")
        .all()) {
        const question = DecisionSchema.parse(JSON.parse(PayloadRow.parse(row).payload));
        if (!question.task_ids.includes(sourceId)) continue;
        question.task_ids = [
          ...new Set(question.task_ids.map((id) => (id === sourceId ? target.task.id : id))),
        ];
        this.db
          .prepare('UPDATE completion_questions SET payload=? WHERE id=?')
          .run(JSON.stringify(question), IdRow.parse(row).id);
      }
      return this.taskEvidence(target.task.id);
    });
  }
  private assertNotMerged(id: string) {
    if (this.db.prepare('SELECT source_id FROM task_merges WHERE source_id=?').get(id))
      throw new TaskTriageError(
        'This TODO was merged. Open its destination before changing it.',
        409,
      );
  }
  taskEvidence(id: string) {
    const snapshot = this.snapshot();
    const task = snapshot.tasks.find((item) => matchesTaskIdentifier(item, id));
    if (!task) throw new TaskTriageError('Task not found', 404);
    const messages = snapshot.messages.filter((message) => task.source_ids.includes(message.id));
    return { task, messages, revision: hash({ task, messages }) };
  }
  createWait(input: WaitInput) {
    const value = WaitInputSchema.parse(input);
    return this.transaction(() => {
      const taskId = value.task_id ? this.taskId(value.task_id) : null;
      if (taskId) this.assertNotMerged(taskId);
      if (
        new Set(value.source_ids).size !== value.source_ids.length ||
        value.source_ids.some(
          (id) => !this.db.prepare('SELECT id FROM messages WHERE id=?').get(id),
        )
      )
        throw new TaskTriageError('Waiting for needs valid source messages');
      const id = randomUUID(),
        timestamp = now();
      this.db
        .prepare(
          'INSERT INTO waiting_for(id,expected,person,task_id,state,response_id,created,updated,manual_state,needs_review) VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(id, value.expected, value.person, taskId, 'waiting', null, timestamp, timestamp, 0, 0);
      for (const source of value.source_ids)
        this.db.prepare('INSERT INTO waiting_sources VALUES(?,?)').run(id, source);
      return this.waitEvidence(id).wait;
    });
  }
  waitEvidence(id: string) {
    const snapshot = this.snapshot();
    const wait = snapshot.waiting_for.find((item) => item.id === id);
    if (!wait) throw new TaskTriageError('Waiting item not found', 404);
    const ids = new Set([...wait.source_ids, ...(wait.response_id ? [wait.response_id] : [])]);
    const messages = snapshot.messages.filter((message) => ids.has(message.id));
    return { wait, messages, revision: hash({ wait, messages }) };
  }
  setWaitState(id: string, state: z.infer<typeof WaitStateSchema>) {
    const value = WaitStateSchema.parse(state);
    return this.transaction(() => {
      this.waitEvidence(id);
      this.db
        .prepare(
          'UPDATE waiting_for SET state=?,response_id=NULL,updated=?,manual_state=1,needs_review=0 WHERE id=?',
        )
        .run(value, now(), id);
      return this.waitEvidence(id);
    });
  }
  confirmWait(id: string) {
    return this.transaction(() => {
      const current = this.waitEvidence(id);
      if (current.wait.state !== 'waiting')
        throw new TaskTriageError('Only an open waiting item can be confirmed');
      const rejected = current.messages.find((message) => message.id === current.wait.response_id);
      if (rejected)
        this.db
          .prepare('INSERT OR REPLACE INTO rejected_wait_responses VALUES(?,?,?)')
          .run(id, rejected.id, fingerprint(rejected));
      this.db
        .prepare('UPDATE waiting_for SET needs_review=0,response_id=NULL,updated=? WHERE id=?')
        .run(now(), id);
      return this.waitEvidence(id);
    });
  }
  waitResponseRejected(id: string, message: Message) {
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 FROM rejected_wait_responses WHERE wait_id=? AND message_id=? AND digest=?',
        )
        .get(id, message.id, fingerprint(message)),
    );
  }
  autoReceiveWait(id: string, revision: string, responseId: string, responseFingerprint: string) {
    return this.transaction(() => {
      const current = this.waitEvidence(id);
      if (
        current.revision !== revision ||
        current.wait.state !== 'waiting' ||
        current.wait.manual_state ||
        current.wait.needs_review
      )
        return false;
      const response = this.messages().find((message) => message.id === responseId);
      if (
        !response ||
        response.direction !== 'incoming' ||
        !response.body.trim() ||
        fingerprint(response) !== responseFingerprint
      )
        return false;
      const matchesChat = current.messages.some(
        (source) =>
          source.direction === 'outgoing' &&
          source.sessionId === response.sessionId &&
          source.chatId === response.chatId &&
          response.timestamp >= source.timestamp &&
          (response.reply_to_id === source.id ||
            Boolean(source.waMessageId && response.reply_to_wa_id === source.waMessageId)),
      );
      if (!matchesChat) return false;
      this.db
        .prepare("UPDATE waiting_for SET state='received',response_id=?,updated=? WHERE id=?")
        .run(response.id, now(), id);
      return true;
    });
  }
  suggestWaitResponse(
    id: string,
    revision: string,
    responseId: string,
    responseFingerprint: string,
  ) {
    return this.transaction(() => {
      const current = this.waitEvidence(id);
      if (
        current.revision !== revision ||
        current.wait.state !== 'waiting' ||
        current.wait.manual_state ||
        current.wait.needs_review
      )
        return false;
      const response = this.messages().find((message) => message.id === responseId);
      const matchesChat =
        response &&
        response.direction === 'incoming' &&
        fingerprint(response) === responseFingerprint &&
        current.messages.some(
          (source) =>
            source.direction === 'outgoing' &&
            source.sessionId === response.sessionId &&
            source.chatId === response.chatId &&
            response.timestamp >= source.timestamp,
        );
      if (!matchesChat) return false;
      this.db
        .prepare('UPDATE waiting_for SET response_id=?,needs_review=1,updated=? WHERE id=?')
        .run(responseId, now(), id);
      return true;
    });
  }
  setTaskKind(identifier: string, kind: ItemKind) {
    const value = ItemKindSchema.parse(kind);
    return this.transaction(() => {
      const id = this.taskId(identifier);
      this.assertNotMerged(id);
      if (this.taskEvidence(id).task.gtd.recurrence && value !== 'task' && value !== 'action')
        throw new TaskTriageError('Stop repeating this item before changing its category');
      this.db
        .prepare(
          'INSERT INTO item_kinds(task_id,kind,manual,suggestion) VALUES(?,?,1,NULL) ON CONFLICT(task_id) DO UPDATE SET kind=excluded.kind,manual=1,suggestion=NULL',
        )
        .run(id, value);
      return this.taskEvidence(id);
    });
  }
  setGtd(identifier: string, input: GtdInput) {
    const value = GtdSchema.parse(input);
    return this.transaction(() => {
      const id = this.taskId(identifier);
      this.assertNotMerged(id);
      const task = this.taskEvidence(id).task;
      if (value.recurrence && task.kind !== 'task' && task.kind !== 'action')
        throw new TaskTriageError('Only tasks and actions can repeat');
      this.db
        .prepare('INSERT OR REPLACE INTO item_gtd(task_id,payload) VALUES(?,?)')
        .run(id, JSON.stringify(value));
      return this.taskEvidence(id);
    });
  }
  completeOccurrence(identifier: string, date: string) {
    const occurrenceDate = z.iso.date().parse(date);
    return this.transaction(() => {
      const id = this.taskId(identifier);
      this.assertNotMerged(id);
      if (
        this.db
          .prepare('SELECT task_id FROM item_occurrences WHERE task_id=? AND date=?')
          .get(id, occurrenceDate)
      )
        return false;
      const task = this.taskEvidence(id).task;
      const recurrence = task.gtd.recurrence;
      if (task.done || !recurrence || recurrence.next_date !== occurrenceDate) return false;
      this.db
        .prepare('INSERT INTO item_occurrences(task_id,date,completed) VALUES(?,?,?)')
        .run(id, occurrenceDate, now());
      const next = {
        ...task.gtd,
        recurrence: { ...recurrence, next_date: nextOccurrence(recurrence) },
      };
      this.db
        .prepare('INSERT OR REPLACE INTO item_gtd(task_id,payload) VALUES(?,?)')
        .run(id, JSON.stringify(next));
      return true;
    });
  }
  isTaskKindManual(id: string) {
    const row = this.db.prepare('SELECT manual FROM item_kinds WHERE task_id=?').get(id);
    return Boolean(row && z.object({ manual: z.number() }).parse(row).manual);
  }
  hasGtd(id: string) {
    return Boolean(this.db.prepare('SELECT task_id FROM item_gtd WHERE task_id=?').get(id));
  }
  autoSetTaskKind(
    identifier: string,
    revision: string,
    kind: ItemKind,
    suggestion: ItemKind | null = null,
  ) {
    const value = ItemKindSchema.parse(kind);
    const proposed = ItemKindSchema.nullable().parse(suggestion);
    return this.transaction(() => {
      const current = this.taskEvidence(identifier);
      if (current.revision !== revision) return false;
      if (this.isTaskKindManual(current.task.id)) return false;
      if (current.task.gtd.recurrence && value !== 'task' && value !== 'action') return false;
      this.db
        .prepare(
          'INSERT INTO item_kinds(task_id,kind,manual,suggestion) VALUES(?,?,0,?) ON CONFLICT(task_id) DO UPDATE SET kind=excluded.kind,suggestion=excluded.suggestion WHERE item_kinds.manual=0',
        )
        .run(current.task.id, value, proposed);
      return true;
    });
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
    this.assertNotMerged(id);
    if (!this.db.prepare('SELECT id FROM tasks WHERE id=?').get(id))
      throw new Error('Task not found');
    if (done) {
      const row = this.db.prepare('SELECT payload FROM item_gtd WHERE task_id=?').get(id);
      if (row && GtdSchema.parse(JSON.parse(PayloadRow.parse(row).payload)).recurrence)
        throw new TaskTriageError('Complete the current occurrence or stop repeating first');
    }
    const timestamp = now();
    this.db
      .prepare('INSERT OR REPLACE INTO completion VALUES(?,?,?)')
      .run(id, Number(done), timestamp);
    this.db
      .prepare('INSERT INTO completion_history VALUES(?,?,?)')
      .run(id, Number(done), timestamp);
  }
  remark(id: string, remark: string) {
    this.assertNotMerged(id);
    if (!this.db.prepare('SELECT id FROM tasks WHERE id=?').get(id))
      throw new Error('Task not found');
    this.db.prepare('INSERT OR REPLACE INTO task_remarks VALUES(?,?,?)').run(id, remark, now());
  }
  filterNotTask(id: string, expectedRevision: string) {
    return this.transaction(() => {
      const current = this.taskEvidence(id);
      if (
        current.revision !== expectedRevision ||
        current.task.done ||
        current.task.kind !== 'task' ||
        current.task.kind_suggestion !== null ||
        current.task.own_remark ||
        current.task.merged_from.length
      )
        return false;
      if (this.isTaskKindManual(current.task.id)) return false;
      if (this.hasGtd(current.task.id)) return false;
      // A manual completion or reopening remains authoritative on later reviews.
      if (this.db.prepare('SELECT task_id FROM completion WHERE task_id=?').get(id)) return false;
      this.tick(id, true);
      this.db
        .prepare(
          'INSERT INTO completion_events(task_id,message_id,kind,reason,created) VALUES(?,?,?,?,?)',
        )
        .run(
          id,
          null,
          'filtered',
          'The conversation did not contain an actionable request.',
          now(),
        );
      return true;
    });
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
  decide(decisions: Decision[], batch: Message[], started: number, recheck = false) {
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
        if (
          d.action === 'complete' &&
          this.db
            .prepare(
              "SELECT task_id FROM item_kinds WHERE task_id=? AND kind IN ('reminder','event','reference')",
            )
            .get(d.task_ids[0] ?? '')
        )
          throw new Error('Reminders require an owner action to dismiss');
        if (d.action === 'complete' && d.task_ids[0]) {
          const gtd = this.db
            .prepare('SELECT payload FROM item_gtd WHERE task_id=?')
            .get(d.task_ids[0]);
          if (gtd) {
            const value = GtdSchema.parse(JSON.parse(PayloadRow.parse(gtd).payload));
            if (value.recurrence || value.commitment === 'someday')
              throw new Error('Recurring or someday items require an owner action to complete');
          }
        }
        if (
          d.action === 'complete' &&
          this.db
            .prepare('SELECT task_id FROM item_kinds WHERE task_id=? AND suggestion IS NOT NULL')
            .get(d.task_ids[0] ?? '')
        )
          throw new Error('The item category needs review before automatic completion');
        if (d.action === 'ask' && !d.question?.trim())
          throw new Error('Ambiguous completion needs a question');
      }
      for (const d of decisions) {
        const m = batch.find((m) => m.id === d.message_id);
        if (!m) throw new Error('Missing reply');
        const row = this.db
          .prepare('SELECT digest FROM completion_seen WHERE message_id=?')
          .get(m.id);
        if (
          row &&
          z.object({ digest: z.string() }).parse(row).digest === fingerprint(m) &&
          (!recheck || d.action !== 'complete')
        )
          continue;
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
    const waiting_for = this.db
      .prepare('SELECT * FROM waiting_for ORDER BY created,id')
      .all()
      .map((row) => {
        const id = IdRow.parse(row).id;
        const source_ids = this.db
          .prepare('SELECT message_id FROM waiting_sources WHERE wait_id=? ORDER BY message_id')
          .all(id)
          .map((source) => RefRow.parse(source).message_id);
        const flags = z.object({ manual_state: z.number(), needs_review: z.number() }).parse(row);
        return WaitSchema.parse({
          ...row,
          source_ids,
          manual_state: Boolean(flags.manual_state),
          needs_review: Boolean(flags.needs_review),
        });
      });
    const tasks = this.db
      .prepare(
        "SELECT t.*,'TODO-' || printf('%03d',ref.number) reference,coalesce(c.done,0) done,coalesce(r.remark,'') own_remark,coalesce(k.kind,'task') kind,k.suggestion kind_suggestion FROM tasks t JOIN task_references ref ON ref.task_id=t.id LEFT JOIN task_merges merged ON merged.source_id=t.id LEFT JOIN completion c ON c.task_id=t.id LEFT JOIN task_remarks r ON r.task_id=t.id LEFT JOIN item_kinds k ON k.task_id=t.id WHERE merged.source_id IS NULL ORDER BY t.created,t.id",
      )
      .all()
      .map((row) => {
        const id = IdRow.parse(row).id,
          triage = this.db.prepare('SELECT payload FROM triage WHERE task_id=?').get(id),
          lastResolution = this.db
            .prepare(
              `SELECT e.kind,e.reason FROM completion_events e JOIN completion c ON c.task_id=e.task_id WHERE e.task_id=? AND c.done=1 AND e.created>=c.updated ORDER BY e.id DESC LIMIT 1`,
            )
            .get(id),
          resolution = lastResolution
            ? z.object({ kind: z.string(), reason: z.string().nullable() }).parse(lastResolution)
            : null;
        const detail: unknown = triage ? JSON.parse(PayloadRow.parse(triage).payload) : {};
        const gtd = this.db.prepare('SELECT payload FROM item_gtd WHERE task_id=?').get(id);
        const occurrences = this.db
          .prepare('SELECT date,completed FROM item_occurrences WHERE task_id=? ORDER BY date')
          .all(id);
        return TaskSchema.parse({
          ...row,
          ...z.record(z.string(), z.unknown()).parse(detail),
          ...(gtd ? { gtd: JSON.parse(PayloadRow.parse(gtd).payload) } : {}),
          occurrences,
          resolution:
            resolution && ['filtered', 'auto', 'confirmed'].includes(resolution.kind)
              ? {
                  kind: resolution.kind === 'filtered' ? 'filtered' : 'reply',
                  reason: resolution.reason ?? '',
                }
              : null,
          merged_from: this.db
            .prepare(
              "SELECT t.id,'TODO-' || printf('%03d',ref.number) reference,t.title,t.note,m.source_ids,coalesce(c.done,0) done,coalesce(r.remark,'') own_remark FROM task_merges m JOIN tasks t ON t.id=m.source_id JOIN task_references ref ON ref.task_id=t.id LEFT JOIN completion c ON c.task_id=t.id LEFT JOIN task_remarks r ON r.task_id=t.id WHERE m.target_id=? ORDER BY m.created,t.id",
            )
            .all(id)
            .map((source) => {
              const sourceId = IdRow.parse(source).id;
              const metadata = this.db
                .prepare('SELECT payload FROM item_gtd WHERE task_id=?')
                .get(sourceId);
              return {
                ...source,
                done: Boolean(source.done),
                source_ids: z
                  .array(z.string())
                  .parse(JSON.parse(z.string().parse(source.source_ids))),
                ...(metadata ? { gtd: JSON.parse(PayloadRow.parse(metadata).payload) } : {}),
                occurrences: this.db
                  .prepare(
                    'SELECT date,completed FROM item_occurrences WHERE task_id=? ORDER BY date',
                  )
                  .all(sourceId),
              };
            }),
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
      waiting_for,
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
