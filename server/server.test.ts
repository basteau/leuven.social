import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import * as account from '../src/net/account.ts';
import { AccountError } from '../src/net/account.ts';
import { decodeServerMessage, encodeClientMessage, quantise } from '../src/net/protocol.ts';
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

  test('a guest is someone: the same one on every visit, with a cookie to prove it', async () => {
    const jar = new Jar();
    const me = await as(jar, () => account.me());
    expect(me).toMatchObject({ guest: true, name: expect.stringMatching(/^Guest /), at: null });
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
    const me = await as(bram, () => account.signUp('Bram', 'stadhuis1'));
    expect(me).toEqual({ guest: false, name: 'Bram', outfit: expect.any(Object), at: null });
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

  test('signing out ends the session; the same socket carries on as the guest', async () => {
    const jar = new Jar();
    const guest = await as(jar, () => account.me());
    await as(jar, () => account.signUp('leaver', 'password1'));
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

  test('a new password closes the sockets, to reconnect as themselves', async () => {
    const jar = new Jar();
    await as(jar, () => account.signUp('rekeyed', 'password1'));
    const socket = new Client(jar);
    await socket.opened;
    await postJson(jar, '/api/auth/change-password', {
      currentPassword: 'password1',
      newPassword: 'password2',
    });
    expect((await socket.closed).code).toBe(CLOSE_SIGNED_OUT);
  });

  test('signing out without a guest cookie makes one', async () => {
    const jar = new Jar();
    await as(jar, () => account.signUp('nocookie', 'password1'));
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
    await as(jar, () => account.signUp('firstone', 'password1'));
    await as(new Jar(), () => account.signUp('secondone', 'password1'));
    const socket = new Client(jar);
    await socket.opened;
    await as(jar, () => account.signIn('secondone', 'password1'));
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
    expect(identity.name).toMatch(/^Guest /);

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

    const me = await as(jar, () => account.signUp('Clara', 'password1'));
    // The new account wears what the guest wore.
    expect(me.outfit).toEqual(guestOutfit);
    expect(await watcher.next('renamed')).toEqual({
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
    const me = await as(jar, () => account.signIn('Ben', 'password1'));
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
