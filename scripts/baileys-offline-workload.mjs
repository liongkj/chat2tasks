import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const source = process.env.CHAT2TASKS_OPENWA_SOURCE;
if (!source) throw new Error('Set CHAT2TASKS_OPENWA_SOURCE to the prepared OpenWA source.');
const require = createRequire(join(resolve(source), 'package.json'));
process.env.MEDIA_DOWNLOAD_ENABLED = 'false';
const lib = await import(require.resolve('@whiskeysockets/baileys'));
const { BaileysEvents } = require('./dist/engine/adapters/baileys-events.js');
const { ConcurrencyLimiter } = require('./dist/common/utils/concurrency-limiter.js');
const count = 1000;
const noop = () => undefined;
let received = 0;
let finish;
const completed = new Promise((resolveCompleted) => {
  finish = resolveCompleted;
});
const events = new BaileysEvents({
  getSocket: () => ({ updateMediaMessage: noop }),
  getSocketOrNull: () => null,
  logger: { log: noop, debug: noop, verbose: noop, warn: noop, error: noop },
  toNeutralJid: (jid) => jid.replace('@s.whatsapp.net', '@c.us'),
  normalizedSelfJid: () => '10000000000@s.whatsapp.net',
  loadLib: () => Promise.resolve(lib),
  getFetchDispatcher: () => undefined,
  inboundLimiter: new ConcurrencyLimiter(2),
  recordKeyLidMappings: noop,
  recordMessage: noop,
  recordMessageEdit: noop,
  putStoredMessage: noop,
  updateStoredMessage: noop,
  consumeOwnSend: () => false,
  getStoredMessage: noop,
  getOnMessage: () => () => {
    received++;
    if (received === count) finish();
  },
  getOnMessageCreate: () => noop,
  getOnMessageRevoked: () => noop,
  getOnMessageEdited: () => noop,
  getOnMessageReaction: () => noop,
  getOnMessageAck: noop,
  getOnGroupEvent: () => noop,
  getOnCall: noop,
  getOnPresenceUpdate: noop,
  getOnCallOutcome: noop,
});
const messages = Array.from({ length: count }, (_, index) =>
  lib.proto.WebMessageInfo.fromObject({
    messageTimestamp: 1_700_000_000,
    key: { id: `sample-${index}`, remoteJid: '10000000001@s.whatsapp.net', fromMe: false },
    message: { conversation: `Synthetic message ${index}` },
  }),
);
events.handleMessagesUpsert({ messages, type: 'notify' });
let timer;
try {
  await Promise.race([
    completed,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Synthetic processing timed out.')), 15000);
    }),
  ]);
} finally {
  clearTimeout(timer);
}
globalThis.chat2tasksOfflineStudy = { events };
process.stderr.write(`Processed ${received} synthetic messages offline.\n`);
