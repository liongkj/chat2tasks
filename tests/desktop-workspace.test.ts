import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { configureDesktopGateway } from '../src/server/desktop.js';

const require = createRequire(import.meta.url);
const { workspaceGatewayLaunch, workspaceSharingPort } = require('../desktop/gateway-mode.cjs') as {
  workspaceGatewayLaunch(path: string): {
    mode: 'local' | 'remote';
    engine: 'whatsapp-web.js' | 'baileys';
    resumeSessions: boolean;
  };
  workspaceSharingPort(path: string): number | undefined;
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

test('desktop sharing keeps a stable local port and its password across settings saves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat2tasks-desktop-sharing-'));
  try {
    assert.equal(workspaceSharingPort(root), undefined);
    const store = new Store(root);
    try {
      store.saveDesktopSharing({
        kind: 'enabled',
        origin: 'https://shared.example:8443',
        port: 2786,
        password: 'fictional-sharing-password',
      });
      store.saveSettings({ settings: store.settings(), secrets: {}, removeSecrets: [] });
      assert.equal(store.secret('desktop-sharing-password'), 'fictional-sharing-password');
    } finally {
      store.close();
    }
    assert.equal(workspaceSharingPort(root), 2786);
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
    assert.deepEqual(workspaceGatewayLaunch(join(root, 'workspace')), {
      mode: 'remote',
      engine: 'whatsapp-web.js',
      resumeSessions: false,
    });
    store.setMeta('desktop_setup_complete', true);
    assert.deepEqual(workspaceGatewayLaunch(join(root, 'workspace')), {
      mode: 'remote',
      engine: 'whatsapp-web.js',
      resumeSessions: true,
    });
    store.setMeta('desktop_setup_complete', false);
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

test('switching local WhatsApp connection types keeps their followed chats separate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wawa-engine-choice-'));
  const store = new Store(join(root, 'workspace'));
  const key = join(root, 'gateway-key');
  await writeFile(key, 'fictional-key');
  const environment = {
    PUBLIC_ORIGIN: 'http://127.0.0.1:2345',
    DESKTOP_OPENWA_URL: 'http://127.0.0.1:1234',
    DESKTOP_OPENWA_KEY_FILE: key,
    DESKTOP_GATEWAY_MODE: 'local',
  };
  const webChat = {
    id: 'web',
    name: 'Web chat',
    sessionId: 'web-session',
    chatId: 'one',
    enabled: true,
  };
  const lightChat = {
    id: 'light',
    name: 'Light chat',
    sessionId: 'light-session',
    chatId: 'two',
    enabled: true,
  };
  try {
    await configureDesktopGateway(store, environment);
    store.saveSettings({
      settings: {
        ...store.settings(),
        chats: [webChat],
        desktopGateway: { ...store.settings().desktopGateway, engine: 'baileys' },
      },
      secrets: {},
      removeSecrets: [],
    });
    assert.equal(workspaceGatewayLaunch(join(root, 'workspace')).engine, 'baileys');
    await configureDesktopGateway(store, { ...environment, DESKTOP_GATEWAY_ENGINE: 'baileys' });
    assert.deepEqual(store.settings().chats, []);
    store.saveSettings({
      settings: {
        ...store.settings(),
        chats: [lightChat],
        desktopGateway: { ...store.settings().desktopGateway, engine: 'whatsapp-web.js' },
      },
      secrets: {},
      removeSecrets: [],
    });
    await configureDesktopGateway(store, {
      ...environment,
      DESKTOP_GATEWAY_ENGINE: 'whatsapp-web.js',
    });
    assert.deepEqual(store.settings().chats, [webChat]);
    store.saveSettings({
      settings: {
        ...store.settings(),
        desktopGateway: { ...store.settings().desktopGateway, engine: 'baileys' },
      },
      secrets: {},
      removeSecrets: [],
    });
    await configureDesktopGateway(store, { ...environment, DESKTOP_GATEWAY_ENGINE: 'baileys' });
    assert.deepEqual(store.settings().chats, [lightChat]);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a managed server connects its WhatsApp gateway using its private callback and key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wawa-server-gateway-'));
  const store = new Store(join(root, 'workspace'));
  const key = join(root, 'gateway-key');
  await writeFile(key, 'fictional-server-key');
  try {
    await configureDesktopGateway(store, {
      PUBLIC_ORIGIN: 'https://workspace.example.test:8443',
      DESKTOP_OPENWA_URL: 'http://openwa:2785',
      DESKTOP_OPENWA_KEY_FILE: key,
      DESKTOP_WEBHOOK_URL: 'http://wawa:2786/api/webhooks/openwa',
      DESKTOP_GATEWAY_ENGINE: 'baileys',
      WAWA_MANAGED_SERVER: 'true',
    });
    assert.equal(store.settings().openwaUrl, 'http://openwa:2785');
    assert.equal(store.settings().webhookUrl, 'http://wawa:2786/api/webhooks/openwa');
    assert.equal(store.secret('openwa'), 'fictional-server-key');
    assert.equal(store.settings().desktopGateway.engine, 'baileys');
    assert.equal(store.settings().desktopGateway.activeEngine, 'baileys');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
