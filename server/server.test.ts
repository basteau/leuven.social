import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';

import { Database } from 'bun:sqlite';
import * as account from '../src/net/account.ts';
import { AccountError } from '../src/net/account.ts';
import { decodeServerMessage, encodeClientMessage, quantise } from '../src/net/protocol.ts';
import type { PlayerState, ServerMessage } from '../src/net/protocol.ts';
import { MailError } from './mail.ts';
import type { Mailer } from './mail.ts';
import { clientKey, originMatches, startServer } from './server.ts';
import { CLOSE_SIGNED_OUT } from './world.ts';
import type { RunningServer } from './server.ts';

const ORIGIN = 'http://localhost:5173';
/** Instead of a mail provider: the last code each address got. */
const inbox = new Map<string, string>();
const fakeMailer: Mailer = {
  ready: true,
  send(to, code) {
    inbox.set(to, code);
    return Promise.resolve();
  },
};
const lastCode = (email: string) => {
  const code = inbox.get(email);
  if (!code) throw new Error(`no code went to ${email}`);
  return code;
};
/** How far the rate limits' clock is ahead of the real one (ms). */
let ahead = 0;
const passTime = (ms: number) => (ahead += ms);
const SEND_CODE = '/api/auth/email-otp/send-verification-otp';
const SIGN_IN = '/api/auth/sign-in/email-otp';
let mailboxes = 0;
const anAddress = () => `person${++mailboxes}@example.com`;

const here: PlayerState = quantise({
  x: 12,
  z: 34,
  heading: 0.5,
  speed: 1.4,
  mode: 'foot',
  place: '',
  floor: 0,
});

let server: RunningServer;
let realFetch: typeof fetch;

beforeAll(async () => {
  server = await startServer({
    port: 0,
    databasePath: ':memory:',
    secret: 'test-secret-test-secret-test-secret',
    baseURL: ORIGIN,
    rateLimit: false,
    quiet: true,
    tick: 20,
    saveEvery: 50,
    mailer: fakeMailer,
    now: () => Date.now() + ahead,
  });
  realFetch = globalThis.fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await server.stop();
});

