import {z} from 'zod';
export async function api<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  const response = await fetch('/api/' + path, body === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const payload: unknown = await response.json();
  if (!response.ok) {const error = z.object({error: z.string()}).safeParse(payload); throw new Error(error.success ? error.data.error : 'The request failed. Try again.');}
  return schema.parse(payload);
}
export const OkSchema = z.object({ok: z.boolean()});
export function download(name: string, content: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], {type})), a = document.createElement('a');
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const time = (timestamp: number) => timestamp ? new Intl.DateTimeFormat(undefined, {day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'}).format(timestamp * 1000) : 'Not yet';
