import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const Identity = z.strictObject({
  machineId: z.uuid(),
  signingPublicKey: z.string().min(1).max(1024),
  agreementPublicKey: z.string().min(1).max(1024),
});
const Origin = z
  .string()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        url.pathname === '/' &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, 'Use an HTTPS target address.')
  .transform((value) => new URL(value).origin);
const Proposal = z.strictObject({ id: z.uuid(), target: Identity, targetOrigin: Origin });
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Payload = z.strictObject({
  version: z.literal(1),
  move: Proposal,
  workspaceId: z.uuid(),
  generation: z.number().int().positive(),
  source: Identity,
  digest: Digest,
});
const Grant = z.strictObject({ payload: Payload, signature: z.string().min(1).max(1024) });
const State = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('client') }),
  z.strictObject({
    kind: z.literal('active'),
    workspaceId: z.uuid(),
    generation: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal('preparing'),
    workspaceId: z.uuid(),
    generation: z.number().int().positive(),
    move: Proposal,
  }),
  z.strictObject({
    kind: z.literal('fenced'),
    workspaceId: z.uuid(),
    generation: z.number().int().positive(),
    move: Proposal,
    digest: Digest,
  }),
  z.strictObject({ kind: z.literal('staged'), grant: Grant }),
]);
const Journal = z.strictObject({
  version: z.literal(1),
  identity: Identity,
  signingPrivateKey: z.string().min(1).max(1024),
  agreementPrivateKey: z.string().min(1).max(1024),
  state: State,
});
type Journal = z.infer<typeof Journal>;
type Proposal = z.input<typeof Proposal>;
type Grant = z.infer<typeof Grant>;

