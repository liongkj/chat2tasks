import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, now } from '../src/server/store.js';
import { OpenWA } from '../src/server/openwa.js';
import { Sync } from '../src/server/sync.js';
import { DecisionSchema, MessageSchema, TaskChangeSchema } from '../src/shared/schema.js';
import {
  reviewTaskCandidates,
  reviewExistingTasks,
  reviewCompletions,
} from '../src/server/decisions.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chat2tasks-filter-'));
  const store = new Store(dir);
  store.saveSettings({
    settings: {
      ...store.settings(),
      chats: [{ id: 'chat', name: 'Chat', sessionId: 's', chatId: 'c', enabled: true }],
      profiles: [
        {
          id: 'judge',
          name: 'Decision',
          kind: 'decision',
          provider: 'openai',
          model: 'gpt-6-luna',
          baseUrl: 'https://judge.example/v1',
        },
        {
          id: 'tasks',
          name: 'Tasks',
          kind: 'compatible',
          model: 'fixture',
          baseUrl: 'https://tasks.example/v1',
        },
      ],
      activeProfileId: 'tasks',
      trigger: { mode: 'automatic', decisionProfileId: 'judge' },
    },
    secrets: { 'judge:key': 'test-key', 'tasks:key': 'test-key' },
    removeSecrets: [],
  });
  const sync = new Sync(store, new OpenWA(store));
  sync.stop();
  return {
    store,
    sync,
    close() {
      sync.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const message = (id: string, body: string, direction: 'incoming' | 'outgoing', timestamp: number) =>
  MessageSchema.parse({
    id,
    body,
    direction,
    timestamp,
    type: 'text',
    sessionId: 's',
    chatId: 'c',
  });
const change = (title: string, source: string) =>
  TaskChangeSchema.parse({
    id: null,
    title,
    scope: 'Example',
    note: 'Source context',
    source_ids: [source],
    action_steps: ['Do the requested action'],
    done_when: ['The requested action is complete'],
    priority: 'normal',
    triage_state: 'ready',
    blocking_question: null,
  });
const completion = (mid: string, tid: string) => ({
  message_id: mid,
  action: 'complete',
  task_ids: [tid],
  evidence_quote: 'The rate is 10%',
  reason: 'The requested answer was provided',
  question: null,
});
const answer = (content: unknown) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
      usage: { total_tokens: 1 },
    }),
    { status: 200 },
  );

test('decision reviews share only the evidence needed for the tasks being reviewed', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  try {
    const t = now() - 120;
    const parent = message('parent', 'For the export', 'incoming', t - 1);
    const source = MessageSchema.parse({
      ...message('source', 'What is the rate?', 'incoming', t),
      reply_to_id: parent.id,
    });
    const reply = MessageSchema.parse({
      ...message('reply', 'The rate is 10%', 'outgoing', t + 1),
      reply_to_id: source.id,
    });
    const unrelated = message('unrelated', 'Private unrelated conversation', 'outgoing', t + 2);
    const otherSource = message('other', 'Fix the export', 'incoming', t + 3);
    const messages = [parent, source, reply, unrelated, otherSource];
    f.store.cache(messages);
    f.store.apply(
      [change('Answer the rate question', source.id), change('Other task', otherSource.id)],
      messages,
    );
    const tasks = f.store.snapshot().tasks;
    const task = tasks.find((item) => item.title === 'Answer the rate question');
    assert.ok(task);
    const judge = f.store.settings().profiles.find((profile) => profile.id === 'judge');
    assert.ok(judge);
    const inputs: string[] = [];
    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      inputs.push(request.input);
      return new Response(
        JSON.stringify({
          answers: request.questions.map((q: { name: string }) => ({
            name: q.name,
            type: 'choice',
            choice: q.name.startsWith('completion_') ? 'supported' : 'keep',
            confidence: 0.99,
          })),
        }),
        { status: 200 },
      );
    };
    await reviewTaskCandidates(
      f.store,
      judge,
      [change('Answer the rate question', source.id)],
      messages,
    );
    await reviewExistingTasks(f.store, judge, [task], messages);
    await reviewCompletions(
      f.store,
      judge,
      [
        DecisionSchema.parse(completion(reply.id, task.id)),
        DecisionSchema.parse({ ...completion(unrelated.id, task.id), action: 'none' }),
      ],
      [reply, unrelated],
      tasks,
      messages,
    );
    assert.equal(inputs.length, 3);
    for (const input of inputs) {
      assert.match(input, /What is the rate\?/);
      assert.match(input, /For the export/);
      assert.doesNotMatch(input, /Private unrelated conversation/);
    }
    assert.match(inputs[2] ?? '', /The rate is 10%/);
    assert.doesNotMatch(inputs[2] ?? '', /Other task/);
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});

