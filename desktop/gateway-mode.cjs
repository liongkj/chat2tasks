const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function workspaceGatewayMode(workspace) {
  const path = join(workspace, 'tasks.sqlite');
  if (!existsSync(path)) return 'local';
  // Bun needs a writable SQLite handle to open a WAL database without existing shared memory files.
  const db = new DatabaseSync(path);
  try {
    if (
      !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_settings'").get()
    )
      return 'local';
    const row = db.prepare('SELECT payload FROM app_settings WHERE id=1').get();
    const mode = row ? JSON.parse(row.payload).desktopGateway?.mode : undefined;
    return mode === 'remote' ? 'remote' : 'local';
  } finally {
    db.close();
  }
}
module.exports = { workspaceGatewayMode };