function keyPair(type: 'ed25519' | 'x25519') {
  const pair = type === 'ed25519' ? generateKeyPairSync('ed25519') : generateKeyPairSync('x25519');
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
function verifyIdentity(identity: z.infer<typeof Identity>) {
  if (
    createPublicKey(identity.signingPublicKey).asymmetricKeyType !== 'ed25519' ||
    createPublicKey(identity.agreementPublicKey).asymmetricKeyType !== 'x25519'
  )
    throw new Error('Invalid computer identity.');
}
function signedBytes(payload: z.infer<typeof Payload>) {
  const { move, source } = payload;
  return Buffer.from(
    JSON.stringify([
      payload.version,
      move.id,
      payload.workspaceId,
      payload.generation,
      source.machineId,
      source.signingPublicKey,
      source.agreementPublicKey,
      move.target.machineId,
      move.target.signingPublicKey,
      move.target.agreementPublicKey,
      move.targetOrigin,
      payload.digest,
    ]),
  );
}

export class WorkspaceOwnership {
  private constructor(private readonly path: string) {}

  static open(directory: string, initial: 'server' | 'client') {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'ownership.sqlite');
    let created = false;
    try {
      closeSync(openSync(path, 'wx', 0o600));
      created = true;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    const ownership = new WorkspaceOwnership(path);
    const db = ownership.database();
    try {
      if (created) {
        const signing = keyPair('ed25519');
        const agreement = keyPair('x25519');
        const journal: Journal = {
          version: 1,
          identity: {
            machineId: randomUUID(),
            signingPublicKey: signing.publicKey,
            agreementPublicKey: agreement.publicKey,
          },
          signingPrivateKey: signing.privateKey,
          agreementPrivateKey: agreement.privateKey,
          state:
            initial === 'server'
              ? { kind: 'active', workspaceId: randomUUID(), generation: 1 }
              : { kind: 'client' },
        };
        db.exec('CREATE TABLE journal (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
        db.prepare('INSERT INTO journal VALUES(1, ?)').run(JSON.stringify(journal));
      }
      ownership.read(db);
    } finally {
      db.close();
    }
    return ownership;
  }

  private database() {
    const db = new DatabaseSync(this.path);
    chmodSync(this.path, 0o600);
    db.exec('PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE');
    return db;
  }

  private read(db: DatabaseSync): Journal {
    const row = z
      .object({ value: z.string() })
      .parse(db.prepare('SELECT value FROM journal WHERE id=1').get());
    const journal = Journal.parse(JSON.parse(row.value));
    verifyIdentity(journal.identity);
    return journal;
  }

  private change<T>(fn: (journal: Journal) => T): T {
    const db = this.database();
    try {
      db.exec('BEGIN IMMEDIATE');
      const journal = this.read(db);
      const result = fn(journal);
      db.prepare('UPDATE journal SET value=? WHERE id=1').run(
        JSON.stringify(Journal.parse(journal)),
      );
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* No transaction was started. */
      }
      throw error;
    } finally {
      db.close();
    }
  }

  identity() {
    const db = this.database();
    try {
      return this.read(db).identity;
    } finally {
      db.close();
    }
  }

  assertCanRun() {
    const db = this.database();
    try {
      if (this.read(db).state.kind !== 'active') {
        const error = new Error('This workspace cannot start while a server move needs recovery.');
        Object.assign(error, { code: 'CHAT2TASKS_MOVE_RECOVERY' });
        throw error;
      }
    } finally {
      db.close();
    }
  }

  prepare(input: Proposal) {
    const move = Proposal.parse(input);
    verifyIdentity(move.target);
    return this.change((journal) => {
      const state = journal.state;
      if (state.kind === 'preparing' && JSON.stringify(state.move) === JSON.stringify(move)) return;
      if (state.kind !== 'active') throw new Error('A server move is already in progress.');
      if (move.target.machineId === journal.identity.machineId)
        throw new Error('Choose another target computer.');
      journal.state = {
        kind: 'preparing',
        workspaceId: state.workspaceId,
        generation: state.generation,
        move,
      };
    });
  }

  fence(moveId: string, input: string): Grant {
    const digest = Digest.parse(input);
    return this.change((journal) => {
      const state = journal.state;
      if (state.kind !== 'preparing' && state.kind !== 'fenced')
        throw new Error('No matching server move is in progress.');
      if (state.move.id !== moveId) throw new Error('This server move does not match.');
      if (state.kind === 'fenced' && state.digest !== digest)
        throw new Error('The snapshot does not match this move.');
      journal.state = {
        kind: 'fenced',
        workspaceId: state.workspaceId,
        generation: state.generation,
        move: state.move,
        digest,
      };
      const payload: z.infer<typeof Payload> = {
        version: 1,
        move: state.move,
        workspaceId: state.workspaceId,
        generation: state.generation + 1,
        source: journal.identity,
        digest,
      };
      return {
        payload,
        signature: sign(null, signedBytes(payload), journal.signingPrivateKey).toString(
          'base64url',
        ),
      };
    });
  }

  async stage(input: unknown, trustedSourceKey: string, snapshotPath: string) {
    const grant = Grant.parse(input);
    verifyIdentity(grant.payload.source);
    if (
      grant.payload.source.signingPublicKey !== trustedSourceKey ||
      !verify(
        null,
        signedBytes(grant.payload),
        trustedSourceKey,
        Buffer.from(grant.signature, 'base64url'),
      )
    )
      throw new Error('The server move authorization is invalid.');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(snapshotPath)) {
      if (!(chunk instanceof Uint8Array)) throw new Error('The snapshot could not be read.');
      hash.update(chunk);
    }
    if (hash.digest('hex') !== grant.payload.digest)
      throw new Error('The snapshot does not match this move.');
    this.change((journal) => {
      if (JSON.stringify(journal.identity) !== JSON.stringify(grant.payload.move.target))
        throw new Error('This move is for a different target computer.');
      if (
        journal.state.kind === 'staged' &&
        JSON.stringify(journal.state.grant) === JSON.stringify(grant)
      )
        return;
      if (journal.state.kind !== 'client')
        throw new Error('This computer already has a workspace.');
      journal.state = { kind: 'staged', grant };
    });
  }
}