/** A browser's cookie jar, enough for one session cookie. */
class Jar {
  cookies = new Map<string, string>();
  header = () => [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  keep(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair = ''] = line.split(';');
      const [name = '', value = ''] = pair.split('=');
      if (/Max-Age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

/** Calls the API the way the page does, same-origin, with this jar's cookies. */
async function call(jar: Jar, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('origin', ORIGIN);
  if (jar.cookies.size) headers.set('cookie', jar.header());
  const response = await realFetch(new URL(path, server.url), { ...init, headers });
  jar.keep(response);
  return response;
}

/** Runs src/net/account.ts against the real server as the browser holding `jar`. */
async function as<T>(jar: Jar, run: () => Promise<T>): Promise<T> {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    call(jar, String(input), init)) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

const postJson = (jar: Jar, path: string, body: unknown) =>
  call(jar, path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

/** A WebSocket with the jar's cookie, collecting what the server sends. */
class Client {
  readonly messages: ServerMessage[] = [];
  readonly socket: WebSocket;
  readonly opened: Promise<void>;
  readonly closed: Promise<CloseEvent>;
  /** Checks waiting for a message; each returns true once it found one. */
  private waiters = new Set<() => boolean>();

  constructor(jar?: Jar) {
    const url = new URL('/ws', server.url);
    url.protocol = 'ws:';
    const headers: Record<string, string> = { origin: ORIGIN };
    if (jar?.cookies.size) headers.cookie = jar.header();
    this.socket = new WebSocket(url, { headers } as never);
    this.socket.binaryType = 'arraybuffer';
    this.opened = new Promise((resolve) => this.socket.addEventListener('open', () => resolve()));
    this.closed = new Promise((resolve) => this.socket.addEventListener('close', resolve));
    this.socket.addEventListener('message', (event) => {
      const message = decodeServerMessage(new Uint8Array(event.data as ArrayBuffer));
      if (message) this.messages.push(message);
      for (const check of this.waiters) if (check()) this.waiters.delete(check);
    });
  }

  send(state: Partial<PlayerState> = {}) {
    this.socket.send(encodeClientMessage({ type: 'state', state: { ...here, ...state } }));
  }

  /** Resolves with the first message (from the start) that matches. */
  next<T extends ServerMessage['type']>(
    type: T,
    match: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    type M = Extract<ServerMessage, { type: T }>;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`no ${type} message arrived`)), 2000);
      const check = () => {
        const found = this.messages.find((m): m is M => m.type === type && match(m as M));
        if (found) {
          clearTimeout(timeout);
          resolve(found);
        }
        return found !== undefined;
      };
      if (!check()) this.waiters.add(check);
    });
  }

  close() {
    this.socket.close();
    return this.closed;
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Signs the jar in through its email: a new account unless `email` already has one. */
async function codeIn(jar: Jar, email = anAddress()) {
  // Past any wait left from the last code to this address.
  passTime(31_000);
  await as(jar, () => account.sendCode(email));
  return as(jar, () => account.verifyCode(email, lastCode(email)));
}

/** A new account with the name it asked for. */
async function joinAs(jar: Jar, name: string, email = `${name.toLowerCase()}@example.com`) {
  await codeIn(jar, email);
  return as(jar, () => account.rename(name));
}

describe('signing in with a code', () => {
  test('a new address gets an account named after its guest, fresh until it says so', async () => {
    const jar = new Jar();
    const guest = await as(jar, () => account.me());
    expect(guest).toMatchObject({ guest: true, mail: true });
    const me = await codeIn(jar);
    expect(me.guest).toBe(false);
    expect(me.fresh).toBe(true);
    expect(me.name).toBe(guest!.name.replace(' ', ''));
    const kept = await as(jar, () => account.rename(me.name));
    expect(kept).toMatchObject({ name: me.name, fresh: false });
    expect((await as(jar, () => account.me()))?.fresh).toBe(false);
  });

  test('an address that has an account gets back into it, not fresh', async () => {
    const email = anAddress();
    const first = new Jar();
    const name = (await codeIn(first, email)).name;
    await as(first, () => account.rename(name));
    passTime(31_000);
    const second = new Jar();
    const me = await codeIn(second, email);
    expect(me).toMatchObject({ name, fresh: false, guest: false });
  });

  test('the same address however it is typed', async () => {
    const jar = new Jar();
    await postJson(jar, SEND_CODE, { email: '  Case@Example.COM ' });
    const code = lastCode('case@example.com');
    const response = await postJson(jar, SIGN_IN, { email: 'CASE@example.com', otp: code });
    expect(response.status).toBe(200);
  });

  test('no difference between an address with an account and one without', async () => {
    const taken = anAddress();
    await codeIn(new Jar(), taken);
    passTime(31_000);
    const known = await postJson(new Jar(), SEND_CODE, { email: taken });
    const unknown = await postJson(new Jar(), SEND_CODE, { email: anAddress() });
    expect([known.status, unknown.status]).toEqual([200, 200]);
    expect(await known.text()).toBe(await unknown.text());
  });

  test('a body with other fields can’t set the name or the type', async () => {
    const jar = new Jar();
    const email = anAddress();
    await postJson(jar, SEND_CODE, { email, type: 'forget-password' });
    const response = await postJson(jar, SIGN_IN, {
      email,
      otp: lastCode(email),
      name: 'Chosen',
      username: 'chosen',
      image: 'http://evil.example/me.png',
      fresh: false,
    });
    expect(response.status).toBe(200);
    const me = (await as(jar, () => account.me()))!;
    expect(me.name).not.toBe('Chosen');
    expect(me.fresh).toBe(true);
  });

  test('a wrong code is refused, and the right one still works', async () => {
    const email = anAddress();
    const jar = new Jar();
    await as(jar, () => account.sendCode(email));
    const right = lastCode(email);
    const wrong = right === '000000' ? '000001' : '000000';
    expect(as(jar, () => account.verifyCode(email, wrong))).rejects.toMatchObject({
      code: 'code',
      message: 'That code isn’t right. Check the digits, or send a new one.',
    });
    await wait(10);
    const me = await as(jar, () => account.verifyCode(email, right));
    expect(me.guest).toBe(false);
  });

  test('a code that isn’t six digits never reaches the check', async () => {
    const email = anAddress();
    await postJson(new Jar(), SEND_CODE, { email });
    for (const otp of ['12345', '1234567', 'abcdef', 123456]) {
      // oxlint-disable-next-line no-await-in-loop
      const response = await postJson(new Jar(), SIGN_IN, { email, otp });
      expect(response.status).toBe(400);
    }
    // None of them counted against the real code.
    expect((await postJson(new Jar(), SIGN_IN, { email, otp: lastCode(email) })).status).toBe(200);
  });

  test('five wrong tries spend a code; a new one works', async () => {
    const email = anAddress();
    await postJson(new Jar(), SEND_CODE, { email });
    const right = lastCode(email);
    const wrong = right === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i++) {
      // oxlint-disable-next-line no-await-in-loop
      const response = await postJson(new Jar(), SIGN_IN, { email, otp: wrong });
      expect(response.status).toBe(400);
    }
    const spent = await postJson(new Jar(), SIGN_IN, { email, otp: right });
    expect(spent.status).toBe(403);
    expect(await spent.json()).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
    passTime(31_000);
    await postJson(new Jar(), SEND_CODE, { email });
    expect((await postJson(new Jar(), SIGN_IN, { email, otp: lastCode(email) })).status).toBe(200);
  });

  test('a code runs out after ten minutes', async () => {
    const email = anAddress();
    await postJson(new Jar(), SEND_CODE, { email });
    const code = lastCode(email);
    setSystemTime(new Date(Date.now() + 11 * 60 * 1000));
    try {
      const late = await postJson(new Jar(), SIGN_IN, { email, otp: code });
      expect(late.status).toBe(400);
      expect(await late.json()).toMatchObject({ code: 'OTP_EXPIRED' });
    } finally {
      setSystemTime();
    }
  });

  test('a new code replaces the last one', async () => {
    const email = anAddress();
    await postJson(new Jar(), SEND_CODE, { email });
    const before = lastCode(email);
    passTime(31_000);
    // The newest row wins; in life they're half a minute apart, here a timestamp could tie.
    await wait(5);
    await postJson(new Jar(), SEND_CODE, { email });
    const after = lastCode(email);
    if (before !== after) {
      expect((await postJson(new Jar(), SIGN_IN, { email, otp: before })).status).toBe(400);
    }
    expect((await postJson(new Jar(), SIGN_IN, { email, otp: after })).status).toBe(200);
  });

  test('a code is good only once', async () => {
    const email = anAddress();
    await postJson(new Jar(), SEND_CODE, { email });
    const code = lastCode(email);
    expect((await postJson(new Jar(), SIGN_IN, { email, otp: code })).status).toBe(200);
    expect((await postJson(new Jar(), SIGN_IN, { email, otp: code })).status).toBe(400);
  });

  test('an address gets a code every half a minute at most, and says so', async () => {
    const email = anAddress();
    expect((await postJson(new Jar(), SEND_CODE, { email })).status).toBe(200);
    const soon = await postJson(new Jar(), SEND_CODE, { email });
    expect(soon.status).toBe(429);
    const body = (await soon.json()) as { code: string; retryAfter: number };
    expect(body.code).toBe('CODE_ALREADY_SENT');
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(body.retryAfter).toBeLessThanOrEqual(30);
    passTime(31_000);
    expect((await postJson(new Jar(), SEND_CODE, { email })).status).toBe(200);
  });

  test('an address gets five codes an hour at most, however many ask', async () => {
    const email = anAddress();
    for (let i = 0; i < 5; i++) {
      // oxlint-disable-next-line no-await-in-loop
      expect((await postJson(new Jar(), SEND_CODE, { email })).status).toBe(200);
      passTime(31_000);
    }
    const over = await postJson(new Jar(), SEND_CODE, { email });
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  test('wrong codes are capped for one address, from anywhere', async () => {
    const email = anAddress();
    let last = new Response();
    for (let i = 0; i < 11; i++) {
      // oxlint-disable-next-line no-await-in-loop
      last = await postJson(new Jar(), SIGN_IN, { email, otp: '999999' });
    }
    expect(last.status).toBe(429);
    expect(((await last.json()) as { message: string }).message).toContain('Too many tries');
    expect((await postJson(new Jar(), SIGN_IN, { email: anAddress(), otp: '999999' })).status).toBe(
      400,
    );
  });

  test('addresses that couldn’t get mail or aren’t addresses are refused plainly', async () => {
    const refused = await postJson(new Jar(), SEND_CODE, { email: 'old@players.invalid' });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: 'EMAIL_UNDELIVERABLE' });
    for (const email of ['not-an-address', `${'a'.repeat(260)}@b.co`, 4, null]) {
      // oxlint-disable-next-line no-await-in-loop
      const bad = await postJson(new Jar(), SEND_CODE, { email });
      expect(bad.status).toBe(400);
      // oxlint-disable-next-line no-await-in-loop
      expect(await bad.json()).toMatchObject({ code: 'INVALID_EMAIL' });
    }
  });

  test('a body that isn’t JSON is no address', async () => {
    const garbage = await call(new Jar(), SEND_CODE, { method: 'POST', body: '{' });
    expect(garbage.status).toBe(400);
    expect(await garbage.json()).toMatchObject({ code: 'INVALID_EMAIL' });
  });

  test('another site can’t ask for a code', async () => {
    const response = await realFetch(new URL(SEND_CODE, server.url), {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com' }),
    });
    expect(response.status).toBe(403);
  });

  test('the other OTP routes stay closed', async () => {
    const paths = [
      'forget-password/email-otp',
      'email-otp/verify-email',
      'email-otp/reset-password',
    ];
    const answers = await Promise.all(
      paths.map((p) => postJson(new Jar(), `/api/auth/${p}`, { email: 'a@b.co' })),
    );
    expect(answers.map((a) => a.status)).toEqual([404, 404, 404]);
  });

  test('a taken name gets a number, one at a time however close together', async () => {
    const jar = new Jar();
    await as(jar, () => account.me());
    const cookie = jar.cookies.get('leuven_guest')!;
    const emails = [anAddress(), anAddress(), anAddress()];
    const jars = emails.map(() => {
      const copy = new Jar();
      copy.cookies.set('leuven_guest', cookie);
      return copy;
    });
    await Promise.all(emails.map((email, i) => postJson(jars[i]!, SEND_CODE, { email })));
    const answers = await Promise.all(
      emails.map((email, i) => postJson(jars[i]!, SIGN_IN, { email, otp: lastCode(email) })),
    );
    const bodies = (await Promise.all(answers.map((a) => a.json()))) as {
      user: { name: string };
    }[];
    const names = bodies.map((b) => b.user.name).toSorted();
    const stem = (await as(jar, () => account.me()))!.name.replace(' ', '');
    expect(names).toEqual([stem, `${stem}2`, `${stem}3`]);
  });

  test('without a guest cookie the words are random, and the name is valid', async () => {
    const me = await codeIn(new Jar());
    expect(me.name).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+\d*$/);
  });
});

