import { test, expect, chromium } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { z } from 'zod';
import {
  PairCodeSchema,
  DevicesSchema,
  CompanionStateSchema,
  ConnectionSchema,
} from '../src/shared/companion.js';
import { SnapshotSchema } from '../src/shared/schema.js';

let directory: string, backend: ChildProcess, base: string;
const password = 'isolated-extension-fixture';
async function owner(path: string, body?: unknown) {
  return fetch(base + '/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from('admin:' + password).toString('base64'),
      Origin: base,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'chat2tasks-extension-e2e-'));
  const socket = createServer();
  await new Promise<void>((done) => socket.listen(0, '127.0.0.1', done));
  const address = socket.address();
  if (!address || typeof address === 'string') throw Error('No fixture port');
  const port = address.port;
  await new Promise<void>((done) => socket.close(() => done()));
  base = 'http://127.0.0.1:' + port;
  backend = spawn(process.execPath, ['dist/server/index.js'], {
    env: {
      ...process.env,
      DEMO: 'true',
      PORT: String(port),
      DATA_DIR: join(directory, 'data'),
      APP_PASSWORD: password,
    },
    stdio: 'ignore',
  });
  await expect
    .poll(async () => {
      try {
        return (await fetch(base + '/api/health')).status;
      } catch {
        return 0;
      }
    })
    .toBe(200);
});
test.afterAll(async () => {
  if (backend?.exitCode === null) {
    const closed = new Promise<void>((done) => backend.once('exit', () => done()));
    backend.kill('SIGTERM');
    await closed;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('packaged companion pairs, changes tasks, reviews captures, and loses access immediately after revocation', async () => {
  const extension = join(directory, 'approved-extension');
  await cp(resolve('dist/extension'), extension, { recursive: true });
  // Pre-approve the fixture's localhost host access; native Chrome permission bubbles need a person.
  const manifest = z
    .looseObject({
      manifest_version: z.literal(3),
      host_permissions: z.array(z.string()).optional(),
    })
    .parse(JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8')));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(join(directory, 'browser'), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 390, height: 900 },
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto('chrome-extension://' + id + '/index.html');
    const code = PairCodeSchema.parse(await (await owner('extensions/pairing', {})).json());
    await page.getByLabel('Server address').fill(base);
    await page.getByLabel('Pairing code').fill(code.code);
    await page.getByRole('button', { name: 'Connect workspace' }).click();
    await expect(page.getByRole('heading', { name: 'Your next moves.' })).toBeVisible();
    const title = 'Review the onboarding flow before Friday';
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('companion.png') });
    await page.getByText(title, { exact: true }).click();
    await page.getByLabel('Your note').fill('A note from the companion');
    await page.getByRole('button', { name: 'Save note' }).click();
    await expect
      .poll(async () => {
        const snapshot = SnapshotSchema.parse(await (await owner('state')).json());
        return snapshot.tasks.find((t) => t.title === title)?.own_remark;
      })
      .toBe('A note from the companion');
    await page.getByRole('button', { name: 'Mark complete', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Mark as to do', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Back to tasks' }).click();
    await page.getByRole('button', { name: 'Conversations', exact: true }).click();
    await page.getByRole('switch', { name: 'Activate Design team' }).click();
    await expect(page.getByRole('switch', { name: 'Activate Design team' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await page.getByRole('switch', { name: 'Activate Design team' }).click();
    await expect(page.getByRole('switch', { name: 'Activate Design team' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const before = SnapshotSchema.parse(await (await owner('state')).json());
    // The native context menu writes this ephemeral draft; exercise the same Chrome storage event in isolation.
    await worker.evaluate(async () => {
      await chrome.storage.session.set({
        captureDraft: {
          id: 'e0551cb8-24f6-4a03-85ce-a4cc4fa252e6',
          text: 'Please check the export column',
          url: 'https://web.whatsapp.com/',
          title: 'WhatsApp Web',
        },
      });
    });
    await expect(page.getByLabel('Selected text')).toHaveValue('Please check the export column');
    expect(SnapshotSchema.parse(await (await owner('state')).json()).messages.length).toBe(
      before.messages.length,
    );
    await page.getByRole('button', { name: 'Save selection', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Selection saved.');
    const after = SnapshotSchema.parse(await (await owner('state')).json());
    expect(after.messages.length).toBe(before.messages.length + 1);
    expect(
      after.messages.find((m) => m.body === 'Please check the export column')?.browser_source?.url,
    ).toBe('https://web.whatsapp.com/');
    expect(after.usage.calls).toBe(0);
    const stored = await page.evaluate(async () => chrome.storage.local.get('connection'));
    const connection = ConnectionSchema.parse(stored.connection);
    const headers = {
      Authorization: 'Bearer ' + connection.token,
      'X-Chat2Tasks-Extension': id,
      Origin: 'chrome-extension://' + id,
    };
    expect((await fetch(base + '/api/companion/state', { headers })).status).toBe(200);
    expect((await fetch(base + '/api/settings', { headers })).status).toBe(401);
    expect(
      (
        await fetch(base + '/api/companion/state', {
          headers: { ...headers, Origin: 'https://unrelated.example' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(base + '/api/companion/state', {
          method: 'OPTIONS',
          headers: {
            Origin: 'chrome-extension://' + id,
            'Access-Control-Request-Headers': 'authorization,x-chat2tasks-extension',
          },
        })
      ).status,
    ).toBe(204);
    const state = CompanionStateSchema.parse(
      await (await fetch(base + '/api/companion/state', { headers })).json(),
    );
    expect(state).not.toHaveProperty('configuredSecrets');
    expect(state).not.toHaveProperty('messages');
    const devices = DevicesSchema.parse(await (await owner('extensions')).json());
    expect(devices.devices.length).toBe(1);
    await owner('extensions/' + devices.devices[0]?.id + '/revoke', {});
    expect((await fetch(base + '/api/companion/state', { headers })).status).toBe(401);
    await page.getByRole('button', { name: 'My tasks', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh tasks' }).click();
    await expect(page.getByRole('button', { name: 'Connect workspace' })).toBeVisible();
  } finally {
    await context.close();
  }
});
