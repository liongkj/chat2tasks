import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MessageSchema, TaskSchema } from '../src/shared/schema.js';
import { LocalSearch } from '../src/server/search.js';

const task = TaskSchema.parse({
  id: 'task-1',
  reference: 'TODO-001',
  title: 'Repair the export',
  scope: 'Reports',
  note: 'The download is missing a column',
  created: 1,
  updated: 1,
  done: false,
  source_ids: [],
});
const message = MessageSchema.parse({
  id: 'message-1',
  sessionId: 's',
  chatId: 'c',
  body: 'Please fix the broken spreadsheet',
  direction: 'incoming',
  timestamp: 1,
});
function vector(input: string) {
  const numbers = Array(256).fill(0);
  const reports = /export|spreadsheet|download/i.test(input);
  numbers[reports ? 0 : 1] = 1;
  return numbers;
}

async function ready(search: LocalSearch, query: string) {
  let result = await search.find(query);
  for (let attempt = 0; result.status.kind === 'indexing' && attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    result = await search.find(query);
  }
  return result;
}

test('search finds both matching items and semantically related saved messages after edits', async () => {
  const db = new DatabaseSync(':memory:');
  let source = { tasks: [task], messages: [message] };
  const engine = new LocalSearch(
    db,
    () => source,
    async ({ input }) => input.map(vector),
  );
  try {
    const initial = await ready(engine, 'export');
    assert.equal(initial.status.kind, 'ready');
    assert.ok(
      initial.results.some(
        (result) => result.kind === 'task' && result.id === task.id && result.match === 'exact',
      ),
    );
    assert.ok(
      initial.results.some(
        (result) =>
          result.kind === 'message' && result.id === message.id && result.match === 'related',
      ),
    );

    source = { tasks: [], messages: [{ ...message, body: 'Lunch is ready' }] };
    const afterEdit = await ready(engine, 'export');
    assert.equal(afterEdit.status.kind, 'ready');
    assert.ok(!afterEdit.results.some((result) => result.id === task.id));
    assert.ok(!afterEdit.results.some((result) => result.id === message.id));
    assert.ok(
      (await ready(engine, 'lunch')).results.some(
        (result) => result.id === message.id && result.match === 'exact',
      ),
    );
  } finally {
    db.close();
  }
});

test('exact search remains usable when the local model is unavailable', async () => {
  const db = new DatabaseSync(':memory:');
  const engine = new LocalSearch(
    db,
    () => ({ tasks: [task], messages: [message] }),
    async () => {
      throw Error('offline');
    },
  );
  try {
    const result = await ready(engine, 'spreadsheet');
    assert.equal(result.status.kind, 'unavailable');
    assert.ok(result.results.some((match) => match.id === message.id && match.match === 'exact'));
  } finally {
    db.close();
  }
});

test('changing the search server stops indexing on the old server and rebuilds on the selected one', async () => {
  const db = new DatabaseSync(':memory:');
  const calls: string[] = [];
  let release: (() => void) | undefined;
  let oldSignal: AbortSignal | undefined;
  const engine = new LocalSearch(
    db,
    () => ({ tasks: [task], messages: [message] }),
    async ({ input, url, signal }) => {
      calls.push(url);
      if (url === 'http://127.0.0.1:11434') {
        oldSignal = signal;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return input.map(vector);
    },
  );
  try {
    assert.equal((await engine.find('export')).status.kind, 'indexing');
    assert.ok(oldSignal);
    engine.saveSettings({ kind: 'server', url: 'https://search.example.invalid' });
    assert.equal(oldSignal.aborted, true);
    release?.();
    const result = await ready(engine, 'export');
    assert.equal(result.status.kind, 'ready');
    assert.ok(result.results.some((item) => item.id === message.id && item.match === 'related'));
    assert.ok(calls.includes('https://search.example.invalid'));
    assert.throws(() => engine.saveSettings({ kind: 'server', url: 'not-a-url' }));
  } finally {
    db.close();
  }
});
