import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionRequest, parseNativeDecision, conservativeGate } from '../src/server/decisions.js';
import { MessageSchema, type Profile } from '../src/shared/schema.js';

test('Jev uses its native criteria-map API, while OpenAI Decisions uses named choice questions', () => {
  const jev = {
    id: 'j',
    name: 'Jev',
    kind: 'decision',
    provider: 'jev',
    baseUrl: 'https://api.typesafe.ai/v1',
    model: 'jev-latest',
  } satisfies Profile;
  const request = decisionRequest(jev, { messages: ['Hello'] });
  assert.equal(request.url, 'https://api.typesafe.ai/v1/systemone');
  assert.ok('trigger' in request.body.questions);
  assert.ok(!('messages' in request.body));
  const openai = decisionRequest(
    { ...jev, provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-luna' },
    { messages: ['Hello'] },
  );
  assert.equal(openai.url, 'https://api.openai.com/v1/decisions');
  assert.ok(Array.isArray(openai.body.questions));
  assert.equal(
    parseNativeDecision('jev', {
      answers: { trigger: { type: 'choice', choice: 'skip', confidence: 0.99 } },
    }).choice,
    'skip',
  );
  assert.equal(
    parseNativeDecision('openai', {
      answers: [{ name: 'trigger', type: 'choice', choice: 'wait', confidence: 0.9 }],
    }).choice,
    'wait',
  );
});
test('uncertainty, attachments, and outgoing completion evidence cannot be silently skipped', () => {
  const message = MessageSchema.parse({
    id: 'm',
    sessionId: 's',
    chatId: 'c',
    body: 'Done',
    direction: 'incoming',
    type: 'text',
    timestamp: 1,
  });
  const skip = { choice: 'skip', confidence: 0.99, reason: 'Chatter' } satisfies Parameters<
    typeof conservativeGate
  >[0];
  assert.equal(conservativeGate(skip, [message], 0).choice, 'skip');
  assert.equal(conservativeGate({ ...skip, confidence: 0.5 }, [message], 0).choice, 'run');
  assert.equal(conservativeGate(skip, [{ ...message, type: 'image' }], 0).choice, 'run');
  assert.equal(conservativeGate(skip, [{ ...message, direction: 'outgoing' }], 0).choice, 'run');
});
test('a wait decision cannot push an already three-minute-old burst back again', () => {
  assert.equal(
    conservativeGate({ choice: 'wait', confidence: 0.99, reason: 'More is coming' }, [], 180)
      .choice,
    'run',
  );
  assert.equal(
    parseNativeDecision('openai', { answers: [{ type: 'refusal', name: 'trigger' }] }).choice,
    'run',
  );
});
