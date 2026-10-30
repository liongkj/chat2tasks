const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function workspaceGatewayLaunch(workspace) {
  const path = join(workspace, 'tasks.sqlite');
  if (!existsSync(path)) return { mode: 'local', resumeSessions: false };
  // Bun needs a writable SQLite handle to open a WAL database without existing shared memory files.
  const db = new DatabaseSync(path);
  try {
    if (
      !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_settings'").get()
    )
      return { mode: 'local', resumeSessions: false };
    const row = db.prepare('SELECT payload FROM app_settings WHERE id=1').get();
    const mode = row ? JSON.parse(row.payload).desktopGateway?.mode : undefined;
    const metaExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
      .get();
    const setup = metaExists
      ? db.prepare("SELECT value FROM meta WHERE key='desktop_setup_complete'").get()
      : undefined;
    return {
      mode: mode === 'remote' ? 'remote' : 'local',
      resumeSessions: setup?.value === 'true',
    };
  } finally {
    db.close();
  }
}
module.exports = { workspaceGatewayLaunch };
