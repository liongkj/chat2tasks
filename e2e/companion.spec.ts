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
import { SnapshotSchema, PublicSettingsSchema, SettingsSchema } from '../src/shared/schema.js';
import { ThreadSnapshotSchema } from '../src/shared/threads.js';

let directory: string, backend: ChildProcess, base: string;
const password = 'isolated-extension-fixture';
async function countSounds(page: Page) {
  await page.addInitScript(() => {
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (when = 0) {
      const root = document.documentElement;
      root.dataset.soundStarts = String(Number(root.dataset.soundStarts ?? '0') + 1);
      return start.call(this, when);
    };
  });
}
async function soundCount(page: Page) {
  return Number((await page.locator('html').getAttribute('data-sound-starts')) ?? '0');
}
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
    await countSounds(page);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base);
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Actions', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Waiting for', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Waiting for', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Final illustration exports', exact: true }),
    ).toBeVisible();
    const beforeWait = SnapshotSchema.parse(await (await owner('state')).json()).waiting_for[0];
    if (!beforeWait?.task_id) throw Error('The sample waiting item needs linked work');
    await page.getByRole('button', { name: 'Mark received', exact: true }).click();
    await expect
      .poll(
        async () =>
          SnapshotSchema.parse(await (await owner('state')).json()).waiting_for.find(
            (wait) => wait.id === beforeWait.id,
          )?.state,
      )
      .toBe('received');
    expect(
      SnapshotSchema.parse(await (await owner('state')).json()).tasks.find(
        (task) => task.id === beforeWait.task_id,
      )?.done,
    ).toBe(false);
    const receivedToast = page.getByRole('status').filter({ hasText: 'Marked as received' });
    await expect(receivedToast).toBeVisible();
    await receivedToast.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect
      .poll(
        async () =>
          SnapshotSchema.parse(await (await owner('state')).json()).waiting_for.find(
            (wait) => wait.id === beforeWait.id,
          )?.state,
      )
      .toBe('waiting');
    await expect(page.getByRole('button', { name: 'Mark received', exact: true })).toBeVisible();
    const linkedTask = SnapshotSchema.parse(await (await owner('state')).json()).tasks.find(
      (task) => task.id === beforeWait.task_id,
    );
    if (!linkedTask) throw Error('The sample waiting item needs linked work');
    await owner('tasks/gtd', {
      id: linkedTask.id,
      gtd: { ...linkedTask.gtd, commitment: 'someday' },
    });
    await page.reload();
    await page
      .getByRole('button', { name: `${linkedTask.reference} · ${linkedTask.title}` })
      .click();
    await expect(page.getByRole('heading', { name: 'Someday / Maybe', exact: true })).toBeVisible();
    const restore = await owner('tasks/gtd', { id: linkedTask.id, gtd: linkedTask.gtd });
    expect(restore.ok).toBe(true);
    await page.reload();
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await expect(
      page.getByRole('button', {
        name: 'Open action: Send Alex the notes from our conversation',
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    const allOpen = SnapshotSchema.parse(await (await owner('state')).json()).tasks.filter(
      (task) => !task.done && task.gtd.commitment === 'active',
    ).length;
    await expect(
      page
        .getByRole('navigation', { name: 'Task filters' })
        .getByRole('button', { name: 'All open work' })
        .locator('.nav-count'),
    ).toHaveText(String(allOpen));
    await page.getByRole('button', { name: 'All items', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Open work', exact: true })).toBeVisible();
    const title = 'Review the onboarding flow before Friday';
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await page.getByLabel('Item category').selectOption('question');
    await expect
      .poll(
        async () =>
          SnapshotSchema.parse(await (await owner('state')).json()).tasks.find(
            (task) => task.title === title,
          )?.kind,
      )
      .toBe('question');
    await page.getByRole('button', { name: 'Questions', exact: true }).click();
    await expect(page.getByRole('button', { name: `Open question: ${title}` })).toBeVisible();
    await page.getByLabel('Item category').selectOption('task');
    await expect
      .poll(
        async () =>
          SnapshotSchema.parse(await (await owner('state')).json()).tasks.find(
            (task) => task.title === title,
          )?.kind,
      )
      .toBe('task');
    await page.getByRole('button', { name: 'All items', exact: true }).click();
    await expect(page.locator('.source-disclosure > summary')).toBeVisible();
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
    await page.locator('.source-disclosure > summary').click();
    await expect(
      page.getByText('Could you take a look at the new onboarding flow?', { exact: false }),
    ).toBeVisible();
    await page.locator('.source-disclosure > summary').click();
    await page
      .locator('summary')
      .filter({ hasText: /^Notes & handoff$/ })
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
    const beforeCompletionSound = await soundCount(page);
    await page.getByRole('button', { name: 'Mark complete', exact: true }).click();
    await expect(
      page.getByRole('button', { name: `Open task: ${title}`, exact: true }),
    ).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
    expect(
      SnapshotSchema.parse(await (await owner('state')).json()).tasks.find(
        (task) => task.title === title,
      )?.done,
    ).toBe(false);
    expect(await soundCount(page)).toBe(beforeCompletionSound);
    releaseCompletion();
    await expect
      .poll(
        async () =>
          SnapshotSchema.parse(await (await owner('state')).json()).tasks.find(
            (task) => task.title === title,
          )?.done,
      )
      .toBe(true);
    await expect.poll(() => soundCount(page)).toBe(beforeCompletionSound + 1);
    await page.unroute('**/api/tick');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect
      .poll(
        async () =>
          SnapshotSchema.parse(await (await owner('state')).json()).tasks.find(
            (task) => task.title === title,
          )?.done,
      )
      .toBe(false);
    expect(await soundCount(page)).toBe(beforeCompletionSound + 1);
    await expect(
      page.getByRole('button', { name: `Open task: ${title}`, exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Mark complete', exact: true }).click();
    await expect
      .poll(
        async () =>
          SnapshotSchema.parse(await (await owner('state')).json()).tasks.find(
            (task) => task.title === title,
          )?.done,
      )
      .toBe(true);
    await expect.poll(() => soundCount(page)).toBe(beforeCompletionSound + 2);
    await page.getByRole('button', { name: 'Completed', exact: true }).click();
    await page.getByRole('button', { name: `Open task: ${title}`, exact: true }).click();
    await page.getByRole('button', { name: 'Reopen task', exact: true }).click();
    await page.getByRole('button', { name: 'All open work', exact: true }).click();
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
    await page.getByRole('button', { name: 'Mark complete', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Mark complete', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('Could not save completion');
    await expect(page.locator('.toast.error')).toBeVisible();
    expect(await soundCount(page)).toBe(beforeCompletionSound + 2);
    const moreTasks = page.getByRole('button', { name: 'More task actions' });
    await moreTasks.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Find tasks now' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Show all items' })).toBeFocused();
    await page.screenshot({
      path: test.info().outputPath('task-menu.png'),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await expect(moreTasks).toBeFocused();
    await expect(page.getByRole('menu')).not.toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Attention', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: 'Task completion sound' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Clarification sound' })).toBeChecked();
    await expect(page.getByRole('slider', { name: 'Sound volume' })).toHaveValue('30');
    await page.getByRole('checkbox', { name: 'Task completion sound' }).uncheck();
    let releaseSoundSave!: () => void;
    const heldSoundSave = new Promise<void>((resolve) => {
      releaseSoundSave = resolve;
    });
    await page.route(
      '**/api/sound-preferences',
      async (route) => {
        await heldSoundSave;
        await route.continue();
      },
      { times: 1 },
    );
    await page.getByRole('button', { name: 'Save sound settings' }).click();
    await expect(page.getByRole('checkbox', { name: 'Task completion sound' })).toBeDisabled();
    await expect(page.getByRole('checkbox', { name: 'Clarification sound' })).toBeDisabled();
    await expect(page.getByRole('slider', { name: 'Sound volume' })).toBeDisabled();
    releaseSoundSave();
    await expect(page.getByText('Sound settings saved.', { exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: 'Clarification sound' }).uncheck();
    await expect(page.getByText('Sound settings saved.', { exact: true })).not.toBeVisible();
    await page.getByRole('checkbox', { name: 'Clarification sound' }).check();
    await expect
      .poll(async () => SnapshotSchema.parse(await (await owner('state')).json()).sound.completion)
      .toBe(false);
    await page.reload();
    await expect(page.getByRole('checkbox', { name: 'Task completion sound' })).not.toBeChecked();
    await page.getByRole('checkbox', { name: 'Task completion sound' }).check();
    await page.getByRole('button', { name: 'Save sound settings' }).click();
    await expect
      .poll(async () => SnapshotSchema.parse(await (await owner('state')).json()).sound.completion)
      .toBe(true);
    const beforePreview = await soundCount(page);
    await page.getByRole('button', { name: 'Preview completion' }).click();
    await expect.poll(() => soundCount(page)).toBe(beforePreview + 1);
    await page.getByRole('button', { name: 'Browser', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Chrome companion', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'AI models', exact: true }).click();
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
    await page.getByRole('button', { name: 'All open work', exact: true }).click();
    await expect(
      page.getByRole('button', { name: `Open task: ${title}`, exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('mobile.png') });
    await page.getByRole('button', { name: `Open task: ${title}`, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Mark complete', exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('mobile-detail.png') });
    const toast = await page
      .locator('.toast')
      .evaluateAll((elements) => elements[0]?.getBoundingClientRect().toJSON() ?? null);
    const complete = await page
      .getByRole('button', { name: 'Mark complete', exact: true })
      .boundingBox();
    if (toast && complete) expect(toast.y + toast.height).toBeLessThanOrEqual(complete.y);
    await page.getByRole('button', { name: 'Mark complete', exact: true }).click();
    const taskDialog = page.getByRole('dialog', { name: 'Task details' });
    await expect(taskDialog.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
    await taskDialog.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect
      .poll(
        async () =>
          SnapshotSchema.parse(await (await owner('state')).json()).tasks.find(
            (task) => task.title === title,
          )?.done,
      )
      .toBe(false);
    await taskDialog.getByRole('button', { name: 'Close task details', exact: true }).click();
    await expect(
      page.getByRole('button', { name: `Open task: ${title}`, exact: true }),
    ).toBeFocused();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await browser.close();
  }
});

test('a new clarification sounds once and existing questions stay quiet after reload', async () => {
  const snapshot = SnapshotSchema.parse(await (await owner('state')).json());
  const message = snapshot.messages[0];
  if (!message) throw Error('The sample workspace needs a message');
  const question = {
    message_id: message.id,
    action: 'ask' as const,
    task_ids: [],
    evidence_quote: message.body,
    reason: 'Needs clarification',
  };
  let addQuestion = false;
  let reads = 0;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ httpCredentials: { username: 'admin', password } });
  try {
    const page = await context.newPage();
    await countSounds(page);
    await page.route('**/api/state', async (route) => {
      const response = await route.fetch();
      const current = SnapshotSchema.parse(await response.json());
      current.questions = [
        { ...question, id: 'existing-question', question: 'Existing question?' },
        ...(addQuestion ? [{ ...question, id: 'new-question', question: 'New question?' }] : []),
      ];
      reads++;
      await route.fulfill({ response, json: current });
    });
    await page.goto(base + '?view=tasks');
    await expect(page.getByText('Existing question?', { exact: true })).toBeVisible();
    await page
      .getByRole('button', { name: /^Open task:/ })
      .first()
      .click();
    expect(await soundCount(page)).toBe(0);
    addQuestion = true;
    await expect(page.getByText('New question?', { exact: true })).toBeVisible({ timeout: 8000 });
    await expect.poll(() => soundCount(page)).toBe(2);
    const readsAfterArrival = reads;
    await expect.poll(() => reads, { timeout: 8000 }).toBeGreaterThan(readsAfterArrival);
    expect(await soundCount(page)).toBe(2);
    await page.reload();
    await expect(page.getByText('New question?', { exact: true })).toBeVisible();
    await page
      .getByRole('button', { name: /^Open task:/ })
      .first()
      .click();
    expect(await soundCount(page)).toBe(0);
  } finally {
    await context.close();
    await browser.close();
  }
});

test('a clarification is only resolved after the owner confirms the chosen task', async () => {
  const snapshot = SnapshotSchema.parse(await (await owner('state')).json());
  const task = snapshot.tasks.find((item) => item.source_ids.length > 0);
  const message = snapshot.messages.find((item) => item.id === task?.source_ids[0]);
  if (!task || !message) throw Error('The sample workspace needs a task with a source message');
  const resolved: unknown[] = [];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ httpCredentials: { username: 'admin', password } });
  try {
    const page = await context.newPage();
    await page.route('**/api/state', async (route) => {
      const response = await route.fetch();
      const current = SnapshotSchema.parse(await response.json());
      current.questions = [
        {
          id: 'pending-question',
          message_id: message.id,
          action: 'ask',
          task_ids: [],
          evidence_quote: message.body,
          reason: 'Needs clarification',
          question: 'Which task did this finish?',
        },
      ];
      await route.fulfill({ response, json: current });
    });
    await page.route('**/api/resolve', async (route) => {
      resolved.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true } });
    });
    await page.goto(base + '?view=tasks');
    const card = page.locator('.question-card');
    await expect(card.getByText('Which task did this finish?')).toBeVisible();
    const resolve = card.getByRole('button', { name: 'Resolve' });
    await expect(resolve).toBeDisabled();
    await card.getByLabel('Choose the completed task').selectOption(task.id);
    expect(resolved).toEqual([]);
    await expect(resolve).toBeEnabled();
    await resolve.click();
    await expect(page.getByRole('status')).toContainText('Task marked as done');
    expect(resolved).toEqual([{ id: 'pending-question', task_id: task.id }]);
  } finally {
    await context.close();
    await browser.close();
  }
});

test('a workspace transfer needs the passphrase typed twice', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ httpCredentials: { username: 'admin', password } });
  try {
    const page = await context.newPage();
    await page.goto(base + '?view=settings&section=workspace');
    const download = page.getByRole('button', { name: 'Download transfer', exact: true });
    await expect(download).toBeDisabled();
    await page.getByLabel('Create a passphrase').fill('correct horse battery');
    await expect(download).toBeDisabled();
    await page.getByLabel('Repeat the passphrase').fill('correct horse');
    await expect(page.getByRole('alert')).toContainText('The passphrases do not match.');
    await expect(download).toBeDisabled();
    await page.getByLabel('Repeat the passphrase').fill('correct horse battery');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(download).toBeEnabled();
  } finally {
    await context.close();
    await browser.close();
  }
});