test('status screenshots do not create tasks, while alerts and direct requests remain', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  try {
    const t = now() - 120;
    const image = (id: string, body: string, observation: string) =>
      MessageSchema.parse({
        ...message(id, body, 'incoming', t),
        type: 'image',
        image_digest: id,
        image_reading: { message_id: id, observations: [observation], uncertainties: [] },
      });
    const status = image('status', '', 'A project-status checklist and handoff');
    const alert = image('alert', '', 'A live dashboard shows high disk usage');
    const captioned = image('captioned', 'Please resolve this', 'A project-status checklist');
    const linked = image('linked', '', 'A project-status checklist');
    const unavailable = image(
      'unavailable',
      '',
      'A project-status checklist with provider failure',
    );
    const request = MessageSchema.parse({
      ...message('request', 'Please handle this', 'incoming', t + 1),
      reply_to_id: linked.id,
    });
    const context = [status, alert, captioned, linked, unavailable, request];
    const changes = [
      change('Status item one', status.id),
      change('Status item two', status.id),
      change('Disk alert', alert.id),
      change('Captioned request', captioned.id),
      change('Linked request', linked.id),
      change('Unavailable review', unavailable.id),
      TaskChangeSchema.parse({
        ...change('Multi-source request', status.id),
        source_ids: [status.id, request.id],
      }),
    ];
    const judge = f.store.settings().profiles.find((profile) => profile.id === 'judge');
    assert.ok(judge);
    const screened: string[] = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      if (body.questions[0].type === 'predicate') {
        const evidence = JSON.parse(body.input);
        const observation: string = evidence.observations[0];
        screened.push(observation);
        if (observation.includes('provider failure')) return new Response('', { status: 503 });
        return new Response(
          JSON.stringify({
            answers: [
              {
                name: body.questions[0].name,
                type: 'predicate',
                probability: observation.includes('project-status') ? 0.99 : 0.66,
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          answers: body.questions.map((q: { name: string }) => ({
            name: q.name,
            type: 'choice',
            choice: 'keep',
            confidence: 0.99,
          })),
        }),
        { status: 200 },
      );
    };
    const reviewed = await reviewTaskCandidates(f.store, judge, changes, context);
    assert.deepEqual(
      reviewed.map((item) => item.title),
      [
        'Disk alert',
        'Captioned request',
        'Linked request',
        'Unavailable review',
        'Multi-source request',
      ],
    );
    assert.deepEqual(screened.sort(), [
      'A live dashboard shows high disk usage',
      'A project-status checklist and handoff',
      'A project-status checklist with provider failure',
    ]);
    f.store.cache(context);
    f.store.apply(changes, context);
    const tasks = f.store.snapshot().tasks;
    const filtered = await reviewExistingTasks(f.store, judge, tasks, context);
    for (const item of filtered) f.store.filterNotTask(item.id, item.revision);
    const after = f.store.snapshot().tasks;
    assert.deepEqual(
      after
        .filter((item) => item.done)
        .map((item) => item.title)
        .sort(),
      ['Status item one', 'Status item two'],
    );
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});

test('new candidates are filtered only when the decision service identifies a non-task confidently', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  try {
    const incoming = message(
      'm1',
      'Please fix the export; FYI the meeting ended.',
      'incoming',
      now(),
    );
    f.store.cache([incoming]);
    const candidates = [
      change('Fix the export', 'm1'),
      change('Record the meeting ending', 'm1'),
      change('Check a possible issue', 'm1'),
    ];
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('/chat/completions')) return answer({ changes: candidates });
      const body = JSON.parse(String(options?.body));
      return new Response(
        JSON.stringify({
          answers: body.questions.map((q: { name: string }, i: number) => ({
            name: q.name,
            type: 'choice',
            choice: i === 0 ? 'keep' : 'not_task',
            confidence: i === 2 ? 0.6 : 0.99,
          })),
        }),
        { status: 200 },
      );
    };
    f.store.queueChat('chat', 0, false, true);
    await f.sync.run(['chat']);
    assert.equal(f.store.status().error, null);
    assert.deepEqual(
      f.store
        .snapshot()
        .tasks.map((t) => t.title)
        .sort(),
      ['Check a possible issue', 'Fix the export'],
    );
    assert.equal(f.store.pending([incoming]).length, 0);
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});

