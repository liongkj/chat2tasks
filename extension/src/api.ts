import { z } from 'zod';
import { PairResultSchema, type Connection } from '../../src/shared/companion.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function read<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const payload: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(payload);
    throw new ApiError(
      response.status,
      error.success ? error.data.error : 'Your server could not complete the request.',
    );
  }
  return schema.parse(payload);
}
export async function pair(serverUrl: string, code: string, name: string) {
  return read(
    await fetch(serverUrl + '/api/companion/pair', {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', 'X-Chat2Tasks-Extension': chrome.runtime.id },
      body: JSON.stringify({ code, name }),
    }),
    PairResultSchema,
  );
}
export async function request<T>(
  connection: Connection,
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
): Promise<T> {
  return read(
    await fetch(connection.serverUrl + '/api/companion/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        'X-Chat2Tasks-Extension': chrome.runtime.id,
        Authorization: 'Bearer ' + connection.token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    schema,
  );
}
export const OkSchema = z.object({ ok: z.boolean() });