test('leaving settings with unsaved changes asks first', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ httpCredentials: { username: 'admin', password } });
  try {
    const page = await context.newPage();
    await page.goto(base + '?view=connections');
    const url = page.getByLabel('OpenWA API URL');
    await expect(url).toBeVisible();
    await url.fill('http://changed.example:2785');
    const prompts: string[] = [];
    page.once('dialog', (dialog) => {
      prompts.push(dialog.message());
      void dialog.dismiss();
    });
    await page.getByRole('button', { name: 'Waiting for', exact: true }).click();
    await expect.poll(() => prompts.length).toBe(1);
    expect(prompts[0]).toContain('unsaved settings');
    await expect(url).toHaveValue('http://changed.example:2785');
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Waiting for', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Waiting for', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
    await page.getByRole('button', { name: 'Waiting for', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Waiting for', exact: true })).toBeVisible();
  } finally {
    await context.close();
    await browser.close();
  }
});

test('the last-item celebration waits for a confirmed completion', async () => {
  const snapshot = SnapshotSchema.parse(await (await owner('state')).json());
  const task = snapshot.tasks.find(
    (item) => !item.done && item.kind === 'task' && !item.gtd.recurrence,
  );
  if (!task) throw Error('The sample workspace needs an open task');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ httpCredentials: { username: 'admin', password } });
  try {
    const page = await context.newPage();
    await page.route('**/api/state', async (route) => {
      const response = await route.fetch();
      const current = SnapshotSchema.parse(await response.json());
      current.tasks = current.tasks.filter((item) => item.id === task.id);
      await route.fulfill({ response, json: current });
    });
    await page.goto(base + '?view=tasks');
    await expect(page.getByRole('button', { name: 'Mark complete', exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Search items' }).fill('no matching task');
    await expect(page.locator('.completion-celebration')).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Search items' }).clear();
    await page.getByRole('button', { name: `Open task: ${task.title}` }).click();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/tick', async (route) => {
      await held;
      await route.continue();
    });
    await page.getByRole('button', { name: 'Mark complete', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'No open items here' })).toBeVisible();
    await expect(page.locator('.completion-celebration')).toHaveCount(0);
    const celebrated = expect(page.locator('.completion-celebration')).toBeVisible();
    release();
    await celebrated;
    await page.unroute('**/api/tick');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect
      .poll(
        async () =>
          SnapshotSchema.parse(await (await owner('state')).json()).tasks.find(
            (item) => item.id === task.id,
          )?.done,
      )
      .toBe(false);
  } finally {
    await context.close();
    await browser.close();
  }
});

