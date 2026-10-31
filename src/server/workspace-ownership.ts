import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
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
export const MoveProposalSchema = Proposal;
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const SealedPassphrase = z.strictObject({
  ephemeralPublicKey: z.string().min(1).max(1024),
  nonce: z.string().min(1).max(64),
  ciphertext: z.string().min(1).max(2048),
  tag: z.string().min(1).max(64),
});
const Payload = z.strictObject({
  version: z.literal(1),
  move: Proposal,
  workspaceId: z.uuid(),
  generation: z.number().int().positive(),
  source: Identity,
  digest: Digest,
  sealedPassphrase: SealedPassphrase,
});
const Grant = z.strictObject({ payload: Payload, signature: z.string().min(1).max(1024) });
export type MoveGrant = z.infer<typeof Grant>;
const MoveMarker = z.strictObject({
  moveId: z.uuid(),
  workspaceId: z.uuid(),
  generation: z.number().int().positive(),
  digest: Digest,
  targetMachineId: z.uuid(),
});
const State = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('client') }),
  z.strictObject({
    kind: z.literal('active'),
    workspaceId: z.uuid(),
    generation: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal('active_moved'),
    workspaceId: z.uuid(),
    generation: z.number().int().positive(),
    grant: Grant,
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
    sealedPassphrase: SealedPassphrase,
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

export function moveMarker(grant: MoveGrant) {
  return MoveMarker.parse({
    moveId: grant.payload.move.id,
    workspaceId: grant.payload.workspaceId,
    generation: grant.payload.generation,
    digest: grant.payload.digest,
    targetMachineId: grant.payload.move.target.machineId,
  });
}

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
  const { move, source, sealedPassphrase } = payload;
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
      sealedPassphrase.ephemeralPublicKey,
      sealedPassphrase.nonce,
      sealedPassphrase.ciphertext,
      sealedPassphrase.tag,
    ]),
  );
}
function activationBytes(grant: MoveGrant) {
  return Buffer.from(
    JSON.stringify([
      'chat2tasks-move-activation-v1',
      grant.payload.move.id,
      grant.payload.workspaceId,
      grant.payload.generation,
      grant.payload.digest,
      grant.payload.move.targetOrigin,
    ]),
  );
}
function wrappingKey(privateKey: string, publicKey: string, moveId: string) {
  const secret = diffieHellman({
    privateKey: createPrivateKey(privateKey),
    publicKey: createPublicKey(publicKey),
  });
  return Buffer.from(
    hkdfSync('sha256', secret, Buffer.from(moveId), Buffer.from('chat2tasks-move-key-v1'), 32),
  );
}
function sealPassphrase(target: z.infer<typeof Identity>, moveId: string, passphrase: string) {
  const ephemeral = keyPair('x25519');
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    wrappingKey(ephemeral.privateKey, target.agreementPublicKey, moveId),
    nonce,
  );
  cipher.setAAD(Buffer.from(moveId));
  const ciphertext = Buffer.concat([cipher.update(passphrase, 'utf8'), cipher.final()]);
  return {
    ephemeralPublicKey: ephemeral.publicKey,
    nonce: nonce.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  };
}
function openPassphrase(
  privateKey: string,
  moveId: string,
  sealed: z.infer<typeof SealedPassphrase>,
) {
  try {
    const nonce = Buffer.from(sealed.nonce, 'base64url');
    const tag = Buffer.from(sealed.tag, 'base64url');
    if (nonce.length !== 12 || tag.length !== 16) throw new Error('Invalid move envelope.');
    const cipher = createDecipheriv(
      'aes-256-gcm',
      wrappingKey(privateKey, sealed.ephemeralPublicKey, moveId),
      nonce,
    );
    cipher.setAAD(Buffer.from(moveId));
    cipher.setAuthTag(tag);
    return Buffer.concat([
      cipher.update(Buffer.from(sealed.ciphertext, 'base64url')),
      cipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('The snapshot cannot be unlocked on this target computer.');
  }
}

export async function snapshotDigest(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    if (!(chunk instanceof Uint8Array)) throw new Error('The snapshot could not be read.');
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export function verifyMoveGrant(input: unknown, trustedSourceKey: string) {
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
  return grant;
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
    if (journal.state.kind === 'staged' || journal.state.kind === 'active_moved') {
      const grant = verifyMoveGrant(
        journal.state.grant,
        journal.state.grant.payload.source.signingPublicKey,
      );
      if (
        JSON.stringify(journal.identity) !== JSON.stringify(grant.payload.move.target) ||
        (journal.state.kind === 'active_moved' &&
          (journal.state.workspaceId !== grant.payload.workspaceId ||
            journal.state.generation !== grant.payload.generation))
      )
        throw new Error('The workspace ownership record is invalid.');
    }
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

  role() {
    const db = this.database();
    try {
      return this.read(db).state.kind;
    } finally {
      db.close();
    }
  }

  move(
    moveId: string,
  ):
    | { kind: 'preparing'; proposal: z.infer<typeof Proposal> }
    | { kind: 'fenced'; proposal: z.infer<typeof Proposal>; grant: MoveGrant } {
    const db = this.database();
    try {
      const journal = this.read(db);
      const state = journal.state;
      if ((state.kind !== 'preparing' && state.kind !== 'fenced') || state.move.id !== moveId)
        throw new Error('No matching server move was found.');
      return state.kind === 'preparing'
        ? { kind: 'preparing', proposal: state.move }
        : { kind: 'fenced', proposal: state.move, grant: this.signedGrant(journal, moveId) };
    } finally {
      db.close();
    }
  }

  assertCanRun() {
    const db = this.database();
    try {
      const state = this.read(db).state;
      if (state.kind !== 'active' && state.kind !== 'active_moved') {
        const error = new Error('This workspace cannot start while a server move needs recovery.');
        Object.assign(error, { code: 'CHAT2TASKS_MOVE_RECOVERY' });
        throw error;
      }
    } finally {
      db.close();
    }
  }

  matchesMove(moveId: string) {
    const db = this.database();
    try {
      const state = this.read(db).state;
      return (
        (state.kind === 'staged' && state.grant.payload.move.id === moveId) ||
        (state.kind === 'active_moved' && state.grant.payload.move.id === moveId)
      );
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
      if (state.kind !== 'active' && state.kind !== 'active_moved')
        throw new Error('A server move is already in progress.');
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

  private signedGrant(journal: Journal, moveId: string): Grant {
    const state = journal.state;
    if (state.kind !== 'fenced' || state.move.id !== moveId)
      throw new Error('No completed authorization exists for this move.');
    const payload: z.infer<typeof Payload> = {
      version: 1,
      move: state.move,
      workspaceId: state.workspaceId,
      generation: state.generation + 1,
      source: journal.identity,
      digest: state.digest,
      sealedPassphrase: state.sealedPassphrase,
    };
    return {
      payload,
      signature: sign(null, signedBytes(payload), journal.signingPrivateKey).toString('base64url'),
    };
  }

  grant(moveId: string) {
    const db = this.database();
    try {
      return this.signedGrant(this.read(db), moveId);
    } finally {
      db.close();
    }
  }

  fence(moveId: string, input: string, rawPassphrase: string): Grant {
    const digest = Digest.parse(input);
    const passphrase = z.string().min(8).max(1024).parse(rawPassphrase);
    return this.change((journal) => {
      const state = journal.state;
      if (state.kind !== 'preparing' && state.kind !== 'fenced')
        throw new Error('No matching server move is in progress.');
      if (state.move.id !== moveId) throw new Error('This server move does not match.');
      if (state.kind === 'fenced' && state.digest !== digest)
        throw new Error('The snapshot does not match this move.');
      const sealedPassphrase =
        state.kind === 'fenced'
          ? state.sealedPassphrase
          : sealPassphrase(state.move.target, state.move.id, passphrase);
      journal.state = {
        kind: 'fenced',
        workspaceId: state.workspaceId,
        generation: state.generation,
        move: state.move,
        digest,
        sealedPassphrase,
      };
      return this.signedGrant(journal, moveId);
    });
  }

  async stage(input: unknown, trustedSourceKey: string, snapshotPath: string) {
    const grant = verifyMoveGrant(input, trustedSourceKey);
    if ((await snapshotDigest(snapshotPath)) !== grant.payload.digest)
      throw new Error('The snapshot does not match this move.');
    return this.change((journal) => {
      if (JSON.stringify(journal.identity) !== JSON.stringify(grant.payload.move.target))
        throw new Error('This move is for a different target computer.');
      const passphrase = openPassphrase(
        journal.agreementPrivateKey,
        grant.payload.move.id,
        grant.payload.sealedPassphrase,
      );
      if (
        journal.state.kind === 'staged' &&
        JSON.stringify(journal.state.grant) === JSON.stringify(grant)
      )
        return passphrase;
      if (journal.state.kind !== 'client')
        throw new Error('This computer already has a workspace.');
      journal.state = { kind: 'staged', grant };
      return passphrase;
    });
  }

  activate({ workspace, grant }: { workspace: string; grant: MoveGrant }) {
    if (resolve(this.path) !== resolve(join(workspace, '.ownership', 'ownership.sqlite')))
      throw new Error('The moved workspace has not been promoted.');
    const database = join(workspace, 'tasks.sqlite');
    if (!existsSync(database)) throw new Error('The moved workspace database is missing.');
    // Bun needs a writable handle to open a WAL database when its shared memory files are absent.
    const db = new DatabaseSync(database);
    try {
      const row = z
        .object({ value: z.string() })
        .parse(db.prepare("SELECT value FROM meta WHERE key='move_activation'").get());
      const marker = MoveMarker.parse(JSON.parse(row.value));
      if (JSON.stringify(marker) !== JSON.stringify(moveMarker(grant)))
        throw new Error('The promoted workspace does not match the server move.');
    } finally {
      db.close();
    }
    this.change((journal) => {
      const state = journal.state;
      if (state.kind === 'active_moved' && JSON.stringify(state.grant) === JSON.stringify(grant))
        return;
      if (state.kind !== 'staged' || JSON.stringify(state.grant) !== JSON.stringify(grant))
        throw new Error('This workspace is not staged for that move.');
      journal.state = {
        kind: 'active_moved',
        workspaceId: grant.payload.workspaceId,
        generation: grant.payload.generation,
        grant,
      };
    });
  }

  activationAck(grant: MoveGrant) {
    const db = this.database();
    try {
      const journal = this.read(db);
      if (
        journal.state.kind !== 'active_moved' ||
        JSON.stringify(journal.state.grant) !== JSON.stringify(grant)
      )
        throw new Error('The target workspace is not active for this move.');
      return sign(null, activationBytes(grant), journal.signingPrivateKey).toString('base64url');
    } finally {
      db.close();
    }
  }

  completedMove(moveId: string) {
    const db = this.database();
    try {
      const journal = this.read(db);
      if (journal.state.kind !== 'active_moved' || journal.state.grant.payload.move.id !== moveId)
        return null;
      return {
        grant: journal.state.grant,
        acknowledgement: sign(
          null,
          activationBytes(journal.state.grant),
          journal.signingPrivateKey,
        ).toString('base64url'),
      };
    } finally {
      db.close();
    }
  }

  verifyActivation(moveId: string, signature: string) {
    const grant = this.grant(moveId);
    let valid = false;
    try {
      valid = verify(
        null,
        activationBytes(grant),
        grant.payload.move.target.signingPublicKey,
        Buffer.from(signature, 'base64url'),
      );
    } catch {
      /* Invalid signatures do not authorize a move. */
    }
    if (!valid) throw new Error('The target activation authorization is invalid.');
    return grant.payload.move.targetOrigin;
  }
}
