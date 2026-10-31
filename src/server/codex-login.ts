import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { z } from 'zod';

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
  private authInfo: { url: string; userCode?: string } | null = null;
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
    if (!child) throw new Error('Codex is not running.');
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

  async start(mode: 'browser' | 'device' = 'browser') {
    if (this.child && this.authInfo) return this.authInfo;
    if (this.child) throw new Error('Sign-in is already starting.');
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
      this.authInfo = null;
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
      const response = await this.request('account/login/start', {
        type: mode === 'device' ? 'chatgptDeviceCode' : 'chatgpt',
      });
      let result: { url: string; userCode?: string };
      if (mode === 'device') {
        const value = z
          .object({
            type: z.literal('chatgptDeviceCode'),
            verificationUrl: z.url(),
            userCode: z.string().min(1).max(128),
          })
          .parse(response);
        result = { url: value.verificationUrl, userCode: value.userCode };
      } else {
        const value = z.object({ type: z.literal('chatgpt'), authUrl: z.url() }).parse(response);
        result = { url: value.authUrl };
      }
      const url = new URL(result.url);
      if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname))
        throw new Error('Codex returned an unexpected sign-in address.');
      this.authInfo = result;
      return result;
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
