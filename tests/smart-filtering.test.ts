import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, now } from '../src/server/store.js';
import { OpenWA } from '../src/server/openwa.js';
import { Sync } from '../src/server/sync.js';
import {
  DecisionSchema,
  MessageSchema,
  TaskChangeSchema,
  WaitChangeSchema,
} from '../src/shared/schema.js';
import {
  reviewTaskCandidates,
  reviewExistingTasks,
  reviewCompletions,
  reviewWaitCandidates,
  reviewWaitResponses,
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
            choice:
              q.name === 'kind' ? 'task' : q.name.startsWith('completion_') ? 'supported' : 'keep',
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
    assert.equal(inputs.length, 4);
    for (const input of inputs) {
      assert.match(input, /What is the rate\?/);
      assert.match(input, /For the export/);
      assert.doesNotMatch(input, /Private unrelated conversation/);
    }
    assert.match(inputs[3] ?? '', /The rate is 10%/);
    assert.doesNotMatch(inputs[3] ?? '', /Other task/);
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});

test('completion review does not send personal organization or notes to the decision provider', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  try {
    const source = message('source', 'What is the rate?', 'incoming', now() - 2);
    const reply = message('reply', 'The rate is 10%', 'outgoing', now() - 1);
    f.store.cache([source, reply]);
    f.store.apply([change('Rate question', source.id)], [source]);
    const task = f.store.snapshot().tasks[0];
    assert.ok(task);
    f.store.remark(task.id, 'Private personal note');
    f.store.setGtd(task.id, { project: 'Private project', area: 'Private area' });
    const current = f.store.taskEvidence(task.id).task;
    const judge = f.store.settings().profiles.find((profile) => profile.id === 'judge');
    assert.ok(judge);
    let input = '';
    globalThis.fetch = async (_url, options) => {
      input = JSON.parse(String(options?.body)).input;
      return new Response(
        JSON.stringify({
          answers: [
            { name: 'completion_0', type: 'choice', choice: 'supported', confidence: 0.99 },
          ],
        }),
        { status: 200 },
      );
    };
    await reviewCompletions(
      f.store,
      judge,
      [DecisionSchema.parse(completion(reply.id, task.id))],
      [reply],
      [current],
      [source, reply],
    );
    assert.match(input, /What is the rate/);
    assert.doesNotMatch(input, /Private personal note|Private project|Private area/);
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});

test('questions and reminders are categorized and are not filtered as non-tasks', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  try {
    const source = message(
      'source',
      'A question, a reminder, and other context',
      'incoming',
      now(),
    );
    const changes = [
      change('Question', source.id),
      change('Reminder', source.id),
      change('Uncertain reminder', source.id),
      change('Not an item', source.id),
    ];
    const judge = f.store.settings().profiles.find((profile) => profile.id === 'judge');
    assert.ok(judge);
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      const isKind = body.questions[0].name === 'kind';
      const title = isKind ? JSON.parse(body.input).item.title : '';
      return new Response(
        JSON.stringify({
          answers: body.questions.map((q: { name: string }) => ({
            name: q.name,
            type: 'choice',
            choice: isKind
              ? title === 'Question'
                ? 'question'
                : title.includes('reminder') || title === 'Reminder'
                  ? 'reminder'
                  : 'task'
              : 'not_task',
            confidence: title === 'Uncertain reminder' ? 0.4 : 0.99,
          })),
        }),
        { status: 200 },
      );
    };
    const result = await reviewTaskCandidates(f.store, judge, changes, [source]);
    assert.deepEqual(
      result.map((item) => item.title),
      ['Question', 'Reminder', 'Uncertain reminder'],
    );
    assert.equal(result[0]?.kind, 'question');
    assert.equal(result[1]?.kind, 'reminder');
    assert.equal(result[2]?.kind, 'task');
    assert.equal(result[2]?.kind_suggestion, 'reminder');
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});

test('a question found only in an uncaptioned screenshot needs owner review', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  try {
    const source = MessageSchema.parse({
      ...message('image', '', 'incoming', now()),
      type: 'image',
      image_reading: {
        message_id: 'image',
        observations: ['Who should approve this?'],
        uncertainties: [],
      },
    });
    const judge = f.store.settings().profiles.find((profile) => profile.id === 'judge');
    assert.ok(judge);
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          answers: [{ name: 'kind', type: 'choice', choice: 'question', confidence: 0.99 }],
        }),
        { status: 200 },
      );
    const [result] = await reviewTaskCandidates(
      f.store,
      judge,
      [change('Approval question', source.id)],
      [source],
    );
    assert.equal(result?.kind, 'task');
    assert.equal(result?.kind_suggestion, 'question');
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});

