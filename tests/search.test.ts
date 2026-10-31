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

test('search finds image, audio, and video messages by their contents and removes revoked media', async () => {
  const db = new DatabaseSync(':memory:');
  let source = {
    tasks: [],
    messages: ['image', 'ptt', 'video'].map((type) =>
      MessageSchema.parse({ ...message, id: type, type, body: '', image_digest: 'sample' }),
    ),
  };
  function seasideVector(text: string) {
    const result = Array(256).fill(0);
    result[/seaside/i.test(text) ? 0 : 1] = 1;
    return result;
  }
  const engine = new LocalSearch(
    db,
    () => source,
    async ({ input }) => input.map(seasideVector),
    undefined,
    {
      load: async (item) => ({ mime: 'application/octet-stream', bytes: Buffer.from(item.id) }),
      prepare: async (_attachment, kind) =>
        kind === 'image'
          ? [{ image: Buffer.from('seaside photograph').toString('base64') }]
          : kind === 'audio'
            ? [{ audio: Buffer.from('seaside recording').toString('base64') }]
            : [
                { image: Buffer.from('seaside frame').toString('base64') },
                { audio: Buffer.from('seaside soundtrack').toString('base64') },
              ],
      embed: async ({ input }) =>
        input.map((item) => {
          const text = Buffer.from('image' in item ? item.image : item.audio, 'base64').toString();
          return seasideVector(text);
        }),
    },
  );
  async function mediaReady() {
    let result = await engine.find('seaside');
    for (let attempt = 0; result.media?.kind === 'indexing' && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      result = await engine.find('seaside');
    }
    return result;
  }
  try {
    const initial = await mediaReady();
    assert.equal(initial.media?.kind, 'ready');
    for (const id of ['image', 'ptt', 'video'])
      assert.ok(initial.results.some((result) => result.id === id && result.match === 'related'));

    source = {
      ...source,
      messages: source.messages.map((item) =>
        item.id === 'image' ? { ...item, type: 'revoked' } : item,
      ),
    };
    const afterRevocation = await mediaReady();
    assert.ok(!afterRevocation.results.some((result) => result.id === 'image'));
    assert.ok(afterRevocation.results.some((result) => result.id === 'video'));
  } finally {
    db.close();
  }
});

test('text search remains usable when media cannot be indexed', async () => {
  const db = new DatabaseSync(':memory:');
  const picture = MessageSchema.parse({ ...message, id: 'picture', type: 'image', body: '' });
  const engine = new LocalSearch(
    db,
    () => ({ tasks: [task], messages: [picture] }),
    async ({ input }) => input.map(vector),
    undefined,
    {
      load: async () => null,
      prepare: async () => [],
    },
  );
  try {
    let result = await engine.find('export');
    for (
      let attempt = 0;
      (result.status.kind === 'indexing' || result.media?.kind === 'indexing') && attempt < 100;
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      result = await engine.find('export');
    }
    assert.equal(result.status.kind, 'ready');
    assert.equal(result.media?.kind, 'unavailable');
    assert.ok(result.results.some((item) => item.id === task.id && item.match === 'exact'));
  } finally {
    db.close();
  }
});

test('media indexing follows the selected search server and cancels the old one', async () => {
  const db = new DatabaseSync(':memory:');
  const picture = MessageSchema.parse({ ...message, id: 'picture', type: 'image', body: '' });
  const urls: string[] = [];
  let release: (() => void) | undefined;
  let oldSignal: AbortSignal | undefined;
  const engine = new LocalSearch(
    db,
    () => ({ tasks: [], messages: [picture] }),
    async ({ input }) => input.map(() => vector('export')),
    undefined,
    {
      load: async () => ({ mime: 'image/png', bytes: Buffer.from('sample') }),
      prepare: async () => [{ image: Buffer.from('sample').toString('base64') }],
      embed: async ({ input, url, signal }) => {
        urls.push(url);
        if (url === 'http://127.0.0.1:11434') {
          oldSignal = signal;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return input.map(() => {
          const values = Array(256).fill(0);
          values[0] = 1;
          return values;
        });
      },
    },
  );
  try {
    assert.equal((await engine.find('sample')).media?.kind, 'indexing');
    for (let attempt = 0; !oldSignal && attempt < 100; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(oldSignal);
    engine.saveSettings({ kind: 'server', url: 'https://search.example.invalid' });
    assert.equal(oldSignal.aborted, true);
    release?.();
    let result = await engine.find('sample');
    for (let attempt = 0; result.media?.kind === 'indexing' && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      result = await engine.find('sample');
    }
    assert.equal(result.media?.kind, 'ready');
    assert.ok(result.results.some((item) => item.id === picture.id && item.match === 'related'));
    assert.ok(urls.includes('https://search.example.invalid'));
  } finally {
    db.close();
  }
});

test('already indexed media remains searchable while other attachments are being prepared', async () => {
  const db = new DatabaseSync(':memory:');
  const pictures = ['first', 'second'].map((id) =>
    MessageSchema.parse({ ...message, id, type: 'image', body: '' }),
  );
  let release: (() => void) | undefined;
  const engine = new LocalSearch(
    db,
    () => ({ tasks: [], messages: pictures }),
    async ({ input }) => input.map(() => vector('export')),
    undefined,
    {
      load: async (item) => ({ mime: 'image/png', bytes: Buffer.from(item.id) }),
      prepare: async (attachment) => {
        if (attachment.bytes.toString() === 'second')
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return [{ image: attachment.bytes.toString('base64') }];
      },
      embed: async ({ input }) => input.map(() => vector('export')),
    },
  );
  try {
    await engine.find('sample');
    for (let attempt = 0; !release && attempt < 100; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(release);
    const during = await engine.find('sample');
    assert.equal(during.media?.kind, 'indexing');
    assert.ok(during.results.some((item) => item.id === 'first' && item.match === 'related'));
    release();
    for (
      let attempt = 0;
      (await engine.find('sample')).media?.kind === 'indexing' && attempt < 100;
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
  } finally {
    release?.();
    db.close();
  }
});
