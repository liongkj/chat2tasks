const { access, readFile } = require('node:fs/promises');
const { join } = require('node:path');

module.exports = async function verifyResources(context) {
  const resources = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Resources',
  );
  const codexPackage = process.arch === 'arm64' ? 'codex-darwin-arm64' : 'codex-darwin-x64';
  const browser = (await readFile(join(resources, 'gateway', 'browser-path.txt'), 'utf8')).trim();
  const required = [
    'node/node',
    'runtime/dist/server/index.js',
    'runtime/node_modules/fastify/package.json',
    `runtime/node_modules/@openai/${codexPackage}/package.json`,
    'gateway/dist/main.js',
    'gateway/node_modules/@nestjs/common/package.json',
    join('gateway', browser),
  ];
  for (const path of required) {
    try {
      await access(join(resources, path));
    } catch {
      throw new Error(`Mac app is missing ${path}; check the bundled runtime configuration.`);
    }
  }
};
