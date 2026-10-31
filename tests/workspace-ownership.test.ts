import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { MoveGate } from '../src/server/move-gate.js';
import { WorkspaceOwnership } from '../src/server/workspace-ownership.js';

test('a move stops new writes and waits for already accepted work to finish', async () => {
  const app = Fastify();
  const gate = new MoveGate(app);
  let begin!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => (begin = resolve));
  const release = new Promise<void>((resolve) => (finish = resolve));
  let writes = 0;
  app.post('/api/slow', async () => {
    begin();
    await release;
    writes++;
    return { ok: true };
  });
  try {
    const first = app.inject({ method: 'POST', url: '/api/slow' }).then((response) => response);
    await started;
    let drained = false;
    const stopping = gate.pause().then(() => {
      drained = true;
    });
    assert.equal((await app.inject({ method: 'POST', url: '/api/slow' })).statusCode, 503);
    assert.equal(drained, false);
    finish();
    assert.equal((await first).statusCode, 200);
    await stopping;
    assert.equal(writes, 1);
  } finally {
    finish();
    await app.close();
  }
});

test('a move fences the old server and only the intended computer can stage the snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat2tasks-owner-'));
  try {
    const sourceDir = join(root, 'source');
    const targetDir = join(root, 'target');
    const otherDir = join(root, 'other');
    const source = WorkspaceOwnership.open(sourceDir, 'server');
    const target = WorkspaceOwnership.open(targetDir, 'client');
    const other = WorkspaceOwnership.open(otherDir, 'client');
    const archive = join(root, 'workspace.snapshot');
    await writeFile(archive, 'fictional workspace snapshot');
    const digest = createHash('sha256').update('fictional workspace snapshot').digest('hex');
    const move = {
      id: randomUUID(),
      target: target.identity(),
      targetOrigin: 'https://target.example:8443',
    };
    const trustedSource = source.identity().signingPublicKey;
    const passphrase = 'fictional-secret-for-destination';
    source.prepare(move);
    assert.throws(() => WorkspaceOwnership.open(sourceDir, 'server').assertCanRun(), /move/i);

    const grant = source.fence(move.id, digest, passphrase);
    assert.equal(JSON.stringify(grant).includes(passphrase), false);
    assert.deepEqual(
      source.fence(move.id, digest, passphrase),
      grant,
      'a lost response can be retried',
    );
    assert.deepEqual(
      WorkspaceOwnership.open(sourceDir, 'server').grant(move.id),
      grant,
      'the source can recover the same authorization after restart',
    );
    assert.throws(() => source.fence(move.id, '0'.repeat(64), passphrase), /snapshot/i);
    assert.throws(() => WorkspaceOwnership.open(sourceDir, 'server').assertCanRun(), /move/i);
    await assert.rejects(
      target.stage(grant, other.identity().signingPublicKey, archive),
      /authorization/i,
    );
    await assert.rejects(
      target.stage(
        { ...grant, payload: { ...grant.payload, digest: '0'.repeat(64) } },
        trustedSource,
        archive,
      ),
      /authorization/i,
    );
    await assert.rejects(other.stage(grant, trustedSource, archive), /target/i);
    await writeFile(archive, 'a different snapshot');
    await assert.rejects(target.stage(grant, trustedSource, archive), /snapshot/i);
    await writeFile(archive, 'fictional workspace snapshot');
    assert.equal(await target.stage(grant, trustedSource, archive), passphrase);
    assert.throws(() => WorkspaceOwnership.open(targetDir, 'client').assertCanRun(), /move/i);
    assert.throws(() => WorkspaceOwnership.open(sourceDir, 'server').assertCanRun(), /move/i);
    await target.stage(grant, trustedSource, archive);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a destination cannot replace a different active workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat2tasks-owner-'));
  try {
    const source = WorkspaceOwnership.open(join(root, 'source'), 'server');
    const target = WorkspaceOwnership.open(join(root, 'target'), 'server');
    const archive = join(root, 'workspace.snapshot');
    await writeFile(archive, 'fictional workspace snapshot');
    const digest = createHash('sha256').update('fictional workspace snapshot').digest('hex');
    const move = {
      id: randomUUID(),
      target: target.identity(),
      targetOrigin: 'https://target.example',
    };
    source.prepare(move);
    const grant = source.fence(move.id, digest, 'fictional-secret-for-destination');
    await assert.rejects(
      target.stage(grant, source.identity().signingPublicKey, archive),
      /already/i,
    );
    target.assertCanRun();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
