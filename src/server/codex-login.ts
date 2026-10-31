import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { z } from 'zod';
import { UserError } from './errors.js';

const execute = promisify(execFile);

function environment() {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.OPENAI_BASE_URL;
  return env;
}

/** Runs Codex's own browser sign-in and never reads its credential file. */
export class CodexLogin {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private nextId = 1;
  private authUrl: string | null = null;
  private failure = false;

  async status() {
    try {
      await execute(process.env.CODEX_BIN ?? 'codex', ['login', 'status'], {
        env: environment(),
        timeout: 10000,
      });
      return { installed: true, signedIn: true, signingIn: false, failed: false };
    } catch (error) {
      const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
      return {
        installed: !missing,
        signedIn: false,
        signingIn: Boolean(this.child),
        failed: this.failure,
      };
    }
  }

  private request(method: string, params: unknown) {
    const child = this.child;
    if (!child) throw new UserError('Codex is not running.');
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex did not respond.'));
      }, 15000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  async start() {
    if (this.child && this.authUrl) return this.authUrl;
    if (this.child) throw new UserError('Sign-in is already starting.');
    this.failure = false;
    const child = spawn(process.env.CODEX_BIN ?? 'codex', ['app-server'], {
      env: environment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        return;
      }
      const message = z
        .object({
          id: z.number().optional(),
          method: z.string().optional(),
          result: z.unknown().optional(),
          error: z.unknown().optional(),
          params: z.unknown().optional(),
        })
        .safeParse(raw);
      if (!message.success) return;
      if (message.data.id !== undefined) {
        const waiting = this.pending.get(message.data.id);
        this.pending.delete(message.data.id);
        if (message.data.error) waiting?.reject(new Error('Codex could not start sign-in.'));
        else waiting?.resolve(message.data.result);
      }
      if (message.data.method === 'account/login/completed') {
        const completion = z.object({ success: z.boolean() }).safeParse(message.data.params);
        this.failure = !completion.success || !completion.data.success;
        this.stop();
      }
    });
    const ended = () => {
      if (this.child !== child) return;
      this.child = null;
      this.authUrl = null;
      for (const waiting of this.pending.values())
        waiting.reject(new Error('Codex stopped before sign-in finished.'));
      this.pending.clear();
    };
    child.once('error', ended);
    child.once('close', ended);
    try {
      await this.request('initialize', {
        clientInfo: { name: 'chat2tasks', title: 'Wawa', version: '0.1.0' },
      });
      child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
      const result = z
        .object({ type: z.literal('chatgpt'), authUrl: z.url() })
        .parse(await this.request('account/login/start', { type: 'chatgpt' }));
      const url = new URL(result.authUrl);
      if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname))
        throw new UserError('Codex returned an unexpected sign-in address.');
      this.authUrl = result.authUrl;
      return result.authUrl;
    } catch (error) {
      this.failure = true;
      this.stop();
      throw error;
    }
  }

  stop() {
    this.child?.kill('SIGTERM');
  }
}
