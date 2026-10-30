import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const cookieName = 'chat2tasks_desktop';
const lifetime = 30 * 24 * 60 * 60;

export const desktopSignInCsp =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export function desktopSignInPage(failed = false) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in to Chat2Tasks</title>
  <style>
    body { font: 16px -apple-system, BlinkMacSystemFont, sans-serif; background: #fafafa; color: #202522; margin: 0; display: grid; place-items: center; min-height: 100vh; }
    main { background: white; border: 1px solid #e1e5e2; border-radius: 14px; padding: 32px; width: min(380px, calc(100vw - 80px)); }
    h1 { font-size: 24px; margin: 0 0 12px; }
    p { color: #5f6c64; line-height: 1.5; }
    label { display: block; font-weight: 600; margin: 24px 0 8px; }
    input { box-sizing: border-box; width: 100%; padding: 12px; font: inherit; border: 1px solid #aab5ae; border-radius: 8px; }
    button { width: 100%; margin-top: 20px; padding: 12px; border: 0; border-radius: 8px; background: #1b2721; color: white; font: inherit; font-weight: 600; cursor: pointer; }
    .error { color: #a12424; }
  </style>
</head>
<body><main>
  <h1>Sign in to your workspace</h1>
  <p>Enter the password for this Chat2Tasks server.</p>
  ${failed ? '<p class="error" role="alert">That password did not match. Try again.</p>' : ''}
  <form method="post" action="/desktop-sign-in">
    <label for="password">Workspace password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
    <button type="submit">Sign in</button>
  </form>
</main></body></html>`;
}

function signature(key: Buffer, password: string, value: string) {
  return createHmac('sha256', key)
    .update('chat2tasks-desktop-session\0')
    .update(password)
    .update('\0')
    .update(value)
    .digest('hex');
}

export function desktopSessionCookie(key: Buffer, password: string, secure: boolean) {
  const value = `${Math.floor(Date.now() / 1000) + lifetime}.${randomBytes(24).toString('hex')}`;
  return `${cookieName}=${value}.${signature(key, password, value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${lifetime}${secure ? '; Secure' : ''}`;
}

export function validDesktopSession(header: string, key: Buffer, password: string) {
  const token = header
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(cookieName + '='))
    ?.slice(cookieName.length + 1);
  if (!token || !/^\d{1,12}\.[a-f0-9]{48}\.[a-f0-9]{64}$/.test(token)) return false;
  const [expiry, nonce, supplied] = token.split('.');
  if (!expiry || !nonce || !supplied || Number(expiry) <= Math.floor(Date.now() / 1000))
    return false;
  const expected = Buffer.from(signature(key, password, `${expiry}.${nonce}`), 'hex');
  const actual = Buffer.from(supplied, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