test('waiting-for extraction keeps uncertain requests reviewable and excludes answered or incoming requests', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  try {
    const request = message('request', 'Please send the PDF', 'outgoing', now() - 3);
    const answered = message('answered', 'Please send the figures', 'outgoing', now() - 2);
    const incoming = message('incoming', 'Please send the agenda', 'incoming', now() - 1);
    const candidates = [
      WaitChangeSchema.parse({
        id: null,
        expected: 'PDF',
        person: null,
        task_id: null,
        source_ids: [request.id],
      }),
      WaitChangeSchema.parse({
        id: null,
        expected: 'Figures',
        person: null,
        task_id: null,
        source_ids: [answered.id],
      }),
      WaitChangeSchema.parse({
        id: null,
        expected: 'Unclear',
        person: null,
        task_id: null,
        source_ids: [request.id],
      }),
      WaitChangeSchema.parse({
        id: null,
        expected: 'Agenda',
        person: null,
        task_id: null,
        source_ids: [incoming.id],
      }),
    ];
    const judge = f.store.settings().profiles.find((profile) => profile.id === 'judge');
    assert.ok(judge);
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      const expected = JSON.parse(body.input).wait.expected;
      return new Response(
        JSON.stringify({
          answers: [
            {
              name: 'waiting',
              type: 'choice',
              choice:
                expected === 'Figures'
                  ? 'not_waiting'
                  : expected === 'Unclear'
                    ? 'uncertain'
                    : 'waiting',
              confidence: 0.99,
            },
          ],
        }),
        { status: 200 },
      );
    };
    const result = await reviewWaitCandidates(f.store, judge, candidates, [
      request,
      answered,
      incoming,
    ]);
    assert.deepEqual(
      result.map((wait) => wait.expected),
      ['PDF', 'Unclear'],
    );
    assert.equal(result[0]?.needs_review, false);
    assert.equal(result[1]?.needs_review, true);
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});

test('a matching reply resolves only the wait while an unrelated reply is ignored', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  try {
    const source = message('source', 'Please fix the export', 'incoming', now() - 5);
    const request = message('request', 'Please send the PDF', 'outgoing', now() - 4);
    const unrelated = message('unrelated', 'Lunch is ready', 'incoming', now() - 3);
    const reply = MessageSchema.parse({
      ...message('reply', 'Here is the PDF', 'incoming', now() - 2),
      reply_to_id: request.id,
    });
    f.store.cache([source, request, unrelated, reply]);
    f.store.apply([change('Fix the export', source.id)], [source]);
    const task = f.store.snapshot().tasks[0];
    assert.ok(task);
    const wait = f.store.createWait({
      expected: 'The PDF',
      person: null,
      task_id: task.id,
      source_ids: [request.id],
    });
    const judge = f.store.settings().profiles.find((profile) => profile.id === 'judge');
    assert.ok(judge);
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      const candidate = JSON.parse(body.input).reply.body;
      return new Response(
        JSON.stringify({
          answers: [
            {
              name: 'response',
              type: 'choice',
              choice: candidate.includes('PDF') ? 'received' : 'not_received',
              confidence: 0.99,
            },
          ],
        }),
        { status: 200 },
      );
    };
    const reviewed = await reviewWaitResponses(
      f.store,
      judge,
      [wait],
      [source, request, unrelated, reply],
    );
    assert.equal(reviewed.length, 1);
    assert.equal(reviewed[0]?.response_id, reply.id);
    assert.equal(reviewed[0]?.needs_review, false);
    const result = reviewed[0];
    assert.ok(result);
    f.store.cache([{ ...reply, body: 'I will send it later' }]);
    assert.equal(
      f.store.autoReceiveWait(
        result.id,
        result.revision,
        result.response_id,
        result.response_fingerprint,
      ),
      false,
    );
    f.store.cache([reply]);
    assert.equal(
      f.store.autoReceiveWait(
        result.id,
        result.revision,
        result.response_id,
        result.response_fingerprint,
      ),
      true,
    );
    assert.equal(f.store.waitEvidence(wait.id).wait.state, 'received');
    assert.equal(f.store.taskEvidence(task.id).task.done, false);
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});

test('manual review can resolve an outstanding wait even when no tasks are open', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  try {
    const request = message('request', 'Please send the PDF', 'outgoing', now() - 120);
    const reply = MessageSchema.parse({
      ...message('reply', 'Here is the PDF', 'incoming', now() - 110),
      reply_to_id: request.id,
    });
    f.store.cache([request, reply]);
    f.store.apply([], [request, reply]);
    const wait = f.store.createWait({
      expected: 'The PDF',
      person: null,
      task_id: null,
      source_ids: [request.id],
    });
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          answers: [{ name: 'response', type: 'choice', choice: 'received', confidence: 0.99 }],
        }),
        { status: 200 },
      );
    f.store.queueChat('chat', 0, false, true);
    await f.sync.run(['chat']);
    assert.equal(f.store.status().error, null);
    assert.equal(f.store.waitEvidence(wait.id).wait.state, 'received');
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});

test('an outgoing request is saved to Waiting for after decision review', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  try {
    const request = message('request', 'Please send me the PDF', 'outgoing', now());
    f.store.cache([request]);
    const wait = {
      id: null,
      expected: 'The PDF',
      person: null,
      task_id: null,
      source_ids: [request.id],
    };
    globalThis.fetch = async (url) =>
      String(url).includes('/chat/completions')
        ? answer({ changes: [], waits: [wait] })
        : new Response(
            JSON.stringify({
              answers: [{ name: 'waiting', type: 'choice', choice: 'waiting', confidence: 0.99 }],
            }),
            { status: 200 },
          );
    f.store.queueChat('chat', 0, false, true);
    await f.sync.run(['chat']);
    assert.equal(f.store.status().error, null);
    assert.equal(f.store.snapshot().waiting_for[0]?.expected, 'The PDF');
    assert.equal(f.store.snapshot().waiting_for[0]?.needs_review, false);
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});

