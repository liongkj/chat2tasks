import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { registerDesktopSignIn } from '../src/server/desktop-sign-in.js';
import { validDesktopSession } from '../src/server/desktop-session.js';
import { routeServer } from './route-fixture.js';

const origin = 'http://127.0.0.1:4242';

async function fixture(password: string) {
  const key = randomBytes(32);
  const server = routeServer();
  registerDesktopSignIn(server, { key, password, origins: new Set([origin]) });
  await server.ready();
  return { key, server };
}

const form = (password: string) => ({
  method: 'POST' as const,
  url: '/desktop-sign-in',
  headers: {
    origin,
    host: '127.0.0.1:4242',
    'content-type': 'application/x-www-form-urlencoded',
  },
  payload: new URLSearchParams({ password }).toString(),
});

test('without a password the sign-in page just redirects home', async () => {
  const f = await fixture('');
  try {
    const page = await f.server.inject({ method: 'GET', url: '/desktop-sign-in' });
    assert.equal(page.statusCode, 303);
    assert.equal(page.headers.location, '/');
    const post = await f.server.inject(form('anything'));
    assert.equal(post.statusCode, 303);
    assert.equal(post.headers['set-cookie'], undefined);
  } finally {
    await f.server.close();
  }
});

test('a correct password sets a session cookie that the page then accepts', async () => {
  const f = await fixture('open sesame');
  try {
    const page = await f.server.inject({ method: 'GET', url: '/desktop-sign-in' });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['content-type'] ?? '', /text\/html/);
    assert.ok(page.headers['content-security-policy']);
    const wrong = await f.server.inject(form('open please'));
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.headers['set-cookie'], undefined);
    const right = await f.server.inject(form('open sesame'));
    assert.equal(right.statusCode, 303);
    const cookie = String(right.headers['set-cookie']).split(';')[0] ?? '';
    assert.ok(validDesktopSession(cookie, f.key, 'open sesame'));
    const signedIn = await f.server.inject({
      method: 'GET',
      url: '/desktop-sign-in',
      headers: { cookie },
    });
    assert.equal(signedIn.statusCode, 303);
  } finally {
    await f.server.close();
  }
});

test('the form is rejected from an unknown origin or a mismatched host', async () => {
  const f = await fixture('open sesame');
  try {
    const foreign = await f.server.inject({
      ...form('open sesame'),
      headers: { ...form('').headers, origin: 'http://evil.example' },
    });
    assert.equal(foreign.statusCode, 403);
    const mismatch = await f.server.inject({
      ...form('open sesame'),
      headers: { ...form('').headers, host: 'other.example' },
    });
    assert.equal(mismatch.statusCode, 403);
  } finally {
    await f.server.close();
  }
});
