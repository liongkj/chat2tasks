import { access, chmod, cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const stage = resolve('work/tauri');
if (!process.versions.bun) throw new Error('Run this preparation with Bun.');
for (const name of ['runtime', 'gateway']) {
  try {
    await access(resolve(stage, name));
  } catch {
    throw new Error('Prepare the preview dependencies first with npm run tauri:stage.');
  }
}
await mkdir(resolve(stage, 'bun'), { recursive: true });
const bun = resolve(stage, 'bun', process.platform === 'win32' ? 'bun.exe' : 'bun');
await rm(bun, { force: true });
await cp(process.execPath, bun);
if (process.platform !== 'win32') await chmod(bun, 0o755);
await cp('dist', resolve(stage, 'runtime/dist'), { recursive: true });
await cp('desktop/tauri-startup.html', 'dist/client/tauri-startup.html');
process.stdout.write('Prepared the Tauri preview using its separate app data directory.\n');
