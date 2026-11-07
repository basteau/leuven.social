import { afterEach, describe, expect, test } from 'bun:test';

import { AccountError, me, saveOutfit, signIn, signOut, signUp } from './account.ts';

// The real server is exercised end to end in server/server.test.ts; these cover what it
// rarely says: outages, odd answers, and the checks made before any request.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const outfit = { skin: 1, hair: 2, shirt: 3, shorts: 4 };
const calls: { url: string; init: RequestInit | undefined }[] = [];

function answer(...responses: (Response | Error)[]) {
  calls.length = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('no more answers');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const reason = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => e,
  );

describe('account', () => {
  test('sends the cookie, JSON and the right paths', async () => {
    answer(json({}), json({ name: 'Bram', outfit, at: null }));
    expect(await signUp('Bram', 'password1')).toEqual({ name: 'Bram', outfit, at: null });
    expect(calls.map((c) => [c.url, c.init?.method ?? 'GET'])).toEqual([
      ['/api/account', 'POST'],
      ['/api/me', 'GET'],
    ]);
    expect(calls[0]?.init).toMatchObject({
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Bram', password: 'password1' }),
    });
    expect(calls[1]?.init?.headers).toBeUndefined();
  });

  test('checks the name and password before asking', async () => {
    answer();
    expect(await reason(signUp('a', 'password1'))).toMatchObject({ code: 'name' });
    expect(await reason(signUp('.bram', 'password1'))).toMatchObject({ code: 'name' });
    expect(await reason(signUp('bram', 'short'))).toMatchObject({
      code: 'password',
      message: 'Use at least 8 characters.',
    });
    expect(await reason(signUp('bram', 'x'.repeat(129)))).toMatchObject({ code: 'password' });
    expect(await reason(signIn('a', 'password1'))).toMatchObject({ code: 'credentials' });
    expect(await reason(signIn('bram', ''))).toMatchObject({ code: 'credentials' });
    expect(calls).toEqual([]);
  });

  test('a sign-in the server finds malformed is just a wrong password', async () => {
    answer(json({ code: 'PASSWORD_TOO_LONG' }, 400));
    expect(await reason(signIn('bram', 'password1'))).toMatchObject({ code: 'credentials' });
    answer(json({ code: 'INVALID_USERNAME_OR_PASSWORD' }, 401));
    expect(await reason(signIn('bram', 'password1'))).toMatchObject({ code: 'credentials' });
  });

  test('says when the network or the server is down, or busy', async () => {
    answer(new TypeError('Failed to fetch'));
    const offline = await reason(me());
    expect(offline).toBeInstanceOf(AccountError);
    expect(offline).toMatchObject({ code: 'offline', name: 'AccountError' });
    expect((offline as Error).cause).toBeInstanceOf(TypeError);
    answer(new Response('Bad gateway', { status: 502 }));
    expect(await reason(me())).toMatchObject({
      code: 'server',
      message: 'Something went wrong on our side. Try again in a moment.',
    });
    answer(json({ code: 'SOMETHING_NEW' }, 400));
    expect(await reason(signUp('bram', 'password1'))).toMatchObject({ code: 'server' });
    answer(new Response(null, { status: 429 }));
    expect(await reason(signIn('bram', 'password1'))).toMatchObject({ code: 'busy' });
  });

  test('a guest is nobody: a null, or an old server’s 401', async () => {
    answer(json(null));
    expect(await me()).toBeNull();
    answer(json({}, 401));
    expect(await me()).toBeNull();
  });

  test('an odd answer to me() is the server’s fault', async () => {
    answer(json({ name: 'Bram' }));
    expect(await reason(me())).toMatchObject({ code: 'server' });
    answer(new Response('not json'));
    expect(await reason(me())).toMatchObject({ code: 'server' });
    answer(json({ name: 'Bram', outfit }));
    expect(await me()).toEqual({ name: 'Bram', outfit, at: null });
  });

  test('a session the browser dropped right after signing in', async () => {
    answer(json({}), json({}, 401));
    expect(await reason(signIn('bram', 'password1'))).toMatchObject({ code: 'server' });
  });

  test('signing out when already out is fine; a failure is not', async () => {
    answer(json({}, 401));
    await signOut();
    answer(json({}, 500));
    expect(await reason(signOut())).toMatchObject({ code: 'server' });
  });

  test('saving an outfit when signed out asks to sign in again', async () => {
    answer(json({}, 401));
    expect(await reason(saveOutfit(outfit))).toMatchObject({ code: 'signed-out' });
    answer(json({ outfit }));
    await saveOutfit(outfit);
    expect(calls[0]?.init).toMatchObject({ method: 'PUT', keepalive: false });
    // Leaving the page, the request outlives it.
    answer(json({ outfit }));
    await saveOutfit(outfit, { leaving: true });
    expect(calls[0]?.init?.keepalive).toBe(true);
  });
});
