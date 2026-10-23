import { test, expect, chromium, type Page } from '@playwright/test';
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
import { SnapshotSchema, PublicSettingsSchema } from '../src/shared/schema.js';

let directory: string, backend: ChildProcess, base: string;
const password = 'isolated-extension-fixture';
async function expectReadableTasks(page: Page, selector: string) {
  const text = await page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const luminance = (color: string) => {
        const channels = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map((channel) => {
          const value = Number(channel) / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return (
          (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722
        );
      };
      let background = 'rgb(255, 255, 255)';
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        const color = getComputedStyle(ancestor).backgroundColor;
        if (color.startsWith('rgb(')) {
          background = color;
          break;
        }
      }
      const foreground = luminance(getComputedStyle(element).color),
        surface = luminance(background);
      return {
        size: Number.parseFloat(getComputedStyle(element).fontSize),
        contrast: (Math.max(foreground, surface) + 0.05) / (Math.min(foreground, surface) + 0.05),
      };
    });
  expect(text.size, 'Task text must stay at least 14px').toBeGreaterThanOrEqual(14);
  expect(text.contrast, 'Task text must retain readable 4.5:1 contrast').toBeGreaterThanOrEqual(
    4.5,
  );
}
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
    .poll(
      async () => {
        try {
          return (await fetch(base + '/api/health')).status;
        } catch {
          return 0;
        }
      },
      { timeout: 15000 },
    )
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