test('TODO links restore the selected task and source view through refresh and browser history', async () => {
  const snapshot = SnapshotSchema.parse(await (await owner('state')).json());
  const settings = PublicSettingsSchema.parse(await (await owner('settings')).json());
  const [first, second] = snapshot.tasks.filter((task) => !task.done);
  const completed = snapshot.tasks.find((task) => task.done);
  if (!first || !second || !completed)
    throw Error('The sample needs two open tasks and one completed task');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1080, height: 1058 },
    httpCredentials: { username: 'admin', password },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  try {
    const page = await context.newPage();
    await page.goto(base + '?view=tasks&from=shared-link');
    await page.getByRole('button', { name: `Open task: ${first.title}`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp('task=' + first.reference));
    await page.getByRole('button', { name: `Open task: ${second.title}`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp('task=' + second.reference));
    await page.reload();
    await expect(page.getByRole('heading', { name: second.title, exact: true })).toBeVisible();
    await expect(page.locator('.task-row.selected .task-reference')).toHaveText(second.reference);
    await expect(page.locator('.task-reference-bar .task-reference')).toHaveText(second.reference);
    expect(new URL(page.url()).searchParams.get('from')).toBe('shared-link');
    await page
      .locator('summary')
      .filter({ hasText: /^Notes & handoff$/ })
      .click();
    await page.getByRole('button', { name: 'Copy task link', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(page.url());

    await page.locator('.source-disclosure > summary').click();
    await expect(page).toHaveURL(/context=conversation/);
    await page.reload();
    await expect(page.locator('.message-card').first()).toBeVisible();
    await page.goBack();
    await expect(page.locator('.source-disclosure > summary')).toBeVisible();
    expect(new URL(page.url()).searchParams.has('context')).toBe(false);
    await page.goBack();
    await expect(page.getByRole('heading', { name: first.title, exact: true })).toBeVisible();
    await page.goForward();
    await expect(page.getByRole('heading', { name: second.title, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Needs information', exact: true }).click();
    await expect(page).toHaveURL(/state=needs_info/);
    await expect(page.locator('.task-row')).toHaveCount(
      snapshot.tasks.filter((task) => !task.done && task.triage_state === 'needs_info').length,
    );
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Needs information', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page.goBack();
    await expect(page.getByRole('heading', { name: second.title, exact: true })).toBeVisible();

    const source = snapshot.messages.find((message) => second.source_ids.includes(message.id));
    const conversation = settings.settings.chats.find(
      (chat) => chat.sessionId === source?.sessionId && chat.chatId === source.chatId,
    );
    if (!conversation) throw Error('The sample task needs a saved conversation');
    const sourceIds = new Set(
      snapshot.messages
        .filter(
          (message) =>
            message.sessionId === conversation.sessionId && message.chatId === conversation.chatId,
        )
        .map((message) => message.id),
    );
    const scoped = snapshot.tasks.filter(
      (task) => !task.done && task.source_ids.some((id) => sourceIds.has(id)),
    );
    await page
      .getByRole('button', { name: `Filter tasks from ${conversation.name}`, exact: true })
      .click();
    await expect(page.locator('.task-row')).toHaveCount(scoped.length);
    await expect(page).toHaveURL(new RegExp('chat=' + conversation.id));
    expect(scoped.map((task) => task.reference)).toContain(
      await page.locator('.task-document-heading .task-reference').innerText(),
    );
    await page.reload();
    await expect(
      page.getByRole('button', { name: `Filter tasks from ${conversation.name}`, exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'All conversations', exact: true }).click();

    await page.goto(base + '?task=' + completed.reference);
    await expect(page.getByRole('heading', { name: completed.title, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Completed', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('.task-row.selected .task-reference')).toHaveText(
      completed.reference,
    );
    await page.goto(base + '?task=' + second.id + '&context=conversation');
    await expect(page).toHaveURL(new RegExp('task=' + second.reference));
    await expect(page.locator('.message-card').first()).toBeVisible();
    await page.getByLabel('Search items', { exact: true }).fill(second.reference.toLowerCase());
    await expect(page.locator('.task-row')).toHaveCount(1);

    await page.goto(base + '?task=TODO-999999');
    await expect(page.getByRole('heading', { name: 'Task not found', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: first.title, exact: true })).not.toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base + '?task=' + second.reference);
    await page.reload();
    await expect(page.getByRole('heading', { name: second.title, exact: true })).toBeVisible();
    await page
      .locator('summary')
      .filter({ hasText: /^Notes & handoff$/ })
      .click();
    await expect(page.getByRole('button', { name: 'Copy task link', exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: test.info().outputPath('todo-link-mobile.png') });
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
    await ownerPage.goto(base + '?view=tasks');
    await expect(ownerPage.getByRole('heading', { name: 'Open work', exact: true })).toBeVisible();
    await ownerPage.close();
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    await countSounds(page);
    await page.goto('chrome-extension://' + id + '/index.html');
    const code = PairCodeSchema.parse(await (await owner('extensions/pairing', {})).json());
    await page.getByLabel('Server address').fill(base);
    await page.getByLabel('Pairing code').fill(code.code);
    await page.getByRole('button', { name: 'Connect workspace' }).click();
    await expect(page.getByRole('heading', { name: 'My items' })).toBeVisible();
    await expect(page.locator('.notice.paired')).toContainText('Connected to your workspace.');
    await page.getByRole('button', { name: 'More options' }).click();
    await page.getByRole('menuitem', { name: 'Sound settings' }).click();
    let soundDialog = page.getByRole('dialog', { name: 'Sound settings' });
    await expect(
      soundDialog.getByRole('checkbox', { name: 'Task completion sound' }),
    ).toBeChecked();
    await expect(soundDialog).toHaveCSS('opacity', '1');
    await page.screenshot({
      path: test.info().outputPath('sound-settings.png'),
      animations: 'disabled',
    });
    await soundDialog.getByRole('checkbox', { name: 'Task completion sound' }).uncheck();
    await soundDialog.getByRole('button', { name: 'Save sound settings' }).click();
    await expect
      .poll(async () => SnapshotSchema.parse(await (await owner('state')).json()).sound)
      .toEqual({ completion: false, attention: true, volume: 0.3 });
    await soundDialog.getByRole('button', { name: 'Close', exact: true }).click();
    const mutedTask = SnapshotSchema.parse(await (await owner('state')).json()).tasks.find(
      (task) => task.title === 'Review the onboarding flow before Friday',
    );
    if (!mutedTask) throw Error('The sample task is missing');
    const beforeMutedCompletion = await soundCount(page);
    await page.getByRole('button', { name: `Mark Complete: ${mutedTask.title}` }).click();
    await expect
      .poll(
        async () =>
          SnapshotSchema.parse(await (await owner('state')).json()).tasks.find(
            (task) => task.id === mutedTask.id,
          )?.done,
      )
      .toBe(true);
    expect(await soundCount(page)).toBe(beforeMutedCompletion);
    await owner('tick', { id: mutedTask.id, done: false });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'My items' })).toBeVisible();
    await expect(page.locator('.notice.paired')).not.toBeVisible();
    await page.getByRole('button', { name: 'More options' }).click();
    await page.getByRole('menuitem', { name: 'Sound settings' }).click();
    soundDialog = page.getByRole('dialog', { name: 'Sound settings' });
    await expect(
      soundDialog.getByRole('checkbox', { name: 'Task completion sound' }),
    ).not.toBeChecked();
    await expect(soundDialog.getByRole('slider', { name: 'Sound volume' })).toHaveValue('30');
    await soundDialog.getByRole('slider', { name: 'Sound volume' }).press('Home');
    await soundDialog.getByRole('button', { name: 'Save sound settings' }).click();
    await expect
      .poll(async () => SnapshotSchema.parse(await (await owner('state')).json()).sound)
      .toEqual({ completion: false, attention: true, volume: 0 });
    await soundDialog.getByRole('checkbox', { name: 'Task completion sound' }).check();
    await soundDialog.getByRole('slider', { name: 'Sound volume' }).press('End');
    await soundDialog.getByRole('button', { name: 'Save sound settings' }).click();
    await expect
      .poll(async () => SnapshotSchema.parse(await (await owner('state')).json()).sound)
      .toEqual({ completion: true, attention: true, volume: 1 });
    await soundDialog.getByRole('button', { name: 'Close', exact: true }).click();
    const waiting = SnapshotSchema.parse(await (await owner('state')).json()).waiting_for[0];
    if (!waiting?.task_id) throw Error('The sample waiting item needs linked work');
    await page.getByRole('button', { name: 'Waiting for', exact: true }).click();
    await page.getByText('Final illustration exports', { exact: true }).click();
    await page.getByRole('button', { name: 'Mark received', exact: true }).click();
    await expect
      .poll(
        async () =>
          SnapshotSchema.parse(await (await owner('state')).json()).waiting_for.find(
            (item) => item.id === waiting.id,
          )?.state,
      )
      .toBe('received');
    expect(
      SnapshotSchema.parse(await (await owner('state')).json()).tasks.find(
        (item) => item.id === waiting.task_id,
      )?.done,
    ).toBe(false);
    await owner('waiting/state', { id: waiting.id, state: 'waiting' });
    await page.getByRole('button', { name: 'All', exact: true }).click();
    const title = 'Review the onboarding flow before Friday';
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('companion.png') });
    await page.getByText(title, { exact: true }).click();
    await page.getByLabel('Item category').selectOption('reminder');
    await expect
      .poll(
        async () =>
          SnapshotSchema.parse(await (await owner('state')).json()).tasks.find(
            (task) => task.title === title,
          )?.kind,
      )
      .toBe('reminder');
    await page.getByRole('button', { name: 'Reminders', exact: true }).click();
    await page.getByText(title, { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Dismiss reminder', exact: true })).toBeVisible();
    await page.getByLabel('Item category').selectOption('task');
    await expect
      .poll(
        async () =>
          SnapshotSchema.parse(await (await owner('state')).json()).tasks.find(
            (task) => task.title === title,
          )?.kind,
      )
      .toBe('task');
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
    const beforeCompletionSound = await soundCount(page);
    await page.getByRole('button', { name: 'Mark Complete', exact: true }).click();
    await expect(page.getByText(title, { exact: true })).not.toBeVisible();
    await expect(page.getByRole('button', { name: /^Mark Complete:/ }).first()).toBeEnabled();
    expect(
      SnapshotSchema.parse(await (await owner('state')).json()).tasks.find(
        (task) => task.title === title,
      )?.done,
    ).toBe(false);
    expect(await soundCount(page)).toBe(beforeCompletionSound);
    releaseCompletion();
    await expect
      .poll(
        async () =>
          SnapshotSchema.parse(await (await owner('state')).json()).tasks.find(
            (task) => task.title === title,
          )?.done,
      )
      .toBe(true);
    await expect.poll(() => soundCount(page)).toBe(beforeCompletionSound + 1);
    await page.unroute('**/api/companion/tick');
    await page.getByRole('button', { name: 'More options' }).click();
    await page.getByRole('menuitem', { name: 'Show completed', exact: true }).click();
    await page.getByText(title, { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Mark as to do', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Collapse task' }).click();
    await owner('sound-preferences', { completion: true, attention: true, volume: 0.3 });
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
    await page.getByRole('button', { name: 'Items', exact: true }).click();
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
    await page.goto(base + '?view=tasks');
    await page
      .getByRole('button', { name: /^Open task:/ })
      .first()
      .click();
    await expect(page.getByRole('button', { name: 'Mark complete', exact: true })).toBeInViewport();
    await page
      .locator('summary')
      .filter({ hasText: /^Notes & handoff$/ })
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
    await page.goto(base + '?view=tasks');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'WhatsApp & chats', exact: true }).click();
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

test('manual merge moves evidence into an existing TODO and preserves notes, completion and old links', async () => {
  const before = SnapshotSchema.parse(await (await owner('state')).json());
  const [source, target] = before.tasks.filter((task) => !task.done);
  if (!source || !target) throw Error('The sample needs two open TODOs');
  const sourceNote = 'Keep this source note in merge history';
  const targetNote = 'Keep the destination note unchanged';
  await owner('remark', { id: target.id, remark: targetNote });
  await owner('tick', { id: target.id, done: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1080, height: 1058 },
    httpCredentials: { username: 'admin', password },
  });
  try {
    const page = await context.newPage();
    await page.goto(base + '?task=' + source.reference);
    await page
      .locator('summary')
      .filter({ hasText: /^Notes & handoff$/ })
      .click();
    await page.getByLabel('Your note', { exact: true }).fill(sourceNote);
    await page.getByRole('button', { name: 'Merge tasks…', exact: true }).click();
    await page.getByLabel('Destination TODO', { exact: true }).selectOption(target.id);
    const merge = page.getByRole('button', { name: 'Merge into ' + target.reference, exact: true });
    await expect(merge).toBeDisabled();
    await page.getByRole('button', { name: 'Save note', exact: true }).click();
    await expect(merge).toBeEnabled();
    await merge.click();
    await expect(page).toHaveURL(new RegExp('task=' + target.reference));
    await expect(page.getByRole('heading', { name: target.title, exact: true })).toBeVisible();
    await expect(page.locator('.task-document-heading .task-conversation')).toHaveText(
      '2 conversations',
    );
    await expect(page.getByRole('button', { name: 'Reopen task', exact: true })).toBeVisible();
    await page
      .locator('summary')
      .filter({ hasText: /^Notes & handoff$/ })
      .click();
    await expect(page.getByLabel('Your note', { exact: true })).toHaveValue(targetNote);
    await expect(page.locator('.merge-history')).toContainText(source.reference);
    await expect(page.locator('.merge-history')).toContainText(sourceNote);
    await page.locator('.source-disclosure > summary').click();
    await expect(page.locator('.message-card')).toHaveCount(
      new Set([...source.source_ids, ...target.source_ids]).size,
    );
    await page.goto(base + '?task=' + source.reference);
    await expect(page).toHaveURL(new RegExp('task=' + target.reference));
    await page.reload();
    await expect(page.getByRole('heading', { name: target.title, exact: true })).toBeVisible();
    await page.goto(base + '?task=' + source.id + '&context=conversation');
    await expect(page).toHaveURL(new RegExp('task=' + target.reference));
    await expect(page.locator('.message-card').first()).toBeVisible();
    await page.getByLabel('Search items', { exact: true }).fill(source.reference);
    await expect(page.locator('.task-row')).toHaveCount(1);
    await expect(page.locator('.task-row .task-reference')).toHaveText(target.reference);
    const after = SnapshotSchema.parse(await (await owner('state')).json());
    expect(after.tasks.some((task) => task.id === source.id)).toBe(false);
    const merged = after.tasks.find((task) => task.id === target.id);
    expect(merged?.done).toBe(true);
    expect(merged?.own_remark).toBe(targetNote);
    expect(merged?.merged_from.find((task) => task.id === source.id)?.own_remark).toBe(sourceNote);
    const settings = PublicSettingsSchema.parse(await (await owner('settings')).json());
    const sourceMessage = before.messages.find((message) => source.source_ids.includes(message.id));
    const sourceChat = settings.settings.chats.find(
      (chat) => chat.sessionId === sourceMessage?.sessionId && chat.chatId === sourceMessage.chatId,
    );
    if (!sourceChat) throw Error('The merged sample needs its original conversation');
    await page.goto(
      base + '?view=conversations&chat=' + sourceChat.id + '&task=' + target.reference,
    );
    await page.getByRole('button', { name: /^View conversation/ }).click();
    await expect(page).toHaveURL(/view=tasks/);
    await expect(page.locator('.message-card')).toHaveCount(
      new Set([...source.source_ids, ...target.source_ids]).size,
    );
    await page.screenshot({ path: test.info().outputPath('merged-todo.png') });
  } finally {
    await context.close();
    await browser.close();
  }
});

test('overview items stay in place while background activity changes', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1200, height: 900 },
    httpCredentials: { username: 'admin', password },
  });
  try {
    const page = await context.newPage();
    let working = false;
    await page.route('**/api/state', async (route) => {
      const response = await route.fetch();
      const current = SnapshotSchema.parse(await response.json());
      await route.fulfill({
        response,
        json: {
          ...current,
          status: {
            ...current.status,
            syncing: working,
            debouncing: false,
            phase: 'Checking sample messages',
          },
        },
      });
    });
    await page.goto(base);
    const grid = page.locator('.overview-grid');
    await expect(grid).toBeVisible();
    const before = await grid.boundingBox();
    if (!before) throw Error('The sample overview grid is missing');
    working = true;
    await expect(page.getByText('Checking sample messages')).toBeVisible({ timeout: 10000 });
    const during = await grid.boundingBox();
    if (!during) throw Error('The sample overview grid is missing');
    expect(during.y).toBeCloseTo(before.y, 0);
    working = false;
    await expect(page.getByText('Checking sample messages')).not.toBeVisible({ timeout: 10000 });
    const after = await grid.boundingBox();
    if (!after) throw Error('The sample overview grid is missing');
    expect(after.y).toBeCloseTo(before.y, 0);
  } finally {
    await context.close();
    await browser.close();
  }
});

test('a conversation switch shows its pending state until the server confirms', async () => {
  const settings = PublicSettingsSchema.parse(await (await owner('settings')).json());
  const chat = settings.settings.chats.find((item) => item.enabled);
  if (!chat) throw Error('The sample needs a followed conversation');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    reducedMotion: 'reduce',
    httpCredentials: { username: 'admin', password },
  });
  let release = () => {};
  try {
    const page = await context.newPage();
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/settings', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await pending;
      await route.fulfill({ status: 503, json: { error: 'Fictional save failed' } });
    });
    await page.goto(base);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'WhatsApp & chats', exact: true }).click();
    const toggle = page.getByRole('switch', { name: `Activate ${chat.name}` });
    const row = toggle.locator('..');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(row).toContainText('Pausing…');
    release();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Fictional save failed' }),
    ).toBeVisible();
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
  } finally {
    release();
    await context.close();
    await browser.close();
  }
});

