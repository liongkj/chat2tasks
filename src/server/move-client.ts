import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { z } from 'zod';
import { DesktopSharingUpdateSchema } from '../shared/desktop-sharing.js';
import { DestinationMove } from './destination-move.js';
import { MoveProposalSchema } from './workspace-ownership.js';

const SourceOrigin = z
  .url()
  .refine((value) => {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return (
      (url.protocol === 'https:' || (url.protocol === 'http:' && local)) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    );
  }, 'Use the current server’s HTTPS address.')
  .transform((value) => new URL(value).origin);
const Input = z.strictObject({
  sourceOrigin: SourceOrigin,
  sourcePassword: z.string().min(1).max(1024),
  targetOrigin: z.url(),
  localPort: z.number().int(),
  targetPassword: z.string(),
});
const Common = {
  version: z.literal(1),
  id: z.uuid(),
  sourceOrigin: SourceOrigin,
  targetOrigin: z.url(),
  localPort: z.number().int(),
  target: MoveProposalSchema.shape.target,
  sourceSigningPublicKey: z.string().min(1).max(1024),
};
const Pending = z.discriminatedUnion('kind', [
  z.strictObject({ ...Common, kind: z.literal('preparing') }),
  z.strictObject({
    ...Common,
    kind: z.literal('activated'),
    acknowledgement: z.string().min(1).max(1024),
  }),
]);
type Pending = z.infer<typeof Pending>;
const MoveStatus = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('preparing') }),
  z.object({ kind: z.literal('needs_retry') }),
  z.object({ kind: z.literal('recovery_required') }),
  z.object({ kind: z.literal('ready'), grant: z.unknown() }),
]);

async function checkPort(port: number) {
  await new Promise<void>((resolve, reject) => {
    const socket = createServer();
    socket.once('error', () => reject(new Error('Choose a local server port that is not in use.')));
    socket.listen(port, '127.0.0.1', () => socket.close(() => resolve()));
  });
}

async function persist(path: string, state: Pending) {
  const temporary = path + '.tmp';
  const file = await open(temporary, 'w', 0o600);
  try {
    await file.writeFile(JSON.stringify(state));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}

async function run() {
  const input = Input.parse(JSON.parse(readFileSync(0, 'utf8')));
  const sharing = DesktopSharingUpdateSchema.parse({
    kind: 'enabled',
    origin: input.targetOrigin,
    port: input.localPort,
    password: input.targetPassword,
  });
  if (sharing.kind !== 'enabled') throw new Error('Check the destination settings.');
  if (input.sourceOrigin === sharing.origin)
    throw new Error('The new server address must differ from the current server address.');
  const data = process.env.C2T_TAURI_DATA;
  if (!data) throw new Error('The desktop workspace is unavailable.');
  await mkdir(data, { recursive: true, mode: 0o700 });
  const pendingPath = join(data, 'server-move-pending.json');
  const destination = new DestinationMove(data);
  const authorization = 'Basic ' + Buffer.from('admin:' + input.sourcePassword).toString('base64');
  async function call(path: string, body?: unknown, timeout = 15000) {
    const response = await fetch(input.sourceOrigin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: authorization,
        Origin: input.sourceOrigin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      const payload = z
        .object({ error: z.string().max(240) })
        .safeParse(await response.json().catch(() => null));
      throw new Error(
        payload.success ? payload.data.error : 'Could not contact the current server.',
      );
    }
    return response;
  }
  let pending: Pending;
  if (existsSync(pendingPath)) {
    pending = Pending.parse(JSON.parse(await readFile(pendingPath, 'utf8')));
    if (
      pending.sourceOrigin !== input.sourceOrigin ||
      pending.targetOrigin !== sharing.origin ||
      pending.localPort !== sharing.port
    )
      throw new Error(
        'A move is already in progress. Use the same server addresses and local port to retry.',
      );
  } else {
    const identity = MoveProposalSchema.shape.target.parse(
      await (await call('/api/workspace/move/identity')).json(),
    );
    const id = randomUUID();
    const target = await destination.prepare(id);
    pending = {
      version: 1,
      kind: 'preparing',
      id,
      target,
      sourceOrigin: input.sourceOrigin,
      targetOrigin: sharing.origin,
      localPort: sharing.port,
      sourceSigningPublicKey: identity.signingPublicKey,
    };
    await persist(pendingPath, pending);
  }
  const path = (suffix: string) => `/api/workspace/move/${pending.id}${suffix}`;
  if (pending.kind === 'preparing') {
    const acknowledgement = await destination.recoverCompleted(pending.id);
    if (acknowledgement) {
      pending = { ...pending, kind: 'activated', acknowledgement };
      await persist(pendingPath, pending);
    }
  }
  if (pending.kind === 'preparing') {
    destination.checkAvailable();
    await checkPort(sharing.port);
    const proposal = { id: pending.id, target: pending.target, targetOrigin: pending.targetOrigin };
    const start = z
      .object({ source: MoveProposalSchema.shape.target })
      .parse(await (await call('/api/workspace/move/start', proposal)).json());
    if (start.source.signingPublicKey !== pending.sourceSigningPublicKey)
      throw new Error('The current server identity changed. The move needs recovery.');
    let ready: z.infer<typeof MoveStatus> | undefined;
    for (let attempt = 0; attempt < 1200; attempt++) {
      ready = MoveStatus.parse(await (await call(path(''))).json());
      if (ready.kind === 'ready') break;
      if (ready.kind === 'recovery_required')
        throw new Error('The old server needs move recovery.');
      if (ready.kind === 'needs_retry') await call('/api/workspace/move/start', proposal);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!ready || ready.kind !== 'ready')
      throw new Error('The move is still running. Retry this screen later.');
    const directory = join(data, 'server-moves', pending.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const archivePath = join(directory, 'download.c2t');
    const response = await call(path('/archive'), undefined, 30 * 60 * 1000);
    if (!response.body) throw new Error('The move snapshot could not be downloaded.');
    const file = await open(archivePath, 'w', 0o600);
    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        let offset = 0;
        while (offset < value.length) {
          const { bytesWritten } = await file.write(value, offset, value.length - offset);
          if (bytesWritten === 0) throw new Error('The move snapshot could not be saved.');
          offset += bytesWritten;
        }
      }
      await file.sync();
    } finally {
      await file.close();
    }
    const acknowledgement = await destination.receive({
      grant: ready.grant,
      trustedSourceKey: pending.sourceSigningPublicKey,
      archivePath,
      localPort: sharing.port,
      password: sharing.password,
    });
    pending = { ...pending, kind: 'activated', acknowledgement };
    await persist(pendingPath, pending);
  }
  try {
    await call(path('/complete'), { acknowledgement: pending.acknowledgement });
  } catch {
    return { ok: true, kind: 'ack_pending' };
  }
  await rm(pendingPath, { force: true });
  await rm(join(data, 'server-moves', pending.id, 'download.c2t'), { force: true });
  return { ok: true, kind: 'complete' };
}

try {
  process.stdout.write(JSON.stringify(await run()) + '\n');
} catch (error) {
  const message =
    error instanceof z.ZodError
      ? 'Check the server addresses, port, and passwords.'
      : error instanceof Error
        ? error.message
        : 'The move could not be completed.';
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + '\n');
}
