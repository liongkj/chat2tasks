import { importWorkspace } from './workspace-transfer.js';

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('A transfer file and destination are required.');
let passphrase = '';
for await (const chunk of process.stdin) {
  passphrase += chunk.toString();
  if (passphrase.length > 1024) throw new Error('Passphrase is too long.');
}
await importWorkspace(source, destination, passphrase);
