import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync } from 'fflate';
await build({
  entryPoints: ['extension/src/background.ts'],
  outfile: 'dist/extension/background.js',
  bundle: true,
  format: 'esm',
  target: 'chrome116',
  minify: true,
});
await cp('extension/manifest.json', 'dist/extension/manifest.json');
await cp('extension/icons', 'dist/extension/icons', { recursive: true });
const entries = {};
async function walk(directory, prefix = '') {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + item.name,
      path = join(directory, item.name);
    if (item.isDirectory()) await walk(path, name + '/');
    else if (item.isFile()) entries[name] = new Uint8Array(await readFile(path));
  }
}
await walk('dist/extension');
await mkdir('dist/client/downloads', { recursive: true });
await writeFile('dist/client/downloads/chat2tasks-chrome.zip', zipSync(entries));