describe('choosing a name', () => {
  test('a rename is heard by everyone, in place', async () => {
    const watcher = new Jar();
    await codeIn(watcher);
    const jar = new Jar();
    const me = await codeIn(jar);
    const seer = new Client(watcher);
    const socket = new Client(jar);
    await Promise.all([seer.opened, socket.opened]);
    const you = (await socket.next('welcome')).you;
    socket.send({ x: 18 });
    await seer.next('joins', (m) => m.players.some((p) => p.id === you));
    const renamed = await as(jar, () => account.rename('Marie'));
    expect(renamed).toMatchObject({ name: 'Marie', fresh: false });
    expect(me.name).not.toBe('Marie');
    expect(await seer.next('renamed', (m) => m.name === 'Marie')).toMatchObject({ id: you });
    await socket.next('identity', (m) => m.name === 'Marie');
    await Promise.all([seer.close(), socket.close()]);
  });

  test('a name is unique whatever its case, and your own can change case', async () => {
    const owner = new Jar();
    await codeIn(owner);
    await as(owner, () => account.rename('Marie2'));
    const other = new Jar();
    await codeIn(other);
    expect(as(other, () => account.rename('marie2'))).rejects.toMatchObject({
      code: 'taken',
      message: 'That name is taken.',
    });
    await wait(10);
    expect(await as(owner, () => account.rename('MARIE2'))).toMatchObject({ name: 'MARIE2' });
  });

  test('a name must be a name, and a guest can’t take one', async () => {
    const jar = new Jar();
    await codeIn(jar);
    const bad = await call(jar, '/api/me', {
      method: 'PUT',
      body: JSON.stringify({ name: 'no spaces allowed' }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'INVALID_USERNAME' });
    const guest = new Jar();
    await as(guest, () => account.me());
    const denied = await call(guest, '/api/me', {
      method: 'PUT',
      body: JSON.stringify({ name: 'Someone' }),
    });
    expect(denied.status).toBe(401);
  });
});

describe('the code routes under limits', () => {
  const started: RunningServer[] = [];
  afterAll(() => Promise.all(started.map((s) => s.stop())));
  const start = async (options: Partial<Parameters<typeof startServer>[0]>) => {
    const running = await startServer({
      port: 0,
      databasePath: ':memory:',
      secret: 'test-secret-test-secret-test-secret',
      baseURL: ORIGIN,
      quiet: true,
      ...options,
    });
    started.push(running);
    return {
      running,
      post: (path: string, body: unknown, address = '203.0.113.9', cookie = '') =>
        realFetch(new URL(path, running.url), {
          method: 'POST',
          headers: {
            origin: ORIGIN,
            'content-type': 'application/json',
            'x-real-ip': address,
            cookie,
          },
          body: JSON.stringify(body),
        }),
    };
  };

  test('with no mail set up, a code answers 503 and the page is told up front', async () => {
    const { running, post } = await start({ rateLimit: false });
    const refused = await post(SEND_CODE, { email: 'a@example.com' });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ code: 'MAIL_OFF' });
    const me = await realFetch(new URL('/api/me', running.url));
    expect(await me.json()).toMatchObject({ guest: true, mail: false });
    // Guests still play.
    expect(me.headers.getSetCookie().join()).toContain('leuven_guest=');
  });

  test('a provider that refuses is a sentence, and doesn’t count against them', async () => {
    let fail = true;
    const { post } = await start({
      rateLimit: false,
      mailer: {
        ready: true,
        send(to, code) {
          if (fail) return Promise.reject(new MailError('Resend said 403: not verified'));
          inbox.set(to, code);
          return Promise.resolve();
        },
      },
    });
    const email = anAddress();
    const failed = await post(SEND_CODE, { email });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ code: 'MAIL_FAILED' });
    fail = false;
    expect((await post(SEND_CODE, { email })).status).toBe(200);
  });

  test('an unexpected failure from a mailer is still a sentence', async () => {
    const { post } = await start({
      rateLimit: false,
      mailer: { ready: true, send: () => Promise.reject(new Error('boom')) },
    });
    expect((await post(SEND_CODE, { email: anAddress() })).status).toBe(502);
  });

  test('an address sends so many codes an hour, whoever they’re for', async () => {
    const { post } = await start({ mailer: fakeMailer });
    const first = await Promise.all(
      Array.from({ length: 30 }, () => post(SEND_CODE, { email: anAddress() })),
    );
    expect(first.map((r) => r.status)).toEqual(Array(30).fill(200));
    const over = await post(SEND_CODE, { email: anAddress() });
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    // Another address isn't touched, the check and the codes are limited by themselves.
    expect((await post(SEND_CODE, { email: anAddress() }, '203.0.113.10')).status).toBe(200);
  });

  test('new accounts from one address are limited, and signing back in is not', async () => {
    const { post } = await start({ mailer: fakeMailer, accountsPerHour: 1 });
    const email = anAddress();
    await post(SEND_CODE, { email });
    expect((await post(SIGN_IN, { email, otp: lastCode(email) })).status).toBe(200);
    const second = anAddress();
    await post(SEND_CODE, { email: second });
    const refused = await post(SIGN_IN, { email: second, otp: lastCode(second) });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  test('renames are limited', async () => {
    const { running, post } = await start({ mailer: fakeMailer });
    const email = anAddress();
    await post(SEND_CODE, { email });
    const response = await post(SIGN_IN, { email, otp: lastCode(email) });
    const cookie = response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const put = (name: string) =>
      realFetch(new URL('/api/me', running.url), {
        method: 'PUT',
        headers: { origin: ORIGIN, cookie },
        body: JSON.stringify({ name }),
      });
    let last = new Response();
    for (let i = 0; i < 11; i++) {
      // oxlint-disable-next-line no-await-in-loop
      last = await put(`Name${i}`);
    }
    expect(last.status).toBe(429);
  });
});