test('reading position stays put when a different conversation receives a message', async () => {
  const snapshot = SnapshotSchema.parse(await (await owner('state')).json());
  const settings = PublicSettingsSchema.parse(await (await owner('settings')).json());
  const chat = settings.settings.chats.find((item) =>
    snapshot.tasks.some((task) =>
      snapshot.messages.some(
        (message) =>
          task.source_ids.includes(message.id) &&
          message.sessionId === item.sessionId &&
          message.chatId === item.chatId,
      ),
    ),
  );
  const other = settings.settings.chats.find((item) => item.id !== chat?.id);
  const task = snapshot.tasks.find((item) =>
    snapshot.messages.some(
      (message) =>
        item.source_ids.includes(message.id) &&
        message.sessionId === chat?.sessionId &&
        message.chatId === chat?.chatId,
    ),
  );
  const source = snapshot.messages.find((message) => task?.source_ids.includes(message.id));
  if (!chat || !other || !task || !source)
    throw Error('The sample needs two conversations and linked work');
  const timestamp = Math.floor(Date.now() / 1000);
  const longConversation = Array.from({ length: 24 }, (_, index) => ({
    ...source,
    id: `scroll-sample-${index}`,
    waMessageId: `scroll-sample-${index}`,
    sessionId: chat.sessionId,
    chatId: chat.chatId,
    body: 'A fictional message for testing reading position. '.repeat(7),
    type: index === 22 ? 'image' : 'text',
    timestamp: timestamp + index,
  }));
  const unrelated = {
    ...source,
    id: 'scroll-unrelated-message',
    waMessageId: 'scroll-unrelated-message',
    sessionId: other.sessionId,
    chatId: other.chatId,
    body: 'Unrelated incoming message',
    type: 'text',
    timestamp: timestamp + 100,
  };
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 650 },
    httpCredentials: { username: 'admin', password },
  });
  let releaseImage = () => {};
  try {
    const page = await context.newPage();
    const imagePending = new Promise<void>((resolve) => {
      releaseImage = resolve;
    });
    await page.route('**/api/media?*', async (route) => {
      if (!route.request().url().includes('scroll-sample-22')) return route.continue();
      await imagePending;
      await route.fulfill({
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
          'base64',
        ),
      });
    });
    let includeUnrelated = false;
    await page.route('**/api/state', async (route) => {
      const response = await route.fetch();
      const current = SnapshotSchema.parse(await response.json());
      await route.fulfill({
        response,
        json: {
          ...current,
          messages: [
            ...current.messages,
            ...longConversation,
            ...(includeUnrelated ? [unrelated] : []),
          ],
        },
      });
    });
    await page.goto(base + '?view=conversations&chat=' + chat.id + '&task=' + task.reference);
    const thread = page.locator('.thread-scroll');
    await expect(thread.locator('.message-card')).toHaveCount(
      snapshot.messages.filter(
        (message) => message.sessionId === chat.sessionId && message.chatId === chat.chatId,
      ).length + longConversation.length,
    );
    await thread.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const readingPosition = await thread.evaluate((element) => element.scrollTop);
    expect(readingPosition).toBeGreaterThan(300);
    includeUnrelated = true;
    await expect(
      page.getByRole('button', { name: `Open conversation: ${other.name}` }),
    ).toContainText('Unrelated incoming message', { timeout: 10000 });
    expect(await thread.evaluate((element) => element.scrollTop)).toBeCloseTo(readingPosition, 0);

    const image = thread.locator('[data-message-id="scroll-sample-22"]');
    const nextMessage = thread.locator('[data-message-id="scroll-sample-23"]');
    await image.scrollIntoViewIfNeeded();
    await expect(image.getByText('Loading image…')).toBeVisible();
    const beforeImage = await nextMessage.boundingBox();
    if (!beforeImage) throw Error('The message after the sample image is missing');
    releaseImage();
    await expect(image.getByText('Loading image…')).not.toBeVisible();
    const afterImage = await nextMessage.boundingBox();
    if (!afterImage) throw Error('The message after the sample image is missing');
    expect(afterImage.y).toBeCloseTo(beforeImage.y, 0);
  } finally {
    releaseImage();
    await context.close();
    await browser.close();
  }
});

