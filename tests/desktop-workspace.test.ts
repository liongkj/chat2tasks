import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { replaceWorkspace } = require('../desktop/workspace-replace.cjs') as {
  replaceWorkspace(options: {
    workspace: string;
    source: string;
    passphrase: string;
    stopServer(): Promise<void>;
    startServer(): Promise<void>;
    runImport(source: string, destination: string, passphrase: string): Promise<boolean>;
  }): Promise<{ ok: boolean }>;
};

test('a failed desktop import restores the existing workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat2tasks-replace-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'marker'), 'original');
  let started = 0;
  try {
    const result = await replaceWorkspace({
      workspace,
      source: 'fixture.c2t',
      passphrase: 'incorrect',
      stopServer: async () => undefined,
      startServer: async () => {
        started++;
      },
      runImport: async () => false,
    });
    assert.equal(result.ok, false);
    assert.equal(await readFile(join(workspace, 'marker'), 'utf8'), 'original');
    assert.equal(started, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a successful desktop import keeps the old workspace as a backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat2tasks-replace-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'marker'), 'original');
  try {
    const result = await replaceWorkspace({
      workspace,
      source: 'fixture.c2t',
      passphrase: 'example passphrase',
      stopServer: async () => undefined,
      startServer: async () => undefined,
      runImport: async (_source, destination) => {
        await mkdir(destination);
        await writeFile(join(destination, 'marker'), 'imported');
        return true;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(await readFile(join(workspace, 'marker'), 'utf8'), 'imported');
    const backup = (await readdir(root)).find((name) =>
      name.startsWith('workspace.before-import-'),
    );
    assert.ok(backup);
    assert.equal(await readFile(join(root, backup, 'marker'), 'utf8'), 'original');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