test('readable workspace keeps completion, notes, source context, and mobile navigation working', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1080, height: 1058 },
    deviceScaleFactor: 1,
    httpCredentials: { username: 'admin', password },
  });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base);
    const title = 'Review the onboarding flow before Friday';
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'From the conversation' })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('workspace.png') });
    await expectReadableTasks(page, '.task-title');
    await expectReadableTasks(page, '.task-row-sub');
    // Protect the reported unreadable-text regression on the primary task surface.
    expect(
      await page
        .locator('.task-title')
        .first()
        .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
    ).toBeGreaterThanOrEqual(16);
    expect(
      await page
        .locator('.task-row-sub')
        .first()
        .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
    ).toBeGreaterThanOrEqual(14);
    await page.getByRole('button', { name: 'View conversation', exact: true }).click();
    await expect(
      page.getByText('Could you take a look at the new onboarding flow?', { exact: false }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Back to task', exact: true }).click();
    await page
      .locator('summary')
      .filter({ hasText: /^Notes & details$/ })
      .click();
    await page.getByLabel('Your note').fill('Read the source before reviewing');
    await page.getByRole('button', { name: 'Save note' }).click();
    await expect
      .poll(
        async () =>
          SnapshotSchema.parse(await (await owner('state')).json()).tasks.find(
            (task) => task.title === title,
          )?.own_remark,
      )
      .toBe('Read the source before reviewing');
    let releaseCompletion!: () => void;
    const heldCompletion = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    await page.route('**/api/tick', async (route) => {
      await heldCompletion;
      await route.continue();
    });
    await page.getByRole('button', { name: 'Mark Complete', exact: true }).click();
    await expect(
      page.getByRole('button', { name: `Open task: ${title}`, exact: true }),
    ).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Reopen task', exact: true })).toBeDisabled();
    expect(
      SnapshotSchema.parse(await (await owner('state')).json()).tasks.find(
        (task) => task.title === title,
      )?.done,
    ).toBe(false);
    releaseCompletion();
    await expect
      .poll(
        async () =>
          SnapshotSchema.parse(await (await owner('state')).json()).tasks.find(
            (task) => task.title === title,
          )?.done,
      )
      .toBe(true);
    await page.unroute('**/api/tick');
    await page.getByRole('button', { name: /^Completed/ }).click();
    await page.getByRole('button', { name: `Open task: ${title}`, exact: true }).click();
    await page.getByRole('button', { name: 'Reopen task', exact: true }).click();
    await page.getByRole('button', { name: /^My Tasks/ }).click();
    await page.getByRole('button', { name: `Open task: ${title}`, exact: true }).click();
    await page.route(
      '**/api/tick',
      (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Could not save completion' }),
        }),
      { times: 1 },
    );
    await page.getByRole('button', { name: 'Mark Complete', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Mark Complete', exact: true })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('Could not save completion');
    const moreTasks = page.getByRole('button', { name: 'More task actions' });
    await moreTasks.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Find tasks now' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Show all tasks' })).toBeFocused();
    await page.screenshot({
      path: test.info().outputPath('task-menu.png'),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await expect(moreTasks).toBeFocused();
    await expect(page.getByRole('menu')).not.toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Chrome companion', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Add connection', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCSS('transition-duration', '0.2s, 0.2s');
    await page.getByRole('button', { name: 'Close add connection' }).click();
    await expect(page.getByRole('button', { name: 'Add connection', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCSS('transition-duration', '0s');
    await page.keyboard.press('Shift+Tab');
    await expect
      .poll(() =>
        page.getByRole('dialog').evaluate((dialog) => dialog.contains(document.activeElement)),
      )
      .toBe(true);
    await page.screenshot({
      path: test.info().outputPath('connection-dialog.png'),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Add connection', exact: true })).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('button', { name: /^My Tasks/ }).click();
    await expect(
      page.getByRole('button', { name: `Open task: ${title}`, exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('mobile.png') });
    await page.getByRole('button', { name: `Open task: ${title}`, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Mark Complete', exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('mobile-detail.png') });
    const toast = await page.locator('.toast').evaluateAll(
      (elements) => elements[0]?.getBoundingClientRect().toJSON() ?? null,
    );
    const complete = await page
      .getByRole('button', { name: 'Mark Complete', exact: true })
      .boundingBox();
    if (toast && complete) expect(toast.y + toast.height).toBeLessThanOrEqual(complete.y);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await browser.close();
  }
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
    viewport: { width: 390, height: 1058 },
    httpCredentials: { username: 'admin', password },
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
  });
  try {
    // Establish the owner session before Chrome opens a workspace tab from the companion.
    const ownerPage = await context.newPage();
    await ownerPage.goto(base);
    await expect(ownerPage.getByRole('heading', { name: 'My Tasks', exact: true })).toBeVisible();
    await ownerPage.close();
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto('chrome-extension://' + id + '/index.html');
    const code = PairCodeSchema.parse(await (await owner('extensions/pairing', {})).json());
    await page.getByLabel('Server address').fill(base);
    await page.getByLabel('Pairing code').fill(code.code);
    await page.getByRole('button', { name: 'Connect workspace' }).click();
    await expect(page.getByRole('heading', { name: 'My Tasks' })).toBeVisible();
    const title = 'Review the onboarding flow before Friday';
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('companion.png') });
    await page.getByText(title, { exact: true }).click();
    await expect(page.locator('footer')).toContainText('Connected to workspace');
    await page.screenshot({ path: test.info().outputPath('companion-detail.png') });
    await expectReadableTasks(page, '.task-open strong');
    await expectReadableTasks(page, '.task-open span');
    const opened = context.waitForEvent('page');
    await page.getByRole('button', { name: 'View conversation in workspace' }).click();
    const sourcePage = await opened;
    await expect(sourcePage.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(sourcePage.locator('.message-card')).toBeVisible();
    await sourcePage.close();
    await page
      .locator('summary')
      .filter({ hasText: /^Notes & details$/ })
      .click();
    await page.getByLabel('Your note').fill('A note from the companion');
    await page.getByRole('button', { name: 'Save note' }).click();
    await expect
      .poll(async () => {
        const snapshot = SnapshotSchema.parse(await (await owner('state')).json());
        return snapshot.tasks.find((t) => t.title === title)?.own_remark;
      })
      .toBe('A note from the companion');
    let releaseCompletion!: () => void;
    const heldCompletion = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    await page.route('**/api/companion/tick', async (route) => {
      await heldCompletion;
      await route.continue();
    });
    await page.getByRole('button', { name: 'Mark Complete', exact: true }).click();
    await expect(page.getByText(title, { exact: true })).not.toBeVisible();
    await expect(page.getByRole('button', { name: /^Complete:/ }).first()).toBeEnabled();
    expect(
      SnapshotSchema.parse(await (await owner('state')).json()).tasks.find(
        (task) => task.title === title,
      )?.done,
    ).toBe(false);
    releaseCompletion();
    await expect
      .poll(
        async () =>
          SnapshotSchema.parse(await (await owner('state')).json()).tasks.find(
            (task) => task.title === title,
          )?.done,
      )
      .toBe(true);
    await page.unroute('**/api/companion/tick');
    await page.getByRole('button', { name: 'More options' }).click();
    await page.getByRole('menuitem', { name: 'Show completed', exact: true }).click();
    await page.getByText(title, { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Mark as to do', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Collapse task' }).click();
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
    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await page.getByRole('button', { name: 'More options' }).click();
    await page.getByRole('menuitem', { name: 'Refresh tasks' }).click();
    await expect(page.getByRole('button', { name: 'Connect workspace' })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('narrow touch workspace keeps long conversation names and note controls usable', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 320, height: 740 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: 'reduce',
    httpCredentials: { username: 'admin', password },
  });
  try {
    const page = await context.newPage();
    await page.route('**/api/settings', async (route) => {
      const response = await route.fetch();
      const snapshot = PublicSettingsSchema.parse(await response.json());
      snapshot.settings.chats.forEach((chat) => {
        chat.name = 'CustomerSuccessEscalation'.repeat(8);
      });
      await route.fulfill({ response, json: snapshot });
    });
    await page.goto(base);
    await page
      .getByRole('button', { name: /^Open task:/ })
      .first()
      .click();
    await expect(page.getByRole('button', { name: 'Mark Complete', exact: true })).toBeInViewport();
    await page
      .locator('summary')
      .filter({ hasText: /^Notes & details$/ })
      .click();
    const note = page.getByLabel('Your note');
    await note.fill('A note entered from a narrow touch screen');
    expect(
      await note.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
    ).toBeGreaterThanOrEqual(16);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await page
        .locator('.detail-scroll')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({ path: test.info().outputPath('narrow-touch.png') });
  } finally {
    await context.close();
    await browser.close();
  }
});

test('add conversation dialog selects a discovered chat from the chosen session', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1080, height: 900 },
    httpCredentials: { username: 'admin', password },
  });
  try {
    const page = await context.newPage();
    await page.route('**/api/discover', async (route) => {
      const { sessionId } = route.request().postDataJSON() as { sessionId?: string };
      const rows =
        sessionId === 'work'
          ? [{ id: 'work@g.us', name: 'Work group' }]
          : sessionId === 'family'
            ? [{ id: 'family@g.us', name: 'Family group' }]
            : [
                { id: 'work', name: 'Work' },
                { id: 'family', name: 'Family' },
              ];
      await route.fulfill({ json: rows });
    });
    await page.goto(base);
    await page.getByRole('button', { name: /^Conversations/ }).click();
    await page.getByLabel('OpenWA API URL').fill('http://127.0.0.1:9999');
    await page.getByRole('button', { name: 'Add chat' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Choose from list' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await dialog.getByRole('button', { name: 'Find sessions' }).click();
    await dialog.getByLabel('OpenWA session').selectOption('work');
    await dialog.getByRole('button', { name: 'Find chats' }).click();
    await dialog.getByLabel('WhatsApp chat').selectOption('work@g.us');
    await expect(dialog.getByLabel('Conversation name')).toHaveValue('Work group');

    await dialog.getByLabel('OpenWA session').selectOption('family');
    await expect(dialog.getByLabel('WhatsApp chat')).toBeDisabled();
    await expect(
      dialog.getByRole('button', { name: 'Add conversation', exact: true }),
    ).toBeDisabled();
    await dialog.getByRole('button', { name: 'Find chats' }).click();
    await dialog.getByLabel('WhatsApp chat').selectOption('family@g.us');
    await dialog.getByLabel('Conversation name').fill('Family follow-ups');
    await page.setViewportSize({ width: 320, height: 740 });
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await dialog.getByRole('button', { name: 'Add conversation', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect
      .poll(async () => {
        const settings = PublicSettingsSchema.parse(await (await owner('settings')).json());
        return settings.settings.chats.find((chat) => chat.chatId === 'family@g.us');
      })
      .toMatchObject({ sessionId: 'family', name: 'Family follow-ups', enabled: false });

    await page.getByRole('button', { name: 'Add chat' }).click();
    await dialog.getByLabel('WhatsApp chat').selectOption('family@g.us');
    await expect(dialog.getByText('This chat is already added.')).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Add conversation', exact: true }),
    ).toBeDisabled();
    await dialog.getByRole('button', { name: 'Enter IDs manually' }).click();
    await expect(dialog.getByLabel('OpenWA session ID')).toBeVisible();
    await expect(dialog.getByLabel('WhatsApp chat ID')).toBeVisible();
  } finally {
    await context.close();
    await browser.close();
  }
});
