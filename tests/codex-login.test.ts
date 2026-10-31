import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexLogin } from '../src/server/codex-login.js';

// The fixture is a shebang script; Windows cannot execute one without a shell,
// and the desktop runtime spawns a real codex.exe there.
const fixtureSkip = process.platform === 'win32' && 'the fake codex executable needs a POSIX shell';

test(
  'a server uses device sign-in while the local desktop keeps browser sign-in',
  { skip: fixtureSkip },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'wawa-device-login-'));
    const executable = join(root, 'codex');
    const oldCodex = process.env.CODEX_BIN;
    await writeFile(
      executable,
      `#!/usr/bin/env node
const readline = require('node:readline');
readline.createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (!request.id) return;
  const result = request.method === 'initialize' ? {} : request.params.type === 'chatgptDeviceCode'
    ? {type: 'chatgptDeviceCode', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-CODE', loginId: 'fixture'}
    : {type: 'chatgpt', authUrl: 'https://auth.openai.com/example', loginId: 'fixture'};
  process.stdout.write(JSON.stringify({id: request.id, result}) + '\\n');
});
`,
    );
    await chmod(executable, 0o700);
    process.env.CODEX_BIN = executable;
    const login = new CodexLogin();
    const desktopLogin = new CodexLogin();
    try {
      assert.deepEqual(await login.start('device'), {
        url: 'https://auth.openai.com/codex/device',
        userCode: 'TEST-CODE',
      });
      assert.deepEqual(await desktopLogin.start(), { url: 'https://auth.openai.com/example' });
    } finally {
      login.stop();
      desktopLogin.stop();
      if (oldCodex === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = oldCodex;
      await rm(root, { recursive: true, force: true });
    }
  },
);
