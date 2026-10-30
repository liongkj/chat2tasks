import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { backup } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { extract, pack } from 'tar-stream';
import { Store } from './store.js';

const magic = Buffer.from('C2T1');
const headerSize = magic.length + 16 + 12;
const tagSize = 16;

function keyFor(passphrase: string, salt: Buffer) {
  if (passphrase.length < 8) throw new Error('Use a passphrase with at least eight characters.');
  return scryptSync(passphrase, salt, 32);
}

async function mediaFiles(dir: string) {
  try {
    const entries = await readdir(join(dir, 'media'), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.bin$/.test(entry.name))
      .map((entry) => join('media', entry.name));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

/** Export a consistent SQLite snapshot and cached media, encrypted with the owner's passphrase. */
export async function exportWorkspace(store: Store, destination: string, passphrase: string) {
  const salt = randomBytes(16),
    iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(passphrase, salt), iv);
  const temporary = await mkdtemp(join(tmpdir(), 'chat2tasks-export-'));
  try {
    await backup(store.db, join(temporary, 'tasks.sqlite'));
    const archive = pack();
    await writeFile(destination, Buffer.concat([magic, salt, iv]), { flag: 'wx', mode: 0o600 });
    const output = pipeline(
      archive,
      createGzip(),
      cipher,
      createWriteStream(destination, { flags: 'a' }),
    );
    void output.catch(() => undefined);
    try {
      const files = [
        { name: 'tasks.sqlite', path: join(temporary, 'tasks.sqlite') },
        { name: 'vault.key', path: join(store.dir, 'vault.key') },
        ...(await mediaFiles(store.dir)).map((name) => ({ name, path: join(store.dir, name) })),
      ];
      for (const file of files) {
        const size = (await stat(file.path)).size;
        await pipeline(
          createReadStream(file.path),
          archive.entry({ name: file.name, size, mode: 0o600 }),
        );
      }
      archive.finalize();
      await output;
      await appendFile(destination, cipher.getAuthTag());
    } catch (error) {
      archive.destroy();
      await output.catch(() => undefined);
      await rm(destination, { force: true });
      throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Restore only into a new directory; keep the old gateway and all chats paused. */
export async function importWorkspace(source: string, destination: string, passphrase: string) {
  const exists = await lstat(destination).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
  if (exists) throw new Error('Choose an empty location for the imported workspace.');
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const staged = await mkdtemp(join(dirname(destination), '.chat2tasks-import-'));
  try {
    const file = await open(source, 'r');
    const size = (await file.stat()).size;
    if (size <= headerSize + tagSize) {
      await file.close();
      throw new Error('The workspace transfer file is incomplete.');
    }
    const header = Buffer.alloc(headerSize),
      tag = Buffer.alloc(tagSize);
    await file.read(header, 0, header.length, 0);
    await file.read(tag, 0, tag.length, size - tagSize);
    await file.close();
    if (!header.subarray(0, magic.length).equals(magic))
      throw new Error('This is not a Chat2Tasks workspace transfer.');
    const salt = header.subarray(magic.length, magic.length + 16);
    const iv = header.subarray(magic.length + 16);
    const decipher = createDecipheriv('aes-256-gcm', keyFor(passphrase, salt), iv);
    decipher.setAuthTag(tag);
    const archive = extract();
    const found = new Set<string>();
    archive.on('entry', (entry, input, next) => {
      const name = entry.name;
      if (
        entry.type !== 'file' ||
        found.has(name) ||
        !(
          name === 'tasks.sqlite' ||
          name === 'vault.key' ||
          /^media\/[a-f0-9]{64}\.bin$/.test(name)
        )
      ) {
        input.resume();
        archive.destroy(new Error('The workspace transfer contains an unexpected file.'));
        return;
      }
      found.add(name);
      const target = name.startsWith('media/')
        ? join(staged, 'media', basename(name))
        : join(staged, name);
      void mkdir(dirname(target), { recursive: true, mode: 0o700 })
        .then(() => pipeline(input, createWriteStream(target, { flags: 'wx', mode: 0o600 })))
        .then(
          () => next(),
          (error: Error) => archive.destroy(error),
        );
    });
    await pipeline(
      createReadStream(source, { start: headerSize, end: size - tagSize - 1 }),
      decipher,
      createGunzip(),
      archive,
    );
    if (!found.has('tasks.sqlite') || !found.has('vault.key'))
      throw new Error('The workspace transfer is missing required files.');
    const restored = new Store(staged);
    try {
      const integrity = restored.db.prepare('PRAGMA quick_check').get();
      if (!integrity || integrity.quick_check !== 'ok')
        throw new Error('The workspace database is damaged.');
      const settings = restored.settings();
      restored.saveSettings({
        settings: {
          ...settings,
          openwaUrl: '',
          webhookUrl: '',
          chats: settings.chats.map((chat) => ({ ...chat, enabled: false })),
        },
        secrets: {},
        removeSecrets: ['openwa'],
      });
      restored.db.exec('DELETE FROM chat_jobs');
      restored.setMeta('registered_webhook_url', '');
      restored.setMeta('managed_webhooks', {});
      restored.setMeta('workspace_imported', true);
      restored.setMeta('desktop_setup_complete', false);
    } finally {
      restored.close();
    }
    await rename(staged, destination);
  } catch (error) {
    try {
      await rm(staged, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Could not restore the workspace or remove its temporary files.',
      );
    }
    throw error;
  }
}
