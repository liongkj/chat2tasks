import { z } from 'zod';
export function appFetch(path: string, init: RequestInit = {}) {
  const tauri = window.chat2tasksTauri;
  if (!tauri) return fetch(path, init);
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid workspace path.');
  const headers = new Headers(init.headers);
  headers.set('X-Chat2Tasks-Session', tauri.token);
  return fetch(tauri.origin + path, { ...init, headers });
}
export async function api<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  const response = await appFetch(
    '/api/' + path,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(payload);
    throw new Error(
      error.success
        ? error.data.error
        : response.status === 401
          ? 'Sign in to your workspace and try again.'
          : `The workspace did not complete the request (HTTP ${response.status}). Try again.`,
    );
  }
  if (payload === undefined) throw new Error('The workspace returned an unreadable response.');
  return schema.parse(payload);
}
export const OkSchema = z.object({ ok: z.boolean() });
export function download(name: string, content: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type })),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const time = (timestamp: number) =>
  timestamp
    ? new Intl.DateTimeFormat(undefined, {
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
      }).format(timestamp * 1000)
    : 'Not yet';
