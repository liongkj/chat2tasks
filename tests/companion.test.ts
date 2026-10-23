import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, now } from '../src/server/store.js';
import { Companion } from '../src/server/companion.js';
import { CaptureSchema } from '../src/shared/companion.js';

const extensionId = 'a'.repeat(32);
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chat2tasks-companion-')),
    store = new Store(dir);
  store.saveSettings({
    settings: {
      ...store.settings(),
      chats: [
        { id: 'chat', name: 'A chat', sessionId: 'session', chatId: 'wa-chat', enabled: true },
      ],
      trigger: { mode: 'manual' },
    },
    secrets: {},
    removeSecrets: [],
  });
  let wakes = 0;
  const companion = new Companion(
    store,
    {
      notify() {},
      wake() {
        wakes++;
      },
      reconfigure() {},
    },
    true,
  );
  const pair = () => companion.pair(companion.createCode().code, 'Test browser', extensionId);
  return {
    dir,
    store,
    companion,
    pair,
    get wakes() {
      return wakes;
    },
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('pairing is one-use and short-lived; a device token is bound to its extension and revocable', () => {
  const f = fixture();
  try {
    const code = f.companion.createCode(),
      paired = f.companion.pair(code.code, 'Chrome', extensionId);
    assert.equal(f.companion.authenticate(paired.token, extensionId), paired.deviceId);
    assert.throws(() => f.companion.pair(code.code, 'Another browser', extensionId));
    assert.throws(() => f.companion.authenticate(paired.token, 'b'.repeat(32)));
    const expired = f.companion.createCode();
    f.store.db.prepare('UPDATE companion_codes SET expires=?').run(now() - 1);
    assert.throws(() => f.companion.pair(expired.code, 'Chrome', extensionId));
    assert.ok(
      !JSON.stringify(f.store.db.prepare('SELECT * FROM companion_devices').all()).includes(
        paired.token,
      ),
    );
    f.companion.revoke(paired.deviceId);
    assert.throws(() => f.companion.authenticate(paired.token, extensionId));
    assert.equal(f.companion.devices().devices.length, 0);
  } finally {
    f.close();
  }
});
test('a reviewed capture saves browser provenance once, stays pending in manual mode, and rejects changed retries', () => {
  const f = fixture();
  try {
    const paired = f.pair();
    const input = CaptureSchema.parse({
      id: 'e0551cb8-24f6-4a03-85ce-a4cc4fa252e6',
      chatId: 'chat',
      text: 'Check the export column',
      url: 'https://web.whatsapp.com/',
      title: 'WhatsApp',
    });
    const first = f.companion.capture(paired.deviceId, input);
    assert.equal(first.queued, false);
    assert.equal(f.companion.capture(paired.deviceId, input).duplicate, true);
    assert.equal(f.store.messages().length, 1);
    assert.equal(f.store.messages()[0]?.browser_source?.url, 'https://web.whatsapp.com/');
    assert.equal(f.store.messages()[0]?.waMessageId, undefined);
    assert.equal(f.store.pending(f.store.messages()).length, 1);
    assert.equal(f.store.status().pending, 1);
    assert.equal(f.store.jobs().length, 0);
    assert.equal(f.store.snapshot().usage.calls, 0);
    assert.throws(() => f.companion.capture(paired.deviceId, { ...input, text: 'Changed retry' }));
  } finally {
    f.close();
  }
});
test('automatic captures use the existing quiet-period queue and paused chats cannot accept captures', () => {
  const f = fixture();
  try {
    const paired = f.pair(),
      settings = f.store.settings();
    f.store.saveSettings({
      settings: { ...settings, trigger: { mode: 'automatic', decisionProfileId: null } },
      secrets: {},
      removeSecrets: [],
    });
    const input = CaptureSchema.parse({
      id: 'e0551cb8-24f6-4a03-85ce-a4cc4fa252e6',
      chatId: 'chat',
      text: 'An action',
      url: 'https://web.whatsapp.com/',
      title: 'WhatsApp',
    });
    assert.equal(f.companion.capture(paired.deviceId, input).queued, true);
    assert.equal(f.store.jobs()[0]?.reconcile, 0);
    assert.ok((f.store.jobs()[0]?.due ?? 0) > now() + 40);
    f.store.saveSettings({
      settings: {
        ...f.store.settings(),
        chats: settings.chats.map((c) => ({ ...c, enabled: false })),
      },
      secrets: {},
      removeSecrets: [],
    });
    assert.throws(() => f.companion.capture(paired.deviceId, input));
  } finally {
    f.close();
  }
});