test('conversation evidence stays scoped and mobile task navigation returns keyboard focus', async () => {
  const snapshot = SnapshotSchema.parse(await (await owner('state')).json());
  const settings = PublicSettingsSchema.parse(await (await owner('settings')).json());
  const chat = settings.settings.chats.find((item) => item.id === 'product');
  const task = snapshot.tasks.find((item) => item.triage_state === 'needs_info');
  if (!chat || !task) throw Error('The sample needs the product conversation and its blocked task');
  const chatMessages = snapshot.messages.filter(
    (message) => message.sessionId === chat.sessionId && message.chatId === chat.chatId,
  );
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1024 },
    httpCredentials: { username: 'admin', password },
  });
  try {
    const page = await context.newPage();
    let releaseSettings!: () => void;
    const heldSettings = new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });
    await page.route('**/api/settings', async (route) => {
      const response = await route.fetch();
      await heldSettings;
      await route.fulfill({ response });
    });
    await page.goto(base + '?view=conversations&chat=' + chat.id + '&task=' + task.reference);
    await expect(page.locator('.inspector h2')).toHaveText(task.title);
    releaseSettings();
    const thread = page.getByRole('region', { name: 'Saved messages: ' + chat.name });
    await expect(thread.locator('.message-card')).toHaveCount(chatMessages.length);
    await expect(page).toHaveURL(new RegExp('chat=' + chat.id));
    await page.unroute('**/api/settings');
    await page
      .getByRole('button', { name: 'Select linked task: ' + task.title, exact: true })
      .click();
    await expect(page.locator('.inspector h2')).toHaveText(task.title);
    await expect(thread.locator('.linked-evidence')).toHaveCount(
      chatMessages.filter((message) => task.source_ids.includes(message.id)).length,
    );
    await page.reload();
    await expect(page.locator('.inspector h2')).toHaveText(task.title);
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    await expect(page).toHaveURL(/view=activity/);
    await page.goBack();
    await expect(page.locator('.inspector h2')).toHaveText(task.title);
    await page.setViewportSize({ width: 390, height: 844 });
    const openTask = page.getByRole('button', { name: 'View task: ' + task.title, exact: true });
    await openTask.click();
    const dialog = page.getByRole('dialog', { name: 'Task details' });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await dialog.getByRole('button', { name: 'Add missing information', exact: true }).click();
    await expect(dialog.getByLabel('Your note', { exact: true })).toBeFocused();
    await dialog.getByRole('button', { name: 'Close task details', exact: true }).click();
    await expect(openTask).toBeFocused();
    await page.getByRole('button', { name: 'Back to conversations', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Open conversation: ' + chat.name, exact: true }),
    ).toBeFocused();
    const navigation = page.getByRole('button', { name: 'Open navigation', exact: true });
    await navigation.click();
    const drawer = page.getByRole('dialog', { name: 'Workspace navigation' });
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByRole('button', { name: 'Close navigation', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Tab');
    await expect
      .poll(() => drawer.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true);
    await page.keyboard.press('Escape');
    await expect(navigation).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    const focusedBounds = await page.evaluate(() =>
      document.activeElement?.getBoundingClientRect().toJSON(),
    );
    expect(focusedBounds?.x ?? 0).toBeGreaterThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: test.info().outputPath('conversation-mobile.png') });
  } finally {
    await context.close();
    await browser.close();
  }
});

