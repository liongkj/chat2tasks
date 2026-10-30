import { spawn } from 'node:child_process';
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = join(root, 'work', 'tauri');
const runtime = join(stage, 'runtime');
const gateway = join(stage, 'gateway');
const source = process.env.CHAT2TASKS_OPENWA_SOURCE || join(root, 'work', 'tauri-openwa-source');
const browser = process.env.CHAT2TASKS_BROWSER_CACHE || join(root, 'work', 'tauri-openwa-browser');
const expectedCommit = 'f045dde1f9f8b623668ab02971009228296d60e4';

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const env = { ...process.env, ...options.env };
    for (const name of Object.keys(env))
      if (name.toLowerCase() === 'npm_config_allow_scripts') delete env[name];
    if (command === 'npm' && process.platform === 'win32') {
      if (!process.env.npm_execpath) throw new Error('Run this preparation through npm.');
      args = [process.env.npm_execpath, ...args];
      command = process.execPath;
    }
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      env,
      stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolveRun(output.trim()) : reject(new Error(`${command} failed (${code})`)),
    );
  });
}
async function exists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}

if (!['darwin', 'win32'].includes(process.platform))
  throw new Error('Prepare the preview on the target Mac or Windows architecture.');
await mkdir(join(root, 'work'), { recursive: true });
if (!(await exists(join(source, '.git'))))
  await run('git', [
    'clone',
    '--depth',
    '1',
    '--branch',
    'v0.25.0',
    'https://github.com/rmyndharis/OpenWA.git',
    source,
  ]);
const commit = await run('git', ['rev-parse', 'HEAD'], { cwd: source, capture: true });
if (commit !== expectedCommit) throw new Error('OpenWA source does not match the pinned release.');
const entry = join(source, 'src', 'main.ts');
const original = await readFile(entry, 'utf8');
const oldListen = 'await app.listen(port);';
const localListen = "await app.listen(port, '127.0.0.1');";
if (original.includes(oldListen)) await writeFile(entry, original.replace(oldListen, localListen));
else if (!original.includes(localListen))
  throw new Error('OpenWA listener changed; review the local-only patch.');
if (!(await exists(join(source, 'node_modules'))))
  await run('npm', ['ci', '--no-audit', '--no-fund'], {
    cwd: source,
    env: { PUPPETEER_SKIP_DOWNLOAD: 'true' },
  });
await run('npm', ['run', 'build'], { cwd: source });
await run('npm', ['exec', '--', 'puppeteer', 'browsers', 'install', 'chrome', '--path', browser], {
  cwd: source,
});
const browserExecutable = await run(
  process.execPath,
  ['-p', "require('puppeteer').executablePath()"],
  {
    cwd: source,
    capture: true,
    env: { PUPPETEER_CACHE_DIR: browser },
  },
);
const browserRelative = relative(browser, browserExecutable);
if (browserRelative.startsWith('..')) throw new Error('The browser is outside its expected cache.');

await rm(stage, { recursive: true, force: true });
await mkdir(runtime, { recursive: true });
await mkdir(gateway, { recursive: true });
await cp(join(root, 'package.json'), join(runtime, 'package.json'));
await cp(join(root, 'package-lock.json'), join(runtime, 'package-lock.json'));
await run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: runtime,
});
const codexPackage = `codex-${process.platform}-${process.arch}`;
await mkdir(join(runtime, 'node_modules', '@openai'), { recursive: true });
await cp(
  join(root, 'node_modules', '@openai', codexPackage),
  join(runtime, 'node_modules', '@openai', codexPackage),
  { recursive: true },
);
await cp(join(root, 'prompts'), join(runtime, 'prompts'), { recursive: true });
for (const name of await readdir(root))
  if (name.endsWith('schema.json')) await cp(join(root, name), join(runtime, name));
for (const name of ['dist', 'node_modules', 'package.json', 'package-lock.json', 'LICENSE'])
  await cp(join(source, name), join(gateway, name), { recursive: true });
await run('npm', ['prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: gateway,
});
await cp(browser, join(gateway, 'browser'), { recursive: true });
await writeFile(join(gateway, 'browser-path.txt'), join('browser', browserRelative));
process.stdout.write('Prepared the isolated Tauri preview dependencies.\n');