test('a newly discovered wait checks an earlier unlinked reply before presenting it as outstanding', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  try {
    const request = message('request', 'Please send the PDF', 'outgoing', now() - 20);
    const reply = message('reply', 'Here is the PDF', 'incoming', now() - 10);
    f.store.cache([request, reply]);
    f.store.apply([], [reply]);
    const wait = {
      id: null,
      expected: 'The PDF',
      person: null,
      task_id: null,
      source_ids: [request.id],
    };
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('/chat/completions')) return answer({ changes: [], waits: [wait] });
      const body = JSON.parse(String(options?.body));
      const name = body.questions[0].name;
      return new Response(
        JSON.stringify({
          answers: [
            {
              name,
              type: 'choice',
              choice: name === 'trigger' ? 'run' : name === 'response' ? 'received' : 'waiting',
              confidence: 0.99,
            },
          ],
        }),
        { status: 200 },
      );
    };
    f.store.queueChat('chat', 0, false);
    await f.sync.run(['chat']);
    assert.equal(f.store.status().error, null);
    const discovered = f.store.snapshot().waiting_for[0];
    assert.equal(discovered?.needs_review, true);
    assert.equal(discovered?.response_id, reply.id);
  } finally {
    globalThis.fetch = original;
    f.close();
  }
});

test('a clear answer can resolve a question without automatically dismissing a reminder', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  try {
    const source = message('source', 'What is the rate?', 'incoming', now() - 2);
    const reply = message('reply', 'The rate is 10%', 'outgoing', now() - 1);
    f.store.cache([source, reply]);
    f.store.apply(
      [
        { ...change('Rate question', source.id), kind: 'question' },
        { ...change('Status reminder', source.id), kind: 'reminder' },
        { ...change('Uncertain item', source.id), kind_suggestion: 'reminder' },
      ],
      [source, reply],
    );
    const tasks = f.store.snapshot().tasks;
    const question = tasks.find((item) => item.title === 'Rate question');
    const reminder = tasks.find((item) => item.title === 'Status reminder');
    const uncertain = tasks.find((item) => item.title === 'Uncertain item');
    assert.ok(question && reminder && uncertain);
    const judge = f.store.settings().profiles.find((profile) => profile.id === 'judge');
    assert.ok(judge);
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      return new Response(
        JSON.stringify({
          answers: body.questions.map((q: { name: string }) => ({
            name: q.name,
            type: 'choice',
            choice: 'supported',
            confidence: 0.99,
          })),
        }),
        { status: 200 },
      );
    };
    const decisions = [
      DecisionSchema.parse(completion(reply.id, question.id)),
      DecisionSchema.parse(completion(reply.id, reminder.id)),
      DecisionSchema.parse(completion(reply.id, uncertain.id)),
    ];
    const reviewed = await reviewCompletions(f.store, judge, decisions, [reply], tasks, [
      source,
      reply,
    ]);
    assert.equal(reviewed[0]?.action, 'complete');
    assert.equal(reviewed[1]?.action, 'none');
    assert.equal(reviewed[2]?.action, 'ask');
    const reminderDecision = decisions[1];
    assert.ok(reminderDecision);
    assert.throws(() => f.store.decide([reminderDecision], [reply], now()), /Reminders require/);
    const uncertainDecision = decisions[2];
    assert.ok(uncertainDecision);
    assert.throws(
      () => f.store.decide([uncertainDecision], [reply], now()),
      /category needs review/,
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
            choice: q.name === 'kind' ? 'task' : i === 0 ? 'keep' : 'not_task',
            confidence: q.name === 'kind' ? 0.99 : i === 2 ? 0.6 : 0.99,
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
    f.store.saveSettings({
      settings: { ...f.store.settings(), trigger: { mode: 'manual', decisionProfileId: 'judge' } },
      secrets: {},
      removeSecrets: [],
    });
    let decisionCalls = 0;
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
      decisionCalls++;
      const body = JSON.parse(String(options?.body));
      return new Response(
        JSON.stringify({
          answers: body.questions.map((q: { name: string; instructions: string }) => ({
            name: q.name,
            type: 'choice',
            confidence: 0.99,
            choice:
              q.name === 'kind'
                ? 'task'
                : q.instructions.includes('completion proposal')
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
    assert.ok(decisionCalls > 0, 'manual review must use its selected decision connection');
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
      const kind = Boolean(request.questions.kind);
      assert.ok(kind || request.questions.candidate_0);
      return new Response(
        JSON.stringify({
          answers: kind
            ? { kind: { type: 'choice', choice: 'task', confidence: 0.99 } }
            : { candidate_0: { type: 'choice', choice: 'not_task', confidence: 0.99 } },
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