test('conversation settings can recover from a failed initial load without losing the workspace', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1080, height: 900 },
    httpCredentials: { username: 'admin', password },
  });
  try {
    const page = await context.newPage();
    await page.route(
      '**/api/settings',
      (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Settings temporarily unavailable' }),
        }),
      { times: 1 },
    );
    await page.goto(base);
    await expect(page.getByRole('alert')).toContainText(
      'Couldn’t load your conversations and settings',
    );
    await page.getByRole('button', { name: 'Reload settings', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Filter tasks from Design team', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('alert')).not.toBeVisible();
  } finally {
    await context.close();
    await browser.close();
  }
});
test('in-page TODO links and cross-chat threads keep drafts, source navigation and saved corrections intact', async () => {
  const initial = ThreadSnapshotSchema.parse(await (await owner('threads')).json());
  const a = initial.messages.find((m) => m.id === 'sample-message-0'),
    b = initial.messages.find((m) => m.id === 'sample-thread-followup');
  expect(a).toBeTruthy();
  expect(b).toBeTruthy();
  if (!a || !b) throw Error('Missing thread demo sources');
  const linkedTask = initial.tasks.find((t) => t.source_ids.includes(a.id));
  if (!linkedTask) throw Error('Missing linked demo task');
  const extension = join(directory, 'thread-extension');
  await cp(resolve('dist/extension'), extension, { recursive: true });
  const manifest = z
    .looseObject({ host_permissions: z.array(z.string()).optional() })
    .parse(JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8')));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(join(directory, 'thread-browser'), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const id = new URL(worker.url()).host;
    const panel = await context.newPage();
    await panel.goto('chrome-extension://' + id + '/index.html');
    const code = PairCodeSchema.parse(await (await owner('extensions/pairing', {})).json());
    await panel.getByLabel('Server address').fill(base);
    await panel.getByLabel('Pairing code').fill(code.code);
    await panel.getByRole('button', { name: 'Connect workspace' }).click();
    await expect(panel.getByRole('heading', { name: 'My items' })).toBeVisible();
    const connection = ConnectionSchema.parse(
      await worker.evaluate(async () => (await chrome.storage.local.get('connection')).connection),
    );
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;font:14px system-ui;color:#242424}#app{height:100vh;display:flex}#rail{display:flex;flex-direction:column;width:320px;border-right:1px solid #ddd;background:#fff}#rail>header{height:64px;padding:20px;font-size:20px;font-weight:600}#side{flex:1;overflow:auto}#side input{margin:12px;width:290px;padding:12px;border:1px solid #ddd;border-radius:6px}#pane-side [role=row]{padding:24px 18px;border-bottom:1px solid #eee;cursor:pointer}#main{display:flex;flex:1;min-width:0;flex-direction:column;background:#f4f1e9}#main header{padding:24px;background:white;height:70px}.history{padding:50px 35px;flex:1;overflow:auto}[data-id]{margin:22px 0;padding:12px 16px;background:#fff;border-radius:7px;max-width:650px}.selectable-text{margin:0;line-height:1.6}footer{padding:16px;background:#eee}textarea{width:100%;padding:16px;border:0;border-radius:6px;font:14px system-ui}
      </style></head><body><div id="app"><div id="rail"><header>WhatsApp</header><div id="side"><input role="textbox" aria-label="Search or start a new chat"><div id="pane-side"></div></div></div><main id="main"></main></div>
      <script>
      const messages=${JSON.stringify({ a, b })};const drafts={'Design team':'Unsent draft','Product team':''};let current='Design team';
      function show(name){current=name;const m=name==='Design team'?messages.a:messages.b;const main=document.querySelector('#main');main.innerHTML='<header><span dir="auto"></span></header><div class="history"><div data-id=""><p class="selectable-text"></p></div><div data-id="unmatched"><p class="selectable-text"></p></div></div><footer><textarea aria-label="Type a message"></textarea></footer>';main.querySelector('header span').textContent=name;main.querySelector('[data-id]').dataset.id=m.waMessageId;for(const p of main.querySelectorAll('.selectable-text'))p.textContent=m.body;const input=main.querySelector('textarea');input.value=drafts[name];input.addEventListener('input',()=>drafts[current]=input.value);}
      function rows(value){const list=document.querySelector('#pane-side');list.replaceChildren();for(const name of ['Design team','Product team'].filter(n=>value?n.toLowerCase().includes(value.toLowerCase()):n==='Design team')){const row=document.createElement('div');row.setAttribute('role','row');const span=document.createElement('span');span.title=name;span.textContent=name;row.append(span);row.onclick=()=>show(name);list.append(row);}}
      document.querySelector('#side input').addEventListener('input',e=>rows(e.target.value));show('Design team');rows('');
      </script></body></html>`;
    await context.route('https://web.whatsapp.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: html }),
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('https://web.whatsapp.com/');
    const modes = page.locator('#chat2tasks-modes');
    await expect(modes.getByRole('button', { name: 'Threads', exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: `Open ${linkedTask.reference}: ${linkedTask.title}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator('[data-id="unmatched"] [data-chat2tasks]')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Type a message', exact: true })).toHaveValue(
      'Unsent draft',
    );
    await expect(page.locator('#main .selectable-text').first()).toHaveText(a.body);
    await page.screenshot({ path: test.info().outputPath('whatsapp-reading.png') });
    await modes.getByRole('button', { name: 'Threads', exact: true }).click();
    const smart = page.locator('#chat2tasks-threads');
    await smart
      .getByRole('button', { name: 'Onboarding review 2 chats · 2 messages', exact: true })
      .click();
    await expect(
      smart.getByRole('heading', { name: 'Onboarding review', exact: true }),
    ).toBeVisible();
    await expect(smart.getByText(b.body, { exact: true })).toBeVisible();
    await expect(
      smart.getByRole('button', { name: 'Reply in Design team', exact: true }),
    ).toBeVisible();
    await expect(
      smart.getByRole('button', { name: 'Reply in Product team', exact: true }),
    ).toBeVisible();
    expect(await smart.locator('.c-smart').evaluate((el) => el.outerHTML)).not.toContain(
      connection.token,
    );
    await page.screenshot({ path: test.info().outputPath('whatsapp-threads.png') });
    await smart.getByRole('button', { name: 'Chats', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Type a message', exact: true })).toHaveValue(
      'Unsent draft',
    );
    await expect(page.locator('#main .selectable-text').first()).toHaveText(a.body);
    await modes.getByRole('button', { name: 'Threads', exact: true }).click();
    await smart
      .getByRole('button', { name: 'Onboarding review 2 chats · 2 messages', exact: true })
      .click();
    await smart.getByRole('button', { name: 'Reply in Product team', exact: true }).click();
    await expect(page.locator('#main header')).toHaveText('Product team');
    await expect(page.locator('#main [data-id]').first()).toBeFocused();
    await expect(smart).not.toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Type a message', exact: true })).toHaveValue(
      '',
    );
    await modes.getByRole('button', { name: 'Threads', exact: true }).click();
    await smart
      .getByRole('button', { name: 'Onboarding review 2 chats · 2 messages', exact: true })
      .click();
    const followup = smart.locator('.t-message').filter({ hasText: b.body });
    await followup.getByRole('button', { name: 'Move message to another thread' }).click();
    await followup.getByLabel('Move to another thread').selectOption('new');
    await followup.getByLabel('Thread name').fill('Onboarding follow-up');
    await followup.getByRole('button', { name: 'Move message', exact: true }).click();
    await expect(
      smart.getByRole('heading', { name: 'Onboarding follow-up', exact: true }),
    ).toBeVisible();
    await page.reload();
    await modes.getByRole('button', { name: 'Threads', exact: true }).click();
    await smart
      .getByRole('button', { name: 'Onboarding follow-up 1 chat · 1 message', exact: true })
      .click();
    await expect(smart.getByText(b.body, { exact: true })).toBeVisible();
    const saved = ThreadSnapshotSchema.parse(await (await owner('threads')).json());
    expect(saved.threads.find((t) => t.title === 'Onboarding follow-up')?.messageIds).toEqual([
      b.id,
    ]);
    await page.setViewportSize({ width: 640, height: 844 });
    await smart.getByRole('button', { name: '← Threads', exact: true }).click();
    await smart
      .getByRole('button', { name: 'Thursday lunch 1 chat · 1 message', exact: true })
      .click();
    await expect(smart.getByRole('heading', { name: 'Thursday lunch', exact: true })).toBeVisible();
    await expect(smart.locator('.t-task-links')).not.toBeVisible();
    await page.screenshot({ path: test.info().outputPath('whatsapp-threads-narrow.png') });
    await owner('extensions/' + connection.deviceId + '/revoke', {});
    await expect(smart.getByRole('alert')).toContainText(/revoked|Pair the companion/, {
      timeout: 10000,
    });
    await expect(smart.locator('.t-workspace')).not.toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
test('workspace threads open the exact source message and remain navigable on a phone', async () => {
  const state = ThreadSnapshotSchema.parse(await (await owner('threads')).json());
  const source = state.messages.find((m) => m.id === 'sample-thread-followup');
  if (!source) throw Error('Missing thread source');
  const topic = state.threads.find((t) => t.messageIds.includes(source.id));
  if (!topic) throw Error('Missing topic');
  const count = new Set(
    state.messages.filter((m) => m.threadId === topic.id).map((m) => m.conversationId),
  ).size;
  const label = `${topic.title} ${count} ${count === 1 ? 'chat' : 'chats'} · ${topic.messageIds.length} ${topic.messageIds.length === 1 ? 'message' : 'messages'}`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    httpCredentials: { username: 'admin', password },
  });
  try {
    const page = await context.newPage();
    let cold = true;
    await page.route('**/api/threads', async (route) => {
      if (!cold) {
        await route.continue();
        return;
      }
      cold = false;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...state,
          threads: [],
          messages: state.messages.map((m) => ({ ...m, threadId: null })),
          status: { kind: 'running', remaining: state.messages.length },
        }),
      });
    });
    await page.goto(base + '/?view=threads');
    const firstTopic = state.threads[0];
    if (firstTopic)
      await expect(page.getByRole('heading', { name: firstTopic.title, exact: true })).toBeVisible({
        timeout: 10000,
      });
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page.getByRole('heading', { name: topic.title, exact: true })).toBeVisible();
    await expect(page.getByText(source.body, { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('workspace-threads.png') });
    await page.getByRole('button', { name: 'View in Product team', exact: true }).click();
    await expect(page).toHaveURL(new RegExp('message=' + source.id));
    await expect(page.locator(`[data-message-id="${source.id}"]`)).toBeInViewport();
    await expect(page).not.toHaveURL(/[?&]task=/);
    await page.reload();
    await expect(page.locator(`[data-message-id="${source.id}"]`)).toBeInViewport();
    await expect(page).not.toHaveURL(/[?&]task=/);
    await expect(page.locator(`[data-message-id="${source.id}"]`)).toContainText(
      'Original message',
    );
    await expect(page.locator(`[data-message-id="${source.id}"]`)).not.toContainText(
      'Task evidence',
    );
    await page.goBack();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page.getByRole('heading', { name: topic.title, exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('workspace-threads-phone.png') });
    await page.getByRole('button', { name: '← Threads', exact: true }).click();
    await expect(page.getByRole('button', { name: label, exact: true })).toBeFocused();
  } finally {
    await context.close();
    await browser.close();
  }
});