test('manual review revisits an already-processed answer, filters an old non-task, and leaves both recoverable', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  try {
    const t = now() - 120;
    const question = message('q', 'What is the rate?', 'incoming', t);
    const reply = message('r', 'The rate is 10%', 'outgoing', t + 1);
    const chatter = message('n', 'The meeting has ended', 'incoming', t + 2);
    f.store.cache([question, reply, chatter]);
    f.store.apply(
      [change('Answer the rate question', 'q'), change('Record the meeting ending', 'n')],
      [question, reply, chatter],
    );
    const tasks = f.store.snapshot().tasks;
    const questionTask = tasks.find((item) => item.title === 'Answer the rate question');
    const nonTask = tasks.find((item) => item.title === 'Record the meeting ending');
    assert.ok(questionTask && nonTask);
    f.store.decide(
      [{ ...completion('r', questionTask.id), action: 'none', task_ids: [], evidence_quote: '' }],
      [reply],
      now(),
    );
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('/chat/completions'))
        return answer({ decisions: [completion('r', questionTask.id)] });
      const body = JSON.parse(String(options?.body));
      return new Response(
        JSON.stringify({
          answers: body.questions.map((q: { name: string; instructions: string }) => ({
            name: q.name,
            type: 'choice',
            confidence: 0.99,
            choice: q.instructions.includes('completion proposal')
              ? 'supported'
              : q.instructions.includes(nonTask.id)
                ? 'not_task'
                : 'keep',
          })),
        }),
        { status: 200 },
      );
    };
    f.store.queueChat('chat', 0, false, true);
    await f.sync.run(['chat']);
    assert.equal(f.store.status().error, null);
    const result = f.store.snapshot().tasks;
    assert.equal(result.find((item) => item.id === questionTask.id)?.done, true);
    assert.equal(result.find((item) => item.id === nonTask.id)?.resolution?.kind, 'filtered');
    f.store.tick(nonTask.id, false);
    assert.equal(f.store.snapshot().tasks.find((item) => item.id === nonTask.id)?.done, false);
    f.store.queueChat('chat', 0, false, true);
    await f.sync.run(['chat']);
    assert.equal(f.store.snapshot().tasks.find((item) => item.id === nonTask.id)?.done, false);
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});

test('a failed decision service keeps new work rather than discarding it', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  try {
    const incoming = message('m', 'Please fix the export', 'incoming', now());
    f.store.cache([incoming]);
    globalThis.fetch = async (url) =>
      String(url).includes('/chat/completions')
        ? answer({ changes: [change('Fix the export', 'm')] })
        : new Response('', { status: 503 });
    f.store.queueChat('chat', 0, false, true);
    await f.sync.run(['chat']);
    assert.equal(f.store.status().error, null);
    assert.equal(f.store.snapshot().tasks[0]?.title, 'Fix the export');
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});

test('Jev can review individual task candidates through its native decision format', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  try {
    const source = message('m', 'Just an update', 'incoming', now());
    const judge = {
      id: 'judge',
      name: 'Jev',
      kind: 'decision',
      provider: 'jev',
      model: 'jev-latest',
      baseUrl: 'https://judge.example/v1',
    } as const;
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), 'https://judge.example/v1/systemone');
      const request = JSON.parse(String(options?.body));
      assert.ok(request.questions.candidate_0);
      return new Response(
        JSON.stringify({
          answers: { candidate_0: { type: 'choice', choice: 'not_task', confidence: 0.99 } },
        }),
        { status: 200 },
      );
    };
    assert.deepEqual(
      await reviewTaskCandidates(f.store, judge, [change('Record the update', 'm')], [source]),
      [],
    );
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});

test('an uncertain completion proposal stays open and asks for confirmation', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  try {
    const t = now() - 120;
    const question = message('q', 'What is the rate?', 'incoming', t);
    const reply = message('r', 'The rate is 10%', 'outgoing', t + 1);
    f.store.cache([question, reply]);
    f.store.apply([change('Fix the export', 'q')], [question, reply]);
    const task = f.store.snapshot().tasks[0];
    assert.ok(task);
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('/chat/completions'))
        return answer({ decisions: [completion('r', task.id)] });
      const body = JSON.parse(String(options?.body));
      return new Response(
        JSON.stringify({
          answers: body.questions.map((q: { name: string; instructions: string }) => ({
            name: q.name,
            type: 'choice',
            confidence: 0.99,
            choice: q.instructions.includes('completion proposal') ? 'uncertain' : 'keep',
          })),
        }),
        { status: 200 },
      );
    };
    f.store.queueChat('chat', 0, false, true);
    await f.sync.run(['chat']);
    assert.equal(f.store.status().error, null);
    assert.equal(f.store.snapshot().tasks[0]?.done, false);
    assert.equal(f.store.snapshot().questions.length, 1);
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});

test('a clearly unrelated reply neither completes a task nor creates a confirmation prompt', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  try {
    const t = now() - 120;
    const question = message('q', 'Please fix the export', 'incoming', t);
    const reply = message('r', 'The rate is 10%', 'outgoing', t + 1);
    f.store.cache([question, reply]);
    f.store.apply([change('Fix the export', 'q')], [question, reply]);
    const task = f.store.snapshot().tasks[0];
    assert.ok(task);
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('/chat/completions'))
        return answer({ decisions: [completion('r', task.id)] });
      const body = JSON.parse(String(options?.body));
      return new Response(
        JSON.stringify({
          answers: body.questions.map((q: { name: string; instructions: string }) => ({
            name: q.name,
            type: 'choice',
            confidence: 0.99,
            choice: q.instructions.includes('completion proposal') ? 'unsupported' : 'keep',
          })),
        }),
        { status: 200 },
      );
    };
    f.store.queueChat('chat', 0, false, true);
    await f.sync.run(['chat']);
    assert.equal(f.store.status().error, null);
    assert.equal(f.store.snapshot().tasks[0]?.done, false);
    assert.equal(f.store.snapshot().questions.length, 0);
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});
