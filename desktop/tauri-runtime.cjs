const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { access, mkdir, readFile } = require('node:fs/promises');
const { createServer } = require('node:net');
const { join } = require('node:path');
const { createInterface } = require('node:readline');
const { replaceWorkspace } = require('./workspace-replace.cjs');
const { workspaceGatewayLaunch, workspaceSharingPort } = require('./gateway-mode.cjs');
const { acquireLock } = require('./process-lock.mjs');

const resources = process.env.C2T_TAURI_RESOURCES;
const data = process.env.C2T_TAURI_DATA;
const demo = process.env.C2T_TAURI_DEMO === '1';
const testDiagnostics = process.env.C2T_TAURI_TEST_DIAGNOSTICS === '1';
if (!resources || !data) throw new Error('The preview runtime is not configured.');

const runtime = join(resources, 'runtime');
const gatewayRuntime = join(resources, 'gateway');
const workspace = join(data, demo ? 'sample-workspace' : 'workspace');
const gatewayData = join(data, 'gateway');
const codexHome = join(data, 'codex');
const token = randomBytes(32).toString('hex');
const tauriOrigin = process.platform === 'win32' ? 'http://tauri.localhost' : 'tauri://localhost';
const codexTargets = {
  darwin: 'apple-darwin',
  linux: 'unknown-linux-musl',
  win32: 'pc-windows-msvc',
};
const codexTarget = codexTargets[process.platform];
if (!codexTarget || !['x64', 'arm64'].includes(process.arch))
  throw new Error('This desktop architecture is not supported.');
const codexArch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
const codex = join(
  runtime,
  'node_modules',
  '@openai',
  `codex-${process.platform}-${process.arch}`,
  'vendor',
  `${codexArch}-${codexTarget}`,
  'bin',
  process.platform === 'win32' ? 'codex.exe' : 'codex',
);
let gateway,
  server,
  gatewayPort,
  serverPort,
  gatewayMode = 'local',
  resumeSessions = false,
  sharingUnavailable = false;
let stopping = false;
let desktopLock;

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
function portAvailable(port) {
  return new Promise((resolve) => {
    const socket = createServer();
    socket.once('error', () => resolve(false));
    socket.listen(port, '127.0.0.1', () => socket.close(() => resolve(true)));
  });
}
async function ready(port, child, name) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${name} stopped.`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${name} did not start.`);
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
  gateway = spawn(
    process.execPath,
    [join(__dirname, 'gateway-runner.cjs'), join(gatewayRuntime, 'dist', 'main.js')],
    {
      cwd: gatewayData,
      stdio: testDiagnostics ? ['ignore', 2, 2] : 'ignore',
      windowsHide: true,
      env: {
        ...cleanEnv(),
        NODE_ENV: 'production',
        PORT: String(gatewayPort),
        LOG_LEVEL: testDiagnostics ? 'info' : 'error',
        UPDATE_CHECK_ENABLED: 'false',
        AUTO_START_SESSIONS: resumeSessions ? 'true' : 'false',
        ENGINE_TYPE: 'whatsapp-web.js',
        SSRF_ALLOWED_HOSTS: '127.0.0.1',
        PUPPETEER_EXECUTABLE_PATH: browser,
        PUPPETEER_ARGS: '--disable-gpu',
      },
    },
  );
  await ready(gatewayPort, gateway, 'The WhatsApp gateway');
  await access(join(gatewayData, 'data', '.api-key'));
}
async function startServer() {
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  if (!demo && !sharingUnavailable) {
    ({ mode: gatewayMode, resumeSessions } = workspaceGatewayLaunch(workspace));
    if (gatewayMode === 'remote') {
      await stop(gateway);
      gateway = undefined;
    } else if (!gateway || gateway.exitCode !== null || gateway.signalCode !== null) {
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
  }
  const origin = `http://127.0.0.1:${serverPort}`;
  server = spawn(process.execPath, [join(runtime, 'dist', 'server', 'index.js')], {
    cwd: runtime,
    stdio: testDiagnostics ? ['ignore', 2, 2] : 'ignore',
    windowsHide: true,
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
      DESKTOP_GATEWAY_MODE: gatewayMode,
      CHAT2TASKS_TAURI_ORIGIN: tauriOrigin,
      CHAT2TASKS_TAURI_TOKEN: token,
      CHAT2TASKS_SHARING_UNAVAILABLE: sharingUnavailable ? 'port_in_use' : '',
    },
  });
  await ready(serverPort, server, 'The app service');
}
function runImport(source, destination, passphrase) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(runtime, 'dist', 'desktop', 'transfer-cli.js'), source, destination],
      {
        cwd: runtime,
        env: cleanEnv(),
        stdio: testDiagnostics ? ['pipe', 2, 2] : ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      },
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
  desktopLock?.close();
  process.exit(0);
}
async function main() {
  desktopLock = acquireLock(join(data, demo ? 'sample-control' : 'workspace-control'));
  if (!demo) {
    const { WorkspaceOwnership } = require(join(runtime, 'dist', 'desktop', 'ownership.cjs'));
    WorkspaceOwnership.open(join(workspace, '.ownership'), 'server').assertCanRun();
  }
  const sharingPort = demo ? undefined : workspaceSharingPort(workspace);
  sharingUnavailable = sharingPort !== undefined && !(await portAvailable(sharingPort));
  const availableSharingPort = sharingUnavailable ? undefined : sharingPort;
  do {
    gatewayPort = await freePort();
  } while (gatewayPort === availableSharingPort);
  do {
    serverPort = availableSharingPort ?? (await freePort());
  } while (serverPort === gatewayPort);
  await startServer();
  report({
    type: 'ready',
    origin: `http://127.0.0.1:${serverPort}`,
    token,
    demo,
    ...(testDiagnostics
      ? { gatewayMode, localGatewayRunning: Boolean(gateway), resumeSessions }
      : {}),
  });
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
        onError: testDiagnostics ? (error) => console.error(error.stack) : undefined,
      });
      report({ ...result, ...(testDiagnostics ? { gatewayMode, resumeSessions } : {}) });
    })
    .catch(() => report({ ok: false, error: 'The request could not be completed.' }));
});
input.once('close', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
main().catch((error) => {
  if (testDiagnostics) console.error(error.message);
  report({
    type: 'error',
    ...(error.code === 'CHAT2TASKS_IN_USE'
      ? { code: 'already_running' }
      : error.code === 'CHAT2TASKS_MOVE_RECOVERY'
        ? { code: 'move_recovery' }
        : {}),
  });
  void shutdown();
});
