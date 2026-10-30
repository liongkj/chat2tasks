const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } = require('electron');
const { spawn } = require('node:child_process');
const { access, mkdir, readFile, rename } = require('node:fs/promises');
const { createServer } = require('node:net');
const { join } = require('node:path');

app.setName('Chat2Tasks');
if (process.env.CHAT2TASKS_DATA_DIR) app.setPath('userData', process.env.CHAT2TASKS_DATA_DIR);
else if (!app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'Chat2Tasks Dev'));

let window, tray, gateway, server, gatewayPort, serverPort, selectedImport;
let quitting = false;
const resources = app.isPackaged ? process.resourcesPath : process.cwd();
const runtime = app.isPackaged ? join(resources, 'runtime') : process.cwd();
const gatewayRuntime = app.isPackaged
  ? join(resources, 'gateway')
  : process.env.CHAT2TASKS_GATEWAY_DIR || join(process.cwd(), 'work', 'openwa');
const node = app.isPackaged ? join(resources, 'node', 'node') : process.env.CHAT2TASKS_NODE;
const data = app.getPath('userData');
const workspace = join(data, 'workspace');
const gatewayData = join(data, 'gateway');
const codexHome = join(data, 'codex');
const codexArch = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
const codexPackage = process.arch === 'arm64' ? 'codex-darwin-arm64' : 'codex-darwin-x64';
const codex = join(
  runtime,
  'node_modules',
  '@openai',
  codexPackage,
  'vendor',
  codexArch,
  'bin',
  'codex',
);

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
function freePort() {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      if (!address || typeof address === 'string')
        return reject(new Error('Could not choose a local port.'));
      const port = address.port;
      socket.close(() => resolve(port));
    });
  });
}
async function ready(port, child) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error('A local service stopped during startup.');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      /* Wait for the app-owned service. */
    }
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
  let browser = process.env.CHAT2TASKS_CHROME;
  if (app.isPackaged)
    browser = (await readFile(join(gatewayRuntime, 'browser-path.txt'), 'utf8')).trim();
  if (app.isPackaged) browser = join(gatewayRuntime, browser);
  if (!browser) browser = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  await access(browser);
  gateway = spawn(node, [join(gatewayRuntime, 'dist', 'main.js')], {
    cwd: gatewayData,
    stdio: 'ignore',
    env: {
      ...cleanEnv(),
      NODE_ENV: 'production',
      PORT: String(gatewayPort),
      LOG_LEVEL: 'error',
      UPDATE_CHECK_ENABLED: 'false',
      AUTO_START_SESSIONS: 'true',
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
  server = spawn(node, [join(runtime, 'dist', 'server', 'index.js')], {
    cwd: runtime,
    stdio: 'ignore',
    env: {
      ...cleanEnv(),
      NODE_ENV: 'production',
      CHAT2TASKS_DESKTOP: 'true',
      PORT: String(serverPort),
      BIND_HOST: '127.0.0.1',
      PUBLIC_ORIGIN: origin,
      DATA_DIR: workspace,
      CODEX_HOME: codexHome,
      CODEX_BIN: codex,
      DESKTOP_OPENWA_URL: `http://127.0.0.1:${gatewayPort}`,
      DESKTOP_OPENWA_KEY_FILE: join(gatewayData, 'data', '.api-key'),
    },
  });
  await ready(serverPort, server);
}
async function runImport(source, passphrase) {
  return new Promise((resolve) => {
    const child = spawn(
      node,
      [join(runtime, 'dist', 'desktop', 'transfer-cli.js'), source, workspace],
      {
        cwd: runtime,
        env: cleanEnv(),
        stdio: ['pipe', 'ignore', 'ignore'],
      },
    );
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
    child.stdin.end(passphrase);
  });
}
ipcMain.handle('auth:open', async (_event, value) => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname))
    throw new Error('Unexpected sign-in address.');
  await shell.openExternal(url.toString());
});
ipcMain.handle('workspace:choose-import', async () => {
  const choice = await dialog.showOpenDialog(window, {
    properties: ['openFile'],
    filters: [{ name: 'Chat2Tasks workspace', extensions: ['c2t'] }],
  });
  selectedImport = choice.canceled ? undefined : choice.filePaths[0];
  return Boolean(selectedImport);
});
ipcMain.handle('workspace:import', async (_event, passphrase) => {
  if (
    !selectedImport ||
    typeof passphrase !== 'string' ||
    passphrase.length < 8 ||
    passphrase.length > 1024
  )
    return { ok: false, error: 'Choose a transfer file and enter its passphrase.' };
  await stop(server);
  const previous = `${workspace}.before-import-${Date.now()}`;
  try {
    await rename(workspace, previous);
    const imported = await runImport(selectedImport, passphrase);
    if (!imported) {
      await rename(previous, workspace);
      await startServer();
      return { ok: false, error: 'Could not open that file. Check the passphrase and try again.' };
    }
    await startServer();
    selectedImport = undefined;
    return { ok: true };
  } catch {
    try {
      await access(workspace);
    } catch {
      await rename(previous, workspace).catch(() => undefined);
    }
    await startServer().catch(() => undefined);
    return {
      ok: false,
      error: 'Could not import the workspace. Your previous copy is still saved.',
    };
  }
});

app.whenReady().then(async () => {
  window = new BrowserWindow({
    width: 1140,
    height: 800,
    minWidth: 680,
    minHeight: 580,
    title: 'Chat2Tasks',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadFile(join(__dirname, 'loading.html'));
  window.on('close', (event) => {
    if (!quitting && tray) {
      event.preventDefault();
      window.hide();
    }
  });
  const icon = nativeImage.createFromNamedImage('NSStatusAvailable');
  if (!icon.isEmpty()) {
    tray = new Tray(icon);
    tray.setToolTip('Chat2Tasks');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Chat2Tasks', click: () => window.show() },
        {
          label: 'Quit Chat2Tasks',
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
    tray.on('click', () => window.show());
  }
  app.on('activate', () => window.show());
  try {
    if (!node || process.platform !== 'darwin') throw new Error('A Mac runtime is required.');
    gatewayPort = await freePort();
    do {
      serverPort = await freePort();
    } while (serverPort === gatewayPort);
    await startGateway();
    await startServer();
    const origin = `http://127.0.0.1:${serverPort}`;
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void shell.openExternal(url);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(origin + '/')) event.preventDefault();
    });
    await window.loadURL(origin);
  } catch {
    await window.loadFile(join(__dirname, 'loading.html'), { query: { error: '1' } });
  }
});
app.on('before-quit', (event) => {
  if (quitting && !server && !gateway) return;
  event.preventDefault();
  quitting = true;
  Promise.all([stop(server), stop(gateway)]).finally(() => {
    server = undefined;
    gateway = undefined;
    app.quit();
  });
});
app.on('window-all-closed', () => {
  if (!tray) app.quit();
});
