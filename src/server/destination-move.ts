import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { acquireLock } from '../../desktop/process-lock.mjs';
import { DesktopSharingUpdateSchema } from '../shared/desktop-sharing.js';
import { Store } from './store.js';
import { moveMarker, verifyMoveGrant, WorkspaceOwnership } from './workspace-ownership.js';
import { importMovedWorkspace } from './workspace-transfer.js';

export class DestinationMove {
  constructor(private readonly data: string) {}

  private paths(moveId: string) {
    const id = z.uuid().parse(moveId);
    const operation = join(this.data, 'server-moves', id);
    return {
      operation,
      identity: join(operation, 'identity'),
      staged: join(operation, 'workspace'),
      live: join(this.data, 'workspace'),
      backup: join(this.data, `workspace.before-move-${id}`),
    };
  }

  private ownerDirectory(moveId: string) {
    const paths = this.paths(moveId);
    for (const directory of [paths.identity, join(paths.staged, '.ownership')])
      if (existsSync(join(directory, 'ownership.sqlite'))) return directory;
    const live = join(paths.live, '.ownership');
    if (
      existsSync(join(live, 'ownership.sqlite')) &&
      WorkspaceOwnership.open(live, 'client').matchesMove(moveId)
    )
      return live;
    return null;
  }

  private async preserveConnections(moveId: string) {
    for (const name of ['gateway', 'codex']) {
      const original = join(this.data, name);
      const backup = join(this.data, `${name}.before-move-${moveId}`);
      if (!existsSync(original)) continue;
      if (existsSync(backup)) throw new Error('A previous connection backup already exists.');
      if (name === 'gateway') {
        const lock = acquireLock(original);
        lock.close();
      }
      await rename(original, backup);
    }
  }

  async prepare(moveId: string) {
    const paths = this.paths(moveId);
    await mkdir(paths.operation, { recursive: true, mode: 0o700 });
    const directory = this.ownerDirectory(moveId) ?? paths.identity;
    return WorkspaceOwnership.open(directory, 'client').identity();
  }

  private async selectLocal(moveId: string) {
    const paths = this.paths(moveId);
    await mkdir(paths.operation, { recursive: true, mode: 0o700 });
    const targetFile = join(paths.operation, 'workspace-target.tmp');
    await writeFile(targetFile, JSON.stringify({ kind: 'local' }), { mode: 0o600 });
    await rename(targetFile, join(this.data, 'workspace-target.json'));
  }

  async recoverCompleted(moveId: string) {
    const paths = this.paths(moveId);
    const directory = join(paths.live, '.ownership');
    if (!existsSync(join(directory, 'ownership.sqlite'))) return null;
    const owner = WorkspaceOwnership.open(directory, 'client');
    const completion = owner.completedMove(moveId);
    if (!completion) return null;
    owner.activate({ workspace: paths.live, grant: completion.grant });
    await this.selectLocal(moveId);
    return completion.acknowledgement;
  }

  checkAvailable() {
    const desktopLock = acquireLock(join(this.data, 'workspace-control'));
    let serverLock: { close(): void } | undefined;
    try {
      serverLock = acquireLock(join(this.data, 'workspace-server-control'));
      const gateway = join(this.data, 'gateway');
      if (existsSync(gateway)) {
        const gatewayLock = acquireLock(gateway);
        gatewayLock.close();
      }
    } finally {
      serverLock?.close();
      desktopLock.close();
    }
  }

  async receive(input: {
    grant: unknown;
    trustedSourceKey: string;
    archivePath: string;
    localPort: number;
    password: string;
  }) {
    const grant = verifyMoveGrant(input.grant, input.trustedSourceKey);
    const paths = this.paths(grant.payload.move.id);
    const sharing = DesktopSharingUpdateSchema.parse({
      kind: 'enabled',
      origin: grant.payload.move.targetOrigin,
      port: input.localPort,
      password: input.password,
    });
    const desktopLock = acquireLock(join(this.data, 'workspace-control'));
    let serverLock: { close(): void } | undefined;
    try {
      serverLock = acquireLock(join(this.data, 'workspace-server-control'));
      const directory = this.ownerDirectory(grant.payload.move.id);
      if (!directory) throw new Error('Prepare this computer as the target before moving.');
      const owner = WorkspaceOwnership.open(directory, 'client');
      const promoted = join(paths.live, '.ownership');
      if (directory !== promoted) {
        const passphrase = await owner.stage(grant, input.trustedSourceKey, input.archivePath);
        if (!existsSync(paths.staged))
          await importMovedWorkspace(input.archivePath, paths.staged, passphrase);
        const restored = new Store(paths.staged);
        try {
          restored.saveDesktopSharing(sharing);
          restored.setMeta('move_activation', moveMarker(grant));
        } finally {
          restored.close();
        }
        const stagedOwner = join(paths.staged, '.ownership');
        if (directory !== stagedOwner) await rename(directory, stagedOwner);
        await this.preserveConnections(grant.payload.move.id);
        if (existsSync(paths.live)) {
          if (existsSync(paths.backup))
            throw new Error('The previous workspace backup already exists.');
          await rename(paths.live, paths.backup);
        }
        await rename(paths.staged, paths.live);
      }
      const promotedOwner = WorkspaceOwnership.open(promoted, 'client');
      promotedOwner.activate({ workspace: paths.live, grant });
      await this.selectLocal(grant.payload.move.id);
      return promotedOwner.activationAck(grant);
    } finally {
      serverLock?.close();
      desktopLock.close();
    }
  }
}