test('desktop setup returns to WhatsApp after choosing the lightweight connection', async () => {
  let config = PublicSettingsSchema.parse(await (await owner('settings')).json());
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ httpCredentials: { username: 'admin', password } });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(window, 'chat2tasksDesktop', {
        configurable: true,
        value: { restart: async () => window.location.reload() },
      });
    });
    await page.route('**/api/desktop/status', (route) =>
      route.fulfill({
        json: {
          setupComplete: false,
          imported: false,
          codex: { installed: true, signedIn: false, signingIn: false, failed: false },
        },
      }),
    );
    await page.route('**/api/desktop/whatsapp/status', (route) =>
      route.fulfill({ json: { status: 'not_connected', qr: null } }),
    );
    await page.route('**/api/settings', async (route) => {
      if (route.request().method() === 'POST') {
        const update = z.object({ settings: SettingsSchema }).parse(route.request().postDataJSON());
        expect(update.settings.desktopGateway.engine).toBe('baileys');
        config = {
          ...config,
          settings: {
            ...update.settings,
            desktopGateway: {
              ...update.settings.desktopGateway,
              activeEngine: update.settings.desktopGateway.engine,
            },
          },
        };
      }
      await route.fulfill({ json: config });
    });
    await page.goto(base);
    await expect(page.getByRole('heading', { name: 'Welcome to Wawa.' })).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('radio', { name: /Lightweight/ }).check();
    await page.getByRole('checkbox', { name: /I understand/ }).check();
    await page.getByRole('button', { name: 'Continue with this connection' }).click();
    await expect(page.getByRole('heading', { name: 'Bring your conversations in.' })).toBeVisible();
    await expect(page.getByRole('radio', { name: /Lightweight/ })).toBeChecked();
    await expect(page.getByRole('button', { name: 'Connect WhatsApp' })).toBeVisible();
  } finally {
    await context.close();
    await browser.close();
  }
});

