import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { configureDesktopGateway } from '../src/server/desktop.js';

const require = createRequire(import.meta.url);
const { workspaceGatewayMode } = require('../desktop/gateway-mode.cjs') as {
  workspaceGatewayMode(path: string): 'local' | 'remote';
};
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

test('switching WhatsApp servers keeps each server’s chats and credentials separate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat2tasks-gateway-choice-'));
  const store = new Store(join(root, 'workspace'));
  const localKey = join(root, 'local-key');
  await writeFile(localKey, 'local-key');
  const localChat = {
    id: 'local',
    name: 'Local chat',
    sessionId: 'local-session',
    chatId: 'one',
    enabled: true,
  };
  const remoteChat = {
    id: 'remote',
    name: 'Remote chat',
    sessionId: 'remote-session',
    chatId: 'two',
    enabled: true,
  };
  const environment = {
    DESKTOP_OPENWA_URL: 'http://127.0.0.1:1234',
    DESKTOP_OPENWA_KEY_FILE: localKey,
    PUBLIC_ORIGIN: 'http://127.0.0.1:2345',
  };
  try {
    await configureDesktopGateway(store, { ...environment, DESKTOP_GATEWAY_MODE: 'local' });
    store.saveSettings({
      settings: {
        ...store.settings(),
        chats: [localChat],
        desktopGateway: {
          ...store.settings().desktopGateway,
          mode: 'remote',
          remoteUrl: 'http://127.0.0.1:3456',
        },
      },
      secrets: { 'remote-openwa': 'remote-key' },
      removeSecrets: [],
    });
    assert.equal(workspaceGatewayMode(join(root, 'workspace')), 'remote');
    await configureDesktopGateway(store, { ...environment, DESKTOP_GATEWAY_MODE: 'remote' });
    assert.equal(store.settings().openwaUrl, 'http://127.0.0.1:3456');
    assert.equal(store.secret('openwa'), 'remote-key');
    assert.deepEqual(store.settings().chats, []);
    store.saveSettings({
      settings: {
        ...store.settings(),
        chats: [remoteChat],
        desktopGateway: { ...store.settings().desktopGateway, mode: 'local' },
      },
      secrets: {},
      removeSecrets: [],
    });
    await configureDesktopGateway(store, { ...environment, DESKTOP_GATEWAY_MODE: 'local' });
    assert.deepEqual(store.settings().chats, [localChat]);
    assert.equal(store.secret('openwa'), 'local-key');
    assert.equal(store.secret('remote-openwa'), 'remote-key');
    store.saveSettings({
      settings: {
        ...store.settings(),
        desktopGateway: { ...store.settings().desktopGateway, mode: 'remote' },
      },
      secrets: {},
      removeSecrets: [],
    });
    await configureDesktopGateway(store, { ...environment, DESKTOP_GATEWAY_MODE: 'remote' });
    assert.deepEqual(store.settings().chats, [remoteChat]);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