describe('accounts from before email', () => {
  const path = `${Bun.env.TMPDIR ?? '/tmp'}/leuven-${crypto.randomUUID()}.sqlite`;
  const open = (mailer?: Mailer) =>
    startServer({
      port: 0,
      databasePath: path,
      secret: 'test-secret-test-secret-test-secret',
      baseURL: ORIGIN,
      rateLimit: false,
      quiet: true,
      mailer,
    });
  afterAll(async () => {
    await Promise.all(
      ['', '-wal', '-shm'].map((suffix) =>
        Bun.file(`${path}${suffix}`)
          .delete()
          .catch(() => {}),
      ),
    );
  });

  test('stay, keep their names reserved, and can’t be sent a code', async () => {
    const running = await open(fakeMailer);
    await running.stop();
    const old = new Database(path);
    old.run('ALTER TABLE "user" DROP COLUMN fresh');
    old.run(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, username)
       VALUES ('legacy1', 'Oldie', 'oldie@players.invalid', 1, 0, 0, 'oldie')`,
    );
    old.close();

    const after = await open(fakeMailer);
    try {
      const row = new Database(path)
        .query('SELECT name, fresh FROM "user" WHERE id = ?')
        .get('legacy1') as { name: string; fresh: unknown };
      expect(row.name).toBe('Oldie');
      expect(row.fresh === null || row.fresh === 0).toBe(true);
      const post = (route: string, body: unknown) =>
        realFetch(new URL(route, after.url), {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      const code = await post(SEND_CODE, { email: 'oldie@players.invalid' });
      expect(code.status).toBe(400);
      expect(await code.json()).toMatchObject({ code: 'EMAIL_UNDELIVERABLE' });
      const free = await post('/api/auth/is-username-available', { username: 'OLDIE' });
      expect(await free.json()).toEqual({ available: false });
    } finally {
      await after.stop();
    }
  });
});

describe('accounts', () => {
  const bram = new Jar();

  test('health answers without a session', async () => {
    const response = await call(new Jar(), '/api/health');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      ok: true,
      online: expect.any(Number),
      players: expect.any(Number),
      tickMs: expect.any(Number),
      bytesPerSecond: expect.any(Number),
    });
  });

  test('a guest is someone: the same one on every visit, with a cookie to prove it', async () => {
    const jar = new Jar();
    const me = await as(jar, () => account.me());
    expect(me).toMatchObject({
      guest: true,
      name: expect.stringMatching(/^[A-Z][a-z]+ [A-Z][a-z]+$/),
      at: null,
    });
    expect(await as(jar, () => account.me())).toEqual(me);
    expect(await as(new Jar(), () => account.me())).not.toEqual(me);
    const cookie = (await call(jar, '/api/me')).headers.getSetCookie().join();
    expect(cookie).toMatch(/leuven_guest=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Max-Age=/);
    const put = await call(jar, '/api/me', { method: 'PUT', body: '{}' });
    expect(put.status).toBe(401);
  });

  test('a guest cookie that was forged is another new guest', async () => {
    const jar = new Jar();
    const me = await as(jar, () => account.me());
    const [id] = jar.cookies.get('leuven_guest')!.split('.');
    jar.cookies.set('leuven_guest', `${id}.${'0'.repeat(64)}`);
    expect((await as(jar, () => account.me()))?.name).not.toBe(me?.name);
  });

  test('signing up signs in, with an outfit and no position yet', async () => {
    const me = await joinAs(bram, 'Bram');
    expect(me).toEqual({
      guest: false,
      name: 'Bram',
      outfit: expect.any(Object),
      at: null,
      fresh: false,
      mail: true,
    });
    expect(await as(bram, () => account.me())).toEqual(me);
  });

  test('a name is taken whatever its case', async () => {
    const error = await joinAs(new Jar(), 'bram', 'another-bram@example.com').catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AccountError);
    expect(error).toMatchObject({ code: 'taken', message: 'That name is taken.' });
  });

  test('no password route is left, and only the public auth endpoints are reachable', async () => {
    const closed = await Promise.all(
      [
        '/api/auth/sign-up/email',
        '/api/auth/sign-in/email',
        '/api/auth/sign-in/username',
        '/api/auth/change-password',
        '/api/account',
      ].map((path) =>
        postJson(new Jar(), path, {
          email: 'x@example.com',
          username: 'x',
          password: 'password1',
          name: 'x',
        }),
      ),
    );
    expect(closed.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
    expect((await call(new Jar(), '/api/nothing')).status).toBe(404);
    expect((await call(new Jar(), '/elsewhere')).status).toBe(404);
  });

  test('an outfit must be four colours, and is kept', async () => {
    const jar = new Jar();
    await joinAs(jar, 'outfitter');
    const bad = await call(jar, '/api/me', { method: 'PUT', body: JSON.stringify({ outfit: 1 }) });
    expect(bad.status).toBe(400);
    const outfit = { skin: 1, hair: 2, shirt: 3, shorts: 4 };
    await as(jar, () => account.saveOutfit(outfit));
    expect((await as(jar, () => account.me()))?.outfit).toEqual(outfit);
    expect(as(new Jar(), () => account.saveOutfit(outfit))).rejects.toMatchObject({
      code: 'signed-out',
    });
  });

  test('signing out ends the session; the same socket carries on as the guest', async () => {
    const jar = new Jar();
    const guest = await as(jar, () => account.me());
    await joinAs(jar, 'leaver');
    const socket = new Client(jar);
    await socket.opened;
    socket.send({ x: 50 });
    await wait(50);
    await as(jar, () => account.signOut());
    expect(await as(jar, () => account.me())).toMatchObject({ guest: true, name: guest?.name });
    const identity = await socket.next('identity', (m) => m.guest);
    expect(identity.name).toBe(guest!.name);
    await socket.close();
  });

  test('signing out without a guest cookie makes one', async () => {
    const jar = new Jar();
    await joinAs(jar, 'nocookie');
    jar.cookies.delete('leuven_guest');
    const socket = new Client(jar);
    await socket.opened;
    await as(jar, () => account.signOut());
    expect(jar.cookies.get('leuven_guest')).toBeTruthy();
    await socket.next('identity', (m) => m.guest);
    await socket.close();
  });

  test('signing in over someone else’s session lets their sockets go', async () => {
    const jar = new Jar();
    await joinAs(jar, 'firstone');
    await joinAs(new Jar(), 'secondone');
    const socket = new Client(jar);
    await socket.opened;
    await codeIn(jar, 'secondone@example.com');
    expect((await socket.closed).code).toBe(CLOSE_SIGNED_OUT);
  });
});

describe('presence', () => {
  const ann = new Jar();
  const ben = new Jar();

  beforeAll(async () => {
    await joinAs(ann, 'Ann');
    await joinAs(ben, 'Ben');
  });

  test('a websocket needs an upgrade and our origin', async () => {
    expect((await call(new Jar(), '/ws')).status).toBe(426);
    const response = await realFetch(new URL('/ws', server.url), {
      headers: { origin: 'https://evil.example' },
    });
    expect(response.status).toBe(403);
  });

  test('two players see each other join, move and leave; a guest is seen too', async () => {
    const a = new Client(ann);
    const b = new Client(ben);
    const guest = new Client();
    await Promise.all([a.opened, b.opened, guest.opened]);
    const youA = (await a.next('welcome')).you;
    const youB = (await b.next('welcome')).you;
    expect(youA).toBeGreaterThan(0);
    const youGuest = (await guest.next('welcome')).you;
    expect(youGuest).toBeGreaterThan(0);
    const identity = await guest.next('identity');
    expect(identity).toMatchObject({ guest: true, unseen: false });
    expect(identity.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);

    a.send();
    const joined = await b.next('joins', (m) => m.players.some((p) => p.id === youA));
    expect(joined.players.find((p) => p.id === youA)).toEqual({
      id: youA,
      name: 'Ann',
      outfit: expect.any(Object),
      state: here,
    });
    await guest.next('joins', (m) => m.players.some((p) => p.id === youA));

    b.send({ x: 50 });
    await a.next('joins', (m) => m.players.some((p) => p.id === youB && p.name === 'Ben'));

    a.send({ x: 13, mode: 'bike' });
    const moved = await b.next('moves', (m) => m.players.some((p) => p.id === youA));
    const entry = moved.players.find((p) => p.id === youA)!;
    if ('delta' in entry) throw new Error('its first move should be whole');
    expect(entry.state.x).toBeCloseTo(13, 1);
    expect(entry.state.mode).toBe('bike');

    // A guest walking by is seen by everyone, under the name the server gave them.
    guest.send({ x: 16 });
    const seen = await a.next('joins', (m) => m.players.some((p) => p.id === youGuest));
    expect(seen.players.find((p) => p.id === youGuest)?.name).toBe(identity.name);

    // A new outfit reaches everyone online.
    const outfit = { skin: 5, hair: 6, shirt: 7, shorts: 8 };
    await as(ann, () => account.saveOutfit(outfit));
    expect(await b.next('outfit')).toEqual({ type: 'outfit', id: youA, outfit });

    // While online, /api/me reports where the player is now.
    expect((await as(ann, () => account.me()))?.at).toMatchObject({ x: 13 });

    await a.close();
    expect(await b.next('leaves')).toEqual({ type: 'leaves', ids: [youA] });
    await guest.next('leaves', (m) => m.ids.includes(youA));
    await Promise.all([b.close(), guest.close()]);
  });

  test('where a player left is where they come back', async () => {
    const a = new Client(ann);
    await a.opened;
    a.send({ x: 200, z: -300, place: 'stadhuis', floor: 1 });
    await wait(50);
    await a.close();
    await wait(20);
    expect((await as(ann, () => account.me()))?.at).toMatchObject({
      x: 200,
      z: -300,
      place: 'stadhuis',
      floor: 1,
      speed: 0,
      mode: 'foot',
    });
  });

  test('a second tab shares the first’s figure: both stay', async () => {
    const first = new Client(ann);
    await first.opened;
    const second = new Client(ann);
    await second.opened;
    expect((await second.next('welcome')).you).toBe((await first.next('welcome')).you);
    expect(await second.next('driving')).toEqual({ type: 'driving', on: false });
    await wait(50);
    expect(first.socket.readyState).toBe(WebSocket.OPEN);
    await Promise.all([first.close(), second.close()]);
  });

  test('a guest’s tabs share one figure, the same again after a reload', async () => {
    const jar = new Jar();
    await as(jar, () => account.me());
    const first = new Client(jar);
    await first.opened;
    const second = new Client(jar);
    await second.opened;
    const you = (await first.next('welcome')).you;
    expect((await second.next('welcome')).you).toBe(you);
    const { name } = await first.next('identity');
    first.send({ x: 30 });
    await wait(40);
    expect((await as(jar, () => account.me()))?.at).toMatchObject({ x: 30 });
    await Promise.all([first.close(), second.close()]);
    await wait(20);
    // Left for a moment: still that guest, and where they were.
    const back = new Client(jar);
    await back.opened;
    expect((await back.next('identity')).name).toBe(name);
    expect((await as(jar, () => account.me()))?.at).toMatchObject({ x: 30 });
    await back.close();
  });

  test('a socket with no cookie is given a guest, and the browser the cookie for it', async () => {
    const jar = new Jar();
    const socket = new Client(jar);
    await socket.opened;
    expect(await socket.next('identity')).toMatchObject({ guest: true });
    // Bun's WebSocket client has no cookie jar to look in, so what matters is that it was minted.
    await socket.close();
  });

  test('joining turns the guest into the account, everywhere it is open', async () => {
    const watcher = new Client(ben);
    await watcher.opened;
    const jar = new Jar();
    await as(jar, () => account.me());
    const first = new Client(jar);
    const second = new Client(jar);
    await Promise.all([first.opened, second.opened]);
    const you = (await first.next('welcome')).you;
    first.send({ x: 18 });
    const guestJoin = await watcher.next('joins', (m) => m.players.some((p) => p.id === you));
    const guestOutfit = guestJoin.players.find((p) => p.id === you)!.outfit;

    const me = await joinAs(jar, 'Clara');
    // The new account wears what the guest wore.
    expect(me.outfit).toEqual(guestOutfit);
    expect(await watcher.next('renamed', (m) => m.name === 'Clara')).toEqual({
      type: 'renamed',
      id: you,
      name: 'Clara',
      outfit: guestOutfit,
    });
    await Promise.all(
      [first, second].map((tab) => tab.next('identity', (m) => !m.guest && m.name === 'Clara')),
    );
    expect(watcher.messages.some((m) => m.type === 'leaves')).toBe(false);
    await Promise.all([first.close(), second.close(), watcher.close()]);
  });

  test('signing in is the same: the account’s own look, and the same figure', async () => {
    const watcher = new Client(ann);
    await watcher.opened;
    const jar = new Jar();
    await as(jar, () => account.me());
    const socket = new Client(jar);
    await socket.opened;
    const you = (await socket.next('welcome')).you;
    socket.send({ x: 22 });
    await watcher.next('joins', (m) => m.players.some((p) => p.id === you));
    const me = await codeIn(jar, 'ben@example.com');
    expect(me).toMatchObject({ guest: false, name: 'Ben' });
    const renamed = await watcher.next('renamed');
    expect(renamed).toMatchObject({ id: you, name: 'Ben', outfit: me.outfit });
    await socket.next('identity', (m) => !m.guest);
    await Promise.all([socket.close(), watcher.close()]);
  });

  test('when guests are capped by address, the server asks for the address', async () => {
    const capped = await startServer({
      port: 0,
      databasePath: ':memory:',
      secret: 'test-secret-test-secret-test-secret',
      baseURL: ORIGIN,
      quiet: true,
      tick: 20,
    });
    const url = new URL('/ws', capped.url);
    url.protocol = 'ws:';
    const clients: { socket: WebSocket; opened: Promise<void>; flags: ServerMessage[] }[] = [];
    const open = (address: string, cookie: string) => {
      const headers = { origin: ORIGIN, 'x-real-ip': address, cookie };
      const socket = new WebSocket(url, { headers } as never);
      socket.binaryType = 'arraybuffer';
      const flags: ServerMessage[] = [];
      socket.addEventListener('message', (e) => {
        const message = decodeServerMessage(new Uint8Array(e.data as ArrayBuffer));
        if (message) flags.push(message);
      });
      const opened = new Promise<void>((resolve) =>
        socket.addEventListener('open', () => resolve(), { once: true }),
      );
      clients.push({ socket, opened, flags });
      return flags;
    };
    try {
      // Twelve distinct guests from one address, then one who only watches.
      for (let i = 0; i < 13; i++) open('203.0.113.7', '');
      await Promise.all(clients.map((c) => c.opened));
      await wait(30);
      const unseen = clients.map((c) => c.flags.find((m) => m.type === 'identity'));
      expect(unseen.filter((m) => m?.type === 'identity' && m.unseen)).toHaveLength(1);
      // Another address is not touched.
      const other = open('203.0.113.8', '');
      await clients.at(-1)!.opened;
      await wait(20);
      const flag = other.find((m) => m.type === 'identity');
      expect(flag).toMatchObject({ unseen: false });
    } finally {
      for (const c of clients) c.socket.close();
      await capped.stop();
    }
  });

  test('malformed frames are ignored and the connection carries on', async () => {
    const a = new Client(ann);
    const b = new Client(ben);
    await Promise.all([a.opened, b.opened]);
    const youA = (await a.next('welcome')).you;
    a.socket.send('hello');
    a.socket.send(new Uint8Array([1, 2, 3]));
    a.socket.send(new Uint8Array([200]));
    a.send({ x: 77 });
    const joins = await b.next('joins', (m) => m.players.some((p) => p.id === youA));
    expect(joins.players[0]?.state.x).toBe(77);
    await Promise.all([a.close(), b.close()]);
  });
});

test('an origin pattern may leave the port open, and nothing else', () => {
  expect(originMatches('http://localhost:5173', 'http://localhost:5173')).toBe(true);
  expect(originMatches('http://localhost:5174', 'http://localhost:5173')).toBe(false);
  expect(originMatches('http://localhost:5174', 'http://localhost:*')).toBe(true);
  expect(originMatches('http://localhost:', 'http://localhost:*')).toBe(false);
  expect(originMatches('http://localhost:1.evil.example', 'http://localhost:*')).toBe(false);
  expect(originMatches('http://localhost.evil.example:80', 'http://localhost:*')).toBe(false);
});

test('an address is its own key, an IPv6 one by its /64', () => {
  expect(clientKey(null)).toBe('local');
  expect(clientKey('192.0.2.7')).toBe('192.0.2.7');
  expect(clientKey('2001:db8:aa:bb:1:2:3:4')).toBe('2001:db8:aa:bb');
  expect(clientKey('2001:DB8::1')).toBe('2001:db8:0:0');
  expect(clientKey('2001:0db8:0000:0000::9')).toBe(clientKey('2001:db8::5'));
  expect(clientKey('::1')).toBe('0:0:0:0');
});

describe('limits', () => {
  test('tries at a code from one address are limited, across addresses too', async () => {
    const limited = await startServer({
      port: 0,
      databasePath: ':memory:',
      secret: 'test-secret-test-secret-test-secret',
      baseURL: ORIGIN,
      quiet: true,
    });
    const post = (path: string, body: unknown) =>
      realFetch(new URL(path, limited.url), {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      // Each for another address, so it is only better-auth's limit by address that can say no.
      const answers = await Promise.all(
        Array.from({ length: 11 }, () => post(SIGN_IN, { email: anAddress(), otp: '123456' })),
      );
      expect(answers.map((r) => r.status)).toContain(429);
    } finally {
      await limited.stop();
    }
  });
});
