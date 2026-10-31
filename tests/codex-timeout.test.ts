import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodex } from '../src/server/ai.js';

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

test('a timed-out Codex request stops both its launcher and the model process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat2tasks-codex-timeout-'));
  const launcher = join(dir, 'launcher.cjs');
  const pidFile = join(dir, 'pids');
  const originalCodex = process.env.CODEX_BIN;
  let pids: number[] = [];
  writeFileSync(
    launcher,
    `const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' });
writeFileSync(process.argv[2], String(process.pid) + '\\n' + String(child.pid));
setInterval(() => {}, 10000);
`,
  );
  process.env.CODEX_BIN = process.execPath;
  try {
    await assert.rejects(runCodex([launcher, pidFile], '', dir, 2000), /timed out/);
    pids = readFileSync(pidFile, 'utf8').trim().split('\n').map(Number);
    assert.equal(pids.length, 2);
    assert.ok(pids.every((pid) => Number.isInteger(pid) && pid > 0));
    const deadline = Date.now() + 3000;
    while (pids.some(alive) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(pids.filter(alive), []);
  } finally {
    for (const pid of pids) {
      try {
        if (alive(pid)) process.kill(pid, 'SIGKILL');
      } catch {
        // The process may have exited since the liveness check.
      }
    }
    if (originalCodex === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = originalCodex;
    rmSync(dir, { recursive: true, force: true });
  }
});
