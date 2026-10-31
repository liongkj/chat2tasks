import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  desktopSessionCookie,
  desktopSignInCsp,
  desktopSignInPage,
  validDesktopSession,
} from './desktop-session.js';

export type DesktopSignInOptions = {
  /** Workspace signing key used to mint and verify the session cookie. */
  key: Buffer;
  /** Password the form must match. Empty disables the sign-in page. */
  password: string;
  /** Origins allowed to post the form. */
  origins: ReadonlySet<string>;
};

/** HTML sign-in page for desktop and shared workspaces; sets the desktop session cookie. */
export function registerDesktopSignIn(server: FastifyInstance, options: DesktopSignInOptions) {
  const { key, password, origins } = options;
  server.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 4096 },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    },
  );
  server.get('/desktop-sign-in', (request, reply) => {
    if (!password || validDesktopSession(request.headers.cookie ?? '', key, password))
      return reply.code(303).header('Location', '/').send();
    return reply
      .header('Content-Security-Policy', desktopSignInCsp)
      .type('text/html')
      .send(desktopSignInPage());
  });
  server.post('/desktop-sign-in', (request, reply) => {
    const origin = request.headers.origin;
    if (!origin || !origins.has(origin) || new URL(origin).host !== request.headers.host)
      return reply.code(403).send({ error: 'Invalid request origin' });
    if (!password) return reply.code(303).header('Location', '/').send();
    const input = z.object({ password: z.string().max(1024) }).safeParse(request.body);
    const expected = Buffer.from(password);
    const actual = Buffer.from(input.success ? input.data.password : '');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      return reply
        .code(401)
        .header('Content-Security-Policy', desktopSignInCsp)
        .type('text/html')
        .send(desktopSignInPage(true));
    return reply
      .code(303)
      .header('Location', '/')
      .header('Set-Cookie', desktopSessionCookie(key, password, origin.startsWith('https://')))
      .send();
  });
}
