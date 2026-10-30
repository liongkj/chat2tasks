const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { access, mkdir, readFile } = require('node:fs/promises');
const { createServer } = require('node:net');
const { join } = require('node:path');
const { createInterface } = require('node:readline');
const { replaceWorkspace } = require('./workspace-replace.cjs');

const resources = process.env.C2T_TAURI_RESOURCES;
const data = process.env.C2T_TAURI_DATA;
const demo = process.env.C2T_TAURI_DEMO === '1';
if (!resources || !data) throw new Error('The preview runtime is not configured.');

const runtime = join(resources, 'runtime');
const gatewayRuntime = join(resources, 'gateway');
const workspace = join(data, demo ? 'sample-workspace' : 'workspace');
const gatewayData = join(data, 'gateway');
const codexHome = join(data, 'codex');
const token = randomBytes(32).toString('hex');
const tauriOrigin = process.platform === 'win32' ? 'http://tauri.localhost' : 'tauri://localhost';
const codexPlatform = process.platform === 'win32' ? 'win32' : 'darwin';
const codexArch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
const codexTarget = process.platform === 'win32' ? 'pc-windows-msvc' : 'apple-darwin';
const codex = join(
  runtime,
  'node_modules',
  '@openai',
  `codex-${codexPlatform}-${process.arch}`,
  'vendor',
  `${codexArch}-${codexTarget}`,
  'bin',
  process.platform === 'win32' ? 'codex.exe' : 'codex',
);
let gateway, server, gatewayPort, serverPort;
let stopping = false;

function cleanEnv() {
  const env = { ...process.env };
  for (const name of [
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'OPENAI_BASE_URL',
    'NODE_OPTIONS',
    'ELECTRON_RUN_AS_NODE',
  ])
    delete env[name];
  return env;
}
function report(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}
function freePort() {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      if (!address || typeof address === 'string')
        return reject(new Error('Could not choose a local port.'));
      socket.close(() => resolve(address.port));
    });
  });
}
async function ready(port, child) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('A local service stopped.');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('A local service did not start.');
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 7000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
async function startGateway() {
  await mkdir(gatewayData, { recursive: true, mode: 0o700 });
  const browser = join(
    gatewayRuntime,
    (await readFile(join(gatewayRuntime, 'browser-path.txt'), 'utf8')).trim(),
  );
  await access(browser);
  gateway = spawn(process.execPath, [join(gatewayRuntime, 'dist', 'main.js')], {
    cwd: gatewayData,
    stdio: 'ignore',
    env: {
      ...cleanEnv(),
      NODE_ENV: 'production',
      PORT: String(gatewayPort),
      LOG_LEVEL: 'error',
      UPDATE_CHECK_ENABLED: 'false',
      AUTO_START_SESSIONS: 'true',
      ENGINE_TYPE: 'whatsapp-web.js',
      SSRF_ALLOWED_HOSTS: '127.0.0.1',
      PUPPETEER_EXECUTABLE_PATH: browser,
      PUPPETEER_ARGS: '--disable-gpu',
    },
  });
  await ready(gatewayPort, gateway);
  await access(join(gatewayData, 'data', '.api-key'));
}
async function startServer() {
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const origin = `http://127.0.0.1:${serverPort}`;
  server = spawn(process.execPath, [join(runtime, 'dist', 'server', 'index.js')], {
    cwd: runtime,
    stdio: 'ignore',
    env: {
      ...cleanEnv(),
      NODE_ENV: 'production',
      CHAT2TASKS_DESKTOP: demo ? 'false' : 'true',
      DEMO: demo ? 'true' : 'false',
      SYNC_DISABLED: demo ? 'true' : 'false',
      PORT: String(serverPort),
      BIND_HOST: '127.0.0.1',
      PUBLIC_ORIGIN: origin,
      APP_PASSWORD: '',
      DATA_DIR: workspace,
      CODEX_HOME: codexHome,
      CODEX_BIN: codex,
      DESKTOP_OPENWA_URL: `http://127.0.0.1:${gatewayPort}`,
      DESKTOP_OPENWA_KEY_FILE: join(gatewayData, 'data', '.api-key'),
      CHAT2TASKS_TAURI_ORIGIN: tauriOrigin,
      CHAT2TASKS_TAURI_TOKEN: token,
    },
  });
  await ready(serverPort, server);
}
function runImport(source, destination, passphrase) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(runtime, 'dist', 'desktop', 'transfer-cli.js'), source, destination],
      { cwd: runtime, env: cleanEnv(), stdio: ['pipe', 'ignore', 'ignore'] },
    );
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
    child.stdin.end(passphrase);
  });
}
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await Promise.all([stop(server), stop(gateway)]);
  process.exit(0);
}
async function main() {
  gatewayPort = await freePort();
  do {
    serverPort = await freePort();
  } while (serverPort === gatewayPort);
  if (!demo) {
    const existingKey = await access(join(gatewayData, 'data', '.api-key')).then(
      () => true,
      () => false,
    );
    const gatewayReady = startGateway().then(
      () => null,
      (error) => error,
    );
    if (!existingKey) {
      const error = await gatewayReady;
      if (error) throw error;
    }
  }
  await startServer();
  report({ type: 'ready', origin: `http://127.0.0.1:${serverPort}`, token, demo });
}
let queue = Promise.resolve();
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  queue = queue
    .then(async () => {
      const request = JSON.parse(line);
      if (request.action === 'shutdown') return shutdown();
      if (
        request.action !== 'import' ||
        typeof request.path !== 'string' ||
        typeof request.passphrase !== 'string' ||
        request.passphrase.length < 8 ||
        request.passphrase.length > 1024
      ) {
        return report({ ok: false, error: 'Choose a transfer file and enter its passphrase.' });
      }
      const result = await replaceWorkspace({
        workspace,
        source: request.path,
        passphrase: request.passphrase,
        stopServer: () => stop(server),
        startServer,
        runImport,
      });
      report(result);
    })
    .catch(() => report({ ok: false, error: 'The request could not be completed.' }));
});
input.once('close', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
main().catch(() => {
  report({ type: 'error' });
  void shutdown();
});
