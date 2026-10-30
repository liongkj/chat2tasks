import { access, cp } from 'node:fs/promises';
import { resolve } from 'node:path';

const stage = resolve('work/desktop');
for (const name of ['runtime', 'gateway', 'node']) {
  try {
    await access(resolve(stage, name));
  } catch {
    throw new Error('Prepare the Mac runtimes first with npm run mac:prepare.');
  }
}
await cp('dist', resolve(stage, 'runtime/dist'), { recursive: true });
await cp('desktop/tauri-startup.html', 'dist/client/tauri-startup.html');
process.stdout.write('Prepared the Tauri preview using its separate app data directory.\n');
