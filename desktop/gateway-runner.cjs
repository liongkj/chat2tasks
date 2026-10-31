const { acquireLock } = require('./process-lock.mjs');

const lock = acquireLock(process.cwd());
process.once('exit', () => lock.close());
require(process.argv[2]);
