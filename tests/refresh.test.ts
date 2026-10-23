import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RefreshGate } from '../src/shared/refresh.js';

test('slow polls can settle while older responses and pre-mutation responses stay stale', () => {
  const gate = new RefreshGate();
  const first = gate.start();
  const second = gate.start();

  assert.equal(gate.accept(first), true);
  assert.equal(gate.accept(second), true);
  assert.equal(gate.accept(first), false);

  const beforeCompletion = gate.start();
  gate.invalidate();
  assert.equal(gate.accept(beforeCompletion), false);
  assert.equal(gate.accept(gate.start()), true);
});
