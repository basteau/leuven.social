import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import * as account from '../src/net/account.ts';
import { AccountError } from '../src/net/account.ts';
import {
  CLOSE_REPLACED,
  decodeServerMessage,
  encodeClientMessage,
  quantise,
} from '../src/net/protocol.ts';
import type { PlayerState, ServerMessage } from '../src/net/protocol.ts';
import { clientKey, originMatches, startServer } from './server.ts';
import { CLOSE_SIGNED_OUT } from './world.ts';
import type { RunningServer } from './server.ts';

const ORIGIN = 'http://localhost:5173';
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

  test('a guest has no account', async () => {
    expect(await as(new Jar(), () => account.me())).toBeNull();
    // Asked plainly, a guest is a null, not a 401 the browser would log as an error.
    const guest = await call(new Jar(), '/api/me');
    expect([guest.status, await guest.json()]).toEqual([200, null]);
    const put = await call(new Jar(), '/api/me', { method: 'PUT', body: '{}' });
    expect(put.status).toBe(401);
  });

  test('signing up signs in, with an outfit and no position yet', async () => {
    const me = await as(bram, () => account.signUp('Bram', 'stadhuis1'));
    expect(me).toEqual({ name: 'Bram', outfit: expect.any(Object), at: null });
    expect(await as(bram, () => account.me())).toEqual(me);
  });

  test('a name is taken whatever its case', async () => {
    const error = await as(new Jar(), () => account.signUp('bram', 'something')).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AccountError);
    expect(error).toMatchObject({ code: 'taken', message: 'That name is taken.' });
  });

  test('a wrong password, then the right one under another case', async () => {
    const jar = new Jar();
    expect(as(jar, () => account.signIn('Bram', 'wrong-one'))).rejects.toMatchObject({
      code: 'credentials',
      message: 'Wrong name or password. Check both and try again.',
    });
    expect(as(jar, () => account.signIn('nobody', 'whatever1'))).rejects.toMatchObject({
      code: 'credentials',
    });
    const me = await as(jar, () => account.signIn('BRAM', 'stadhuis1'));
    expect(me.name).toBe('Bram');
  });

  test('the server checks names and passwords too', async () => {
    const short = await postJson(new Jar(), '/api/account', { username: 'ann', password: 'x' });
    expect(short.status).toBe(400);
    expect(await short.json()).toMatchObject({ code: 'PASSWORD_TOO_SHORT' });
    const bad = await postJson(new Jar(), '/api/account', { username: '.ann', password: 'x' });
    expect(await bad.json()).toMatchObject({ code: 'INVALID_USERNAME' });
    const none = await postJson(new Jar(), '/api/account', { username: 3 });
    expect(none.status).toBe(400);
    const garbage = await call(new Jar(), '/api/account', { method: 'POST', body: '{' });
    expect(garbage.status).toBe(400);
  });

  test('only the public auth endpoints are reachable', async () => {
    const response = await postJson(new Jar(), '/api/auth/sign-up/email', {
      email: 'x@example.com',
      password: 'password1',
      name: 'x',
    });
    expect(response.status).toBe(404);
    expect((await call(new Jar(), '/api/nothing')).status).toBe(404);
    expect((await call(new Jar(), '/elsewhere')).status).toBe(404);
  });

  test('another site cannot post', async () => {
    const response = await realFetch(new URL('/api/account', server.url), {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'evil', password: 'password1' }),
    });
    expect(response.status).toBe(403);
  });

  test('an outfit must be four colours, and is kept', async () => {
    const jar = new Jar();
    await as(jar, () => account.signUp('outfitter', 'password1'));
    const bad = await call(jar, '/api/me', { method: 'PUT', body: JSON.stringify({ outfit: 1 }) });
    expect(bad.status).toBe(400);
    const outfit = { skin: 1, hair: 2, shirt: 3, shorts: 4 };
    await as(jar, () => account.saveOutfit(outfit));
    expect((await as(jar, () => account.me()))?.outfit).toEqual(outfit);
    expect(as(new Jar(), () => account.saveOutfit(outfit))).rejects.toMatchObject({
      code: 'signed-out',
    });
  });

  test('signing out ends the session, and takes the player off the map', async () => {
    const jar = new Jar();
    await as(jar, () => account.signUp('leaver', 'password1'));
    const socket = new Client(jar);
    await socket.opened;
    await as(jar, () => account.signOut());
    expect(await as(jar, () => account.me())).toBeNull();
    expect((await socket.closed).code).toBe(CLOSE_SIGNED_OUT);
  });
});

describe('presence', () => {
  const ann = new Jar();
  const ben = new Jar();

  beforeAll(async () => {
    await as(ann, () => account.signUp('Ann', 'password1'));
    await as(ben, () => account.signUp('Ben', 'password1'));
  });

  test('a websocket needs an upgrade and our origin', async () => {
    expect((await call(new Jar(), '/ws')).status).toBe(426);
    const response = await realFetch(new URL('/ws', server.url), {
      headers: { origin: 'https://evil.example' },
    });
    expect(response.status).toBe(403);
  });

  test('two players see each other join, move and leave; a guest watches unseen', async () => {
    const a = new Client(ann);
    const b = new Client(ben);
    const guest = new Client();
    await Promise.all([a.opened, b.opened, guest.opened]);
    const youA = (await a.next('welcome')).you;
    const youB = (await b.next('welcome')).you;
    expect(youA).toBeGreaterThan(0);
    expect((await guest.next('welcome')).you).toBe(0);

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

    // The guest's own states go nowhere.
    guest.send({ x: 99 });
    await wait(80);
    expect(
      a.messages.flatMap((m) => (m.type === 'joins' ? m.players.map((p) => p.name) : [])),
    ).toEqual(['Ben']);

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

  test('signing in again elsewhere replaces the first connection', async () => {
    const first = new Client(ann);
    await first.opened;
    const second = new Client(ann);
    await second.opened;
    const closed = await first.closed;
    expect(closed.code).toBe(CLOSE_REPLACED);
    await second.close();
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

test('wrong passwords for one name are capped, whoever guesses', async () => {
  await as(new Jar(), () => account.signUp('guessed', 'password1'));
  let last = new Response();
  for (let i = 0; i < 11; i++) {
    // One after another: each wrong guess has to land before the next is weighed.
    // oxlint-disable-next-line no-await-in-loop
    last = await postJson(new Jar(), '/api/auth/sign-in/username', {
      username: 'Guessed',
      password: 'nope-nope',
    });
  }
  expect(last.status).toBe(429);
  expect(((await last.json()) as { message: string }).message).toContain('Too many tries');
  // Another name isn't touched.
  const other = await postJson(new Jar(), '/api/auth/sign-in/username', {
    username: 'someone-else',
    password: 'nope-nope',
  });
  expect(other.status).toBe(401);
});

describe('limits', () => {
  test('sign-ups from one address are limited, and so are sign-ins', async () => {
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
      const statuses = async (path: string, body: unknown) =>
        (await Promise.all(Array.from({ length: 11 }, () => post(path, body))))
          .map((r) => r.status)
          .toSorted();
      // Failed sign-ups (a taken name, a bad one) don't count against the address.
      expect(await statuses('/api/account', { username: '!' })).toEqual(Array(11).fill(400));

      const body = { username: 'nobody', password: 'whatever1' };
      expect(await statuses('/api/auth/sign-in/username', body)).toContain(429);
    } finally {
      await limited.stop();
    }
  });
});
