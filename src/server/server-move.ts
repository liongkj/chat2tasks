import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { MoveGate } from './move-gate.js';
import type { Store } from './store.js';
import { snapshotDigest, type WorkspaceOwnership } from './workspace-ownership.js';
import { exportWorkspace } from './workspace-transfer.js';

export class ServerMove {
  constructor(
    private readonly parts: {
      gate: MoveGate;
      ownership: WorkspaceOwnership;
      store: Store;
      stopBackground: () => Promise<void>;
    },
  ) {}

  async begin({
    move,
    archivePath,
  }: {
    move: Parameters<WorkspaceOwnership['prepare']>[0];
    archivePath: string;
  }) {
    const { gate, ownership, store, stopBackground } = this.parts;
    if (gate.isPaused()) throw new Error('A server move is already in progress.');
    const drained = gate.pause();
    try {
      ownership.prepare(move);
    } catch (error) {
      gate.resume();
      throw error;
    }
    await Promise.all([drained, stopBackground()]);
    const passphrase = randomBytes(32).toString('base64url');
    await exportWorkspace(store, archivePath, passphrase);
    const file = await open(archivePath, 'r+');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    if (process.platform !== 'win32') {
      const directory = await open(dirname(archivePath), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    return ownership.fence(move.id, await snapshotDigest(archivePath), passphrase);
  }
}
