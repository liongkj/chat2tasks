const { access, rename } = require('node:fs/promises');

async function replaceWorkspace({
  workspace,
  source,
  passphrase,
  stopServer,
  startServer,
  runImport,
  onError,
}) {
  await stopServer();
  const previous = `${workspace}.before-import-${Date.now()}`;
  try {
    await rename(workspace, previous);
    const imported = await runImport(source, workspace, passphrase);
    if (!imported) {
      await rename(previous, workspace);
      await startServer();
      return { ok: false, error: 'Could not open that file. Check the passphrase and try again.' };
    }
    await startServer();
    return { ok: true };
  } catch (error) {
    onError?.(error);
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
}

module.exports = { replaceWorkspace };