test('Spotlight finds items and opens matching saved messages without a model', async () => {
  const snapshot = SnapshotSchema.parse(await (await owner('state')).json());
  const task = snapshot.tasks[0];
  const message = snapshot.messages.find((item) => item.body.length > 25);
  if (!task || !message) throw Error('The sample needs an item and a saved message');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    httpCredentials: { username: 'admin', password },
  });
  try {
    const page = await context.newPage();
    await page.goto(base);
    await page.getByRole('button', { name: 'Spotlight', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Spotlight', exact: true })).toBeVisible();
    const input = page.getByRole('textbox', { name: 'Search workspace' });
    await input.fill(task.reference);
    const taskResult = page
      .getByRole('button')
      .filter({ hasText: task.reference })
      .filter({ hasText: task.title });
    await expect(taskResult).toBeVisible();
    await taskResult.click();
    await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible();

    await page.keyboard.press('Meta+k');
    await expect(input).toHaveValue(task.reference);
    await input.fill(message.body.slice(0, 25));
    expect(new URL(page.url()).searchParams.has('q')).toBe(false);
    const messageResult = page.getByRole('button').filter({ hasText: message.body.slice(0, 25) });
    await expect(messageResult).toBeVisible();
    await expect(page.getByText('Exact matches are available.', { exact: false })).toBeVisible();
    await messageResult.click();
    await expect(page.locator(`[data-message-id="${message.id}"]`)).toBeVisible();

    await page.keyboard.press('Meta+k');
    await expect(input).toHaveValue(message.body.slice(0, 25));
    await page.getByText('Search model and server', { exact: true }).click();
    await page.getByRole('radio', { name: 'Another Ollama server' }).check();
    await page.getByLabel('Server address').fill('not a URL');
    await page.getByRole('button', { name: 'Save search server' }).click();
    await expect(page.getByRole('alert')).toContainText('Invalid URL');
    await input.fill('');
    await page.getByLabel('Server address').fill('http://127.0.0.1:18955');
    await page.getByRole('button', { name: 'Save search server' }).click();
    await expect
      .poll(async () => (await (await owner('search/settings')).json()).kind)
      .toBe('server');
    await page.getByRole('radio', { name: 'This workspace machine' }).check();
    await page.getByRole('button', { name: 'Save search server' }).click();
  } finally {
    await context.close();
    await browser.close();
  }
});

test('Spotlight opens matching audio and video messages with playback controls', async () => {
  const snapshot = SnapshotSchema.parse(await (await owner('state')).json());
  const original = snapshot.messages[0];
  if (!original) throw Error('The sample needs a saved message');
  const attachments = ['audio', 'video'].map((type) => ({
    ...original,
    id: `spotlight-${type}`,
    type,
    body: '',
    mediaMimetype: type === 'audio' ? 'audio/ogg' : 'video/mp4',
    image_reading: undefined,
  }));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    httpCredentials: { username: 'admin', password },
  });
  try {
    const page = await context.newPage();
    const searches: { query: string; retry: boolean }[] = [];
    await page.route('**/api/state', async (route) => {
      const response = await route.fetch();
      const state = SnapshotSchema.parse(await response.json());
      await route.fulfill({
        response,
        json: { ...state, messages: [...state.messages, ...attachments] },
      });
    });
    await page.route('**/api/search', async (route) => {
      const { query, retry } = z
        .object({ query: z.string(), retry: z.boolean() })
        .parse(route.request().postDataJSON());
      searches.push({ query, retry });
      const type = query === 'video' ? 'video' : 'audio';
      await route.fulfill({
        json: {
          moreExact: false,
          status: { kind: 'ready' },
          media: {
            kind: query === 'audio' && !retry ? 'unavailable' : 'ready',
            indexed: 2,
            total: 2,
          },
          results: [{ kind: 'message', id: `spotlight-${type}`, match: 'related' }],
        },
      });
    });
    await page.goto(base);
    await page.getByRole('button', { name: 'Spotlight', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Search workspace' });
    for (const type of ['audio', 'video']) {
      await input.fill(type);
      if (type === 'audio') {
        await page.getByRole('button', { name: 'Retry', exact: true }).click();
        await expect
          .poll(() => searches.some((item) => item.query === 'audio' && item.retry))
          .toBe(true);
      } else {
        await expect
          .poll(() => searches.some((item) => item.query === 'video' && !item.retry))
          .toBe(true);
      }
      await page.getByRole('button', { name: new RegExp(`^${type}`, 'i') }).click();
      await expect(page.locator(`[data-message-id="spotlight-${type}"] ${type}`)).toHaveAttribute(
        'controls',
        '',
      );
      await page.keyboard.press('Meta+k');
    }
  } finally {
    await context.close();
    await browser.close();
  }
});

test('desktop opens its workspace when the server becomes available after startup', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    httpCredentials: { username: 'admin', password },
  });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(window, '__TAURI_INTERNALS__', {
        value: {
          invoke: async (command: string) => {
            if (command !== 'retry_remote_workspace') return;
            const attempts = Number(sessionStorage.getItem('reconnect-attempts') ?? 0) + 1;
            sessionStorage.setItem('reconnect-attempts', String(attempts));
            if (attempts === 2) window.location.assign('/');
          },
        },
      });
    });
    await page.clock.install();
    await page.goto(`${base}/?desktop=connecting`);
    await expect(page.getByRole('heading', { name: 'Connecting to your server' })).toBeVisible();
    await page.clock.fastForward(10000);
    await expect
      .poll(() => page.evaluate(() => sessionStorage.getItem('reconnect-attempts')))
      .toBe('1');
    await page.clock.fastForward(10000);
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
    await page.clock.fastForward(30000);
    expect(await page.evaluate(() => sessionStorage.getItem('reconnect-attempts'))).toBe('2');
  } finally {
    await context.close();
    await browser.close();
  }
});
