import { afterEach, describe, expect, test } from 'bun:test';

import {
  AccountError,
  me,
  nameFree,
  rename,
  saveOutfit,
  sendCode,
  signOut,
  verifyCode,
} from './account.ts';

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
    answer(json({}), json({ name: 'Bram', outfit, at: null, fresh: false, mail: true }));
    expect(await verifyCode('a@b.co', '123456')).toEqual({
      guest: false,
      name: 'Bram',
      outfit,
      at: null,
      fresh: false,
      mail: true,
    });
    expect(calls.map((c) => [c.url, c.init?.method ?? 'GET'])).toEqual([
      ['/api/auth/sign-in/email-otp', 'POST'],
      ['/api/me', 'GET'],
    ]);
    expect(calls[0]?.init).toMatchObject({
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
    });
    expect(calls[1]?.init?.headers).toBeUndefined();
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
    expect(await reason(verifyCode('a@b.co', '123456'))).toMatchObject({ code: 'server' });
    answer(new Response(null, { status: 429 }));
    expect(await reason(verifyCode('a@b.co', '123456'))).toMatchObject({ code: 'busy' });
  });

  test('a server that can’t say gives no one: a null, or an old server’s 401', async () => {
    answer(json(null));
    expect(await me()).toBeNull();
    answer(json({}, 401));
    expect(await me()).toBeNull();
  });

  test('a guest is someone', async () => {
    answer(json({ guest: true, name: 'Sunny Otter', outfit, at: null, fresh: false, mail: true }));
    expect(await me()).toEqual({
      guest: true,
      name: 'Sunny Otter',
      outfit,
      at: null,
      fresh: false,
      mail: true,
    });
  });

  test('a guest after signing in is the server’s failure', async () => {
    answer(
      json({}),
      json({ guest: true, name: 'Sunny Otter', outfit, at: null, fresh: false, mail: true }),
    );
    expect(await reason(verifyCode('a@b.co', '123456'))).toMatchObject({ code: 'server' });
  });

  test('an odd answer to me() is the server’s fault', async () => {
    answer(json({ name: 'Bram' }));
    expect(await reason(me())).toMatchObject({ code: 'server' });
    answer(new Response('not json'));
    expect(await reason(me())).toMatchObject({ code: 'server' });
    answer(json({ name: 'Bram', outfit }));
    expect(await me()).toEqual({
      guest: false,
      name: 'Bram',
      outfit,
      at: null,
      fresh: false,
      mail: true,
    });
  });

  test('a session the browser dropped right after signing in', async () => {
    answer(json({}), json({}, 401));
    expect(await reason(verifyCode('a@b.co', '123456'))).toMatchObject({ code: 'server' });
  });

  test('signing out when already out is fine; a failure is not', async () => {
    answer(json({}, 401));
    await signOut();
    answer(json({}, 500));
    expect(await reason(signOut())).toMatchObject({ code: 'server' });
  });

  test('a code goes out for a cleaned-up address; a bad one is said before asking', async () => {
    answer(json({ success: true }));
    await sendCode('  Anna@Example.COM ');
    expect(calls[0]?.url).toBe('/api/auth/email-otp/send-verification-otp');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ email: 'anna@example.com' }));
    answer();
    expect(await reason(sendCode('not an address'))).toMatchObject({ code: 'email' });
    expect(calls).toEqual([]);
  });

  test('turns each reason a code can’t go out into a sentence', async () => {
    const say = async (status: number, code: string) => {
      answer(json({ code }, status));
      return reason(sendCode('a@b.co'));
    };
    expect(await say(503, 'MAIL_OFF')).toMatchObject({
      code: 'mail-off',
      message: 'Joining isn’t switched on yet. Keep exploring as you are.',
    });
    expect(await say(502, 'MAIL_FAILED')).toMatchObject({ code: 'mail-failed' });
    expect(await say(400, 'EMAIL_UNDELIVERABLE')).toMatchObject({ code: 'undeliverable' });
    expect(await say(429, 'TOO_MANY_REQUESTS')).toMatchObject({ code: 'busy' });
    answer(json({ code: 'CODE_ALREADY_SENT', retryAfter: 12 }, 429));
    expect(await reason(sendCode('a@b.co'))).toMatchObject({ code: 'sent', retryAfter: 12 });
    answer(json({ code: 'CODE_ALREADY_SENT' }, 429));
    expect(await reason(sendCode('a@b.co'))).toMatchObject({ code: 'sent', retryAfter: 30 });
  });

  test('a code is six digits, sent with its address', async () => {
    answer();
    expect(await reason(verifyCode('a@b.co', '12345'))).toMatchObject({ code: 'code' });
    expect(await reason(verifyCode('a@b.co', '12345a'))).toMatchObject({ code: 'code' });
    expect(calls).toEqual([]);
    answer(json({}), json({ name: 'Bram', outfit, fresh: true }));
    expect(await verifyCode(' A@b.co', '123456')).toMatchObject({ name: 'Bram', fresh: true });
    expect(calls[0]?.url).toBe('/api/auth/sign-in/email-otp');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ email: 'a@b.co', otp: '123456' }));
    for (const [code, ours] of [
      ['INVALID_OTP', 'code'],
      ['OTP_EXPIRED', 'expired'],
      ['TOO_MANY_ATTEMPTS', 'spent'],
    ]) {
      answer(json({ code }, 400));
      // oxlint-disable-next-line no-await-in-loop
      expect(await reason(verifyCode('a@b.co', '123456'))).toMatchObject({ code: ours });
    }
  });

  test('a new name is checked before asking, and is what you are after', async () => {
    answer();
    expect(await reason(rename('no'))).toMatchObject({ code: 'name' });
    answer(json({ name: 'Bram' }), json({ name: 'Bram', outfit }));
    expect(await rename('Bram')).toMatchObject({ name: 'Bram' });
    expect(calls[0]?.init).toMatchObject({ method: 'PUT', body: JSON.stringify({ name: 'Bram' }) });
    answer(json({ code: 'USERNAME_IS_ALREADY_TAKEN' }, 400));
    expect(await reason(rename('Bram'))).toMatchObject({
      code: 'taken',
      message: 'That name is taken.',
    });
  });

  test('whether a name is free, or null when it can’t be told', async () => {
    answer();
    expect(await nameFree('no')).toBeNull();
    answer(json({ available: true }));
    expect(await nameFree('Bram')).toBe(true);
    expect(calls[0]?.url).toBe('/api/auth/is-username-available');
    answer(json({ available: false }));
    expect(await nameFree('Bram')).toBe(false);
    answer(json({}, 429));
    expect(await nameFree('Bram')).toBeNull();
    answer(new TypeError('Failed to fetch'));
    expect(await nameFree('Bram')).toBeNull();
    answer(new Response('not json'));
    expect(await nameFree('Bram')).toBeNull();
    answer(json({ available: 'yes' }));
    expect(await nameFree('Bram')).toBeNull();
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
