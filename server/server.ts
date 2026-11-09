/**
 * The multiplayer server: accounts over HTTP and presence over one WebSocket, in one Bun
 * process with one SQLite file. main.ts reads the environment and calls `startServer`; the
 * tests call it directly on port 0 with a database in memory.
 *
 *   /api/auth/*      better-auth, only the paths in PUBLIC_AUTH_PATHS
 *   POST /api/auth/email-otp/send-verification-otp   { email }: mails a sign-in code
 *   POST /api/auth/sign-in/email-otp                 { email, otp }: signs in or makes the account
 *   GET  /api/me       { guest, name, outfit, at, fresh }: an account, or this browser's guest
 *   PUT  /api/me       { outfit } or { name }: keeps it and tells everyone online
 *   GET  /api/health   { ok, online, players, tickMs, tickMaxMs, bytesPerSecond }
 *   /ws                presence (world.ts); the session cookie decides the account, else the guest
 */

import { Database } from 'bun:sqlite';
import * as Log from '@portable/log';
import * as RateLimit from '@portable/rate-limit';
import { APIError } from 'better-auth';

import { isOutfit } from '../src/net/protocol.ts';
import {
  CODE_COOLDOWN_SECONDS,
  CODE_LENGTH,
  isEmail,
  isReservedName,
  isUsername,
  mailbox,
  normaliseEmail,
} from '../src/net/rules.ts';
import {
  PUBLIC_AUTH_PATHS,
  SEND_CODE_PATH,
  NAME_FREE_PATH,
  SIGN_IN_PATH,
  createAuth,
  migrateAuth,
} from './auth.ts';
import type { AuthConfig, NewUser } from './auth.ts';
import { createGuests, guestAccount, guestKey, guestName } from './guest.ts';
import { MailError } from './mail.ts';
import type { Mailer } from './mail.ts';
import { randomOutfit } from './outfit.ts';
import { createStore } from './store.ts';
import { createWorld } from './world.ts';
import type { Account, World } from './world.ts';

/** A rate limit's key for an address: an IPv6 one by its /64, which one machine can roam. */
export function clientKey(ip: string | null): string {
  if (!ip) return 'local';
  if (!ip.includes(':')) return ip;
  // An IPv4 address a dual-stack socket wrote as IPv6 is that IPv4 address, not a shared /64.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return mapped;
  // Expand '::' to its zero groups first, so 2001:db8::1 and 2001:db8:0:0:… share a key.
  const [head = '', tail] = ip.split('::');
  const groups = head ? head.split(':') : [];
  if (tail !== undefined) {
    const rest = tail ? tail.split(':') : [];
    groups.push(...Array.from({ length: 8 - groups.length - rest.length }, () => '0'), ...rest);
  }
  return groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, '').toLowerCase())
    .join(':');
}

const log = Log.create('leuven:server');

export interface ServerConfig {
  /** 0 picks a free port. */
  port: number;
  hostname?: string;
  /** A file, or `:memory:`. */
  databasePath: string;
  secret: string;
  baseURL: string;
  trustedOrigins?: string[];
  /** Per-IP limits on signing in and the like. Off only in tests. */
  rateLimit?: boolean;
  /** Keeps better-auth's warnings out of the output, for tests. */
  quiet?: boolean;
  /** Presence tick (ms) and how often a moving player's position is saved (ms). */
  tick?: number;
  saveEvery?: number;
  /** Where sign-in codes go. Without one, none can be sent. */
  mailer: Mailer;
  /** How many accounts one address may make in an hour. */
  accountsPerHour?: number;
  /** Sign-in codes the whole server mails in an hour, for tests. */
  codesPerHour?: number;
  /** The rate limits' clock (ms), for tests. */
  now?: () => number;
}

export interface RunningServer {
  url: URL;
  world: World;
  /** Saves everyone online, closes every connection and the database. */
  stop(): Promise<void>;
}

interface SocketData {
  account: Account;
  session: string | null;
  address: string;
  id: number;
}

const API_HEADERS = { 'cache-control': 'no-store' };
/** The 100 ms of a presence tick are spread over this many, so no single one blocks the server. */
const SLICES = 2;
/**
 * Guests one address can have on the map; the rest watch, unseen, until there's room or they join.
 * nginx allows 16 sockets an address already (docs/DEPLOY.md), so this leaves a shared address
 * room to walk about without letting one script fill the streets.
 */
const GUESTS_PER_ADDRESS = 12;
const HOUR = 60 * 60 * 1000;
/** The most codes that are mailed from one address in an hour: a campus shares a few. */
const CODES_PER_ADDRESS = 30;
/** Allowed tries are per code: the cap below is per person, across codes and addresses. */
const WRONG_CODES = { limit: 10, period: 15 * 60 * 1000 };

/**
 * better-auth limits sign-ins per IP from `x-real-ip`. nginx sets it in production; the server
 * only listens on 127.0.0.1 behind it. Without nginx (dev, tests) the socket's address stands in.
 */
function withClientIp(request: Request, server: Bun.Server<SocketData>): Request {
  if (request.headers.has('x-real-ip')) return request;
  const address = server.requestIP(request)?.address;
  if (!address) return request;
  const headers = new Headers(request.headers);
  headers.set('x-real-ip', address);
  return new Request(request, { headers });
}

/**
 * An exact origin, or one with any port when the pattern ends in `:*` (as better-auth reads
 * its `trustedOrigins`), for a dev server that had to move off its usual port.
 */
export function originMatches(origin: string, pattern: string): boolean {
  if (!pattern.endsWith(':*')) return origin === pattern;
  const prefix = pattern.slice(0, -1);
  return origin.startsWith(prefix) && /^\d+$/.test(origin.slice(prefix.length));
}

/** What a queue is left holding: the waiting matters, not how it went. */
const settled = () => undefined;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: API_HEADERS });

/** An error in better-auth's shape, so the client reads every failure the same way. */
const problem = (status: number, code: string, message: string) => json({ code, message }, status);

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
}

/** A body's address as we compare them, or '' for one that has none. */
const emailIn = (body: Record<string, unknown> | null) =>
  typeof body?.email === 'string' ? normaliseEmail(body.email) : '';

/** Whether nothing is left under `key`: a `take` of cost 0 is always "allowed", and only reads. */
const spent = async (limiter: RateLimit.Limiter, key: string, now: Date) =>
  (await limiter.take(key, { cost: 0, now })).remaining < 1;

/** Hands back what a `take` cost, for something that turned out not to count. */
const giveBack = (limiter: RateLimit.Limiter, key: string, now: Date) =>
  limiter.take(key, { cost: -1, now });

/** The same request with another body: only what we checked gets through to better-auth. */
function withBody(request: Request, body: unknown): Request {
  const headers = new Headers(request.headers);
  headers.set('content-type', 'application/json');
  headers.delete('content-length');
  return new Request(request.url, { method: 'POST', headers, body: JSON.stringify(body) });
}

/** A send that failed, as the sentence it should become: a bad address is theirs to fix. */
function mailProblem(error: unknown): Response {
  const kind = error instanceof MailError ? error.kind : 'failed';
  if (kind === 'recipient') {
    return problem(400, 'EMAIL_UNDELIVERABLE', 'That address can’t receive mail.');
  }
  if (kind === 'busy') return problem(503, 'MAIL_BUSY', 'Too many emails just now.');
  return problem(502, 'MAIL_FAILED', 'Couldn’t send the email.');
}

/** better-auth knows who holds a name, not which are kept back: the sheet must say so too. */
async function asksForReservedName(request: Request): Promise<boolean> {
  const name = (await readJson(request.clone()))?.username;
  return typeof name === 'string' && isReservedName(name);
}

export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const db = new Database(config.databasePath, { create: true, strict: true });
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA busy_timeout = 5000');
  const authConfig: AuthConfig = {
    db,
    secret: config.secret,
    baseURL: config.baseURL,
    trustedOrigins: config.trustedOrigins,
    rateLimit: config.rateLimit,
    quiet: config.quiet,
    newUser,
  };
  await migrateAuth(authConfig);
  const auth = createAuth(authConfig);
  const store = createStore(db);
  const { mailer } = config;
  const limited = config.rateLimit !== false;
  const base = new URL(config.baseURL);
  const ownerOf = db.query<{ id: string }, [string]>('SELECT id FROM "user" WHERE username = ?');
  const world = createWorld({
    save: (saves) => store.savePositions(saves),
    saveEvery: config.saveEvery,
    slices: SLICES,
    guestsPerAddress: limited ? GUESTS_PER_ADDRESS : undefined,
  });
  const guests = createGuests(config.secret, base.protocol === 'https:');
  // Only accounts made count against an address: a campus shares a handful.
  const newAccounts = RateLimit.create({ limit: config.accountsPerHour ?? 30, period: HOUR });
  // A mail for every address costs us and annoys them: at most one every half a minute, five an
  // hour, whoever asks. Always on, unlike the limits by address: it guards an account.
  const codeWait = RateLimit.create({ limit: 1, period: CODE_COOLDOWN_SECONDS * 1000 });
  const codesAnHour = RateLimit.create({ limit: 5, period: HOUR });
  const codesFromAddress = RateLimit.create({ limit: CODES_PER_ADDRESS, period: HOUR });
  // A provider's quota is one pot: a crowd of addresses mustn't empty it for everyone else.
  const codesEverywhere = RateLimit.create({ limit: config.codesPerHour ?? 200, period: HOUR });
  const wrongCodes = RateLimit.create(WRONG_CODES);
  const renames = RateLimit.create({ limit: 10, period: 60 * 1000 });
  const at = () => new Date((config.now ?? Date.now)());
  const origins = [base.origin, ...(config.trustedOrigins ?? [])];

  /**
   * Anything that hands out a name goes through one at a time: checking it's free and taking it
   * are separate steps, and two new accounts a millisecond apart mustn't both find the same one free.
   */
  let claiming: Promise<unknown> = Promise.resolve();
  function inTurn<T>(run: () => Promise<T>): Promise<T> {
    const result = claiming.then(run, run);
    claiming = result.then(settled, settled);
    return result;
  }

  /** What a new account is called: this browser's guest, joined up, with a number if taken. */
  async function newUser(headers: Headers | undefined): Promise<NewUser> {
    if (limited) {
      const ip = clientKey(headers?.get('x-real-ip') ?? null);
      if (!(await newAccounts.take(ip, { now: at() })).allowed) {
        // The code is spent by now, so the person is told to ask for another later.
        throw new APIError('TOO_MANY_REQUESTS', {
          code: 'TOO_MANY_ACCOUNTS',
          message: 'Too many new accounts from here. Try again later.',
        });
      }
    }
    const guestId = headers ? await guests.read({ headers }) : null;
    const words = guestName(guestId ?? guests.mint()).replaceAll(' ', '');
    let name = words;
    for (let n = 2; ownerOf.get(name.toLowerCase()); n++) name = `${words}${n}`;
    log.info('new player %s', name);
    return { name, username: name.toLowerCase(), fresh: true };
  }

  /** A browser always says where a request came from; one from another site is refused. */
  const fromUs = (request: Request) => {
    const origin = request.headers.get('origin');
    return origin === null || origins.some((pattern) => originMatches(origin, pattern));
  };

  const session = (request: Request) => auth.api.getSession({ headers: request.headers });

  /** better-auth's answer, which no browser or proxy should keep. */
  async function authAnswer(request: Request): Promise<Response> {
    const response = await auth.handler(request);
    response.headers.set('cache-control', 'no-store');
    return response;
  }

  /**
   * A guest's tabs carry on as the account they just signed into or made: their figure and sockets
   * stay, with the new name. A new account wears the look the guest had.
   */
  async function becomePlayer(guestId: string | null, response: Response): Promise<void> {
    if (!guestId) return;
    const body = (await response.clone().json()) as {
      token: string;
      user: { id: string; name: string };
    };
    const { outfit } = store.player(body.user.id, () => guestAccount(guestId).outfit);
    world.signedIn(
      guestKey(guestId),
      { userId: body.user.id, name: body.user.name, outfit },
      body.token,
    );
  }

  /** Takes what a code costs from every limit on it, or answers with the one that refuses it. */
  async function spendOnCode(ip: string, box: string, now: Date): Promise<Response | null> {
    if (limited && (await spent(codesFromAddress, ip, now))) {
      return problem(429, 'TOO_MANY_CODES', 'Too many codes from here. Try again later.');
    }
    if (limited && (await spent(codesEverywhere, 'all', now))) {
      return problem(429, 'TOO_MANY_CODES', 'Too many codes just now. Try again later.');
    }
    const wait = await codeWait.take(box, { now });
    if (!wait.allowed) {
      return json(
        {
          code: 'CODE_ALREADY_SENT',
          message: 'A code is on its way.',
          retryAfter: Math.ceil(wait.retryAfter / 1000),
        },
        429,
      );
    }
    if (!(await codesAnHour.take(box, { now })).allowed) {
      await giveBack(codeWait, box, now);
      return problem(429, 'TOO_MANY_CODES', 'Too many codes for this address. Try again later.');
    }
    if (limited) {
      await codesFromAddress.take(ip, { now });
      await codesEverywhere.take('all', { now });
    }
    return null;
  }

  /**
   * Mails a sign-in code. The same answer whether or not the address has an account, and the same
   * steps too: nothing looks it up. better-auth's own endpoint for this swallows a failed send, and
   * a mail that didn't go must say so, so the code is made here and sent here.
   */
  async function sendCode(request: Request): Promise<Response> {
    const email = emailIn(await readJson(request));
    if (!isEmail(email)) return problem(400, 'INVALID_EMAIL', 'Enter an email address.');
    // Accounts from before email have no mailbox behind them; docs/MULTIPLAYER.md says what next.
    if (email.endsWith('.invalid')) {
      return problem(400, 'EMAIL_UNDELIVERABLE', 'That address can’t receive mail.');
    }
    const box = mailbox(email);
    const now = at();
    const refused = await spendOnCode(clientKey(request.headers.get('x-real-ip')), box, now);
    if (refused) return refused;
    try {
      const code = await auth.api.createVerificationOTP({ body: { email, type: 'sign-in' } });
      await mailer.send(email, code);
    } catch (error) {
      // Our failure, not theirs: it doesn't count against the mailbox. The sender's and the
      // server's limits stay spent, or a refused address would be an unlimited call to the provider.
      await giveBack(codeWait, box, now);
      await giveBack(codesAnHour, box, now);
      log.warn('a sign-in code didn’t go out: %s', error instanceof Error ? error.message : error);
      return mailProblem(error);
    }
    return json({ success: true });
  }

  /** Signs in with a code, making the account if this address has none. */
  async function signInWithCode(request: Request): Promise<Response> {
    const body = await readJson(request);
    const email = emailIn(body);
    const otp = typeof body?.otp === 'string' ? body.otp : '';
    if (!isEmail(email) || otp.length !== CODE_LENGTH || /\D/.test(otp)) {
      return problem(400, 'INVALID_OTP', 'That code isn’t right.');
    }
    // Always on, unlike the limits by address: it guards an account, and is never noise.
    // By email and address together: by email alone, anyone could keep its owner locked out with
    // a few wrong guesses. Guessing across addresses stays bounded by the five tries a code gets
    // and the codes a mailbox can be sent.
    const guesser = `${email}|${clientKey(request.headers.get('x-real-ip'))}`;
    if (await spent(wrongCodes, guesser, at())) {
      return problem(429, 'TOO_MANY_GUESSES', 'Too many tries. Wait a while, then try again.');
    }
    const before = await session(request);
    const guestId = await guests.read(request);
    const response = await inTurn(() => authAnswer(withBody(request, { email, otp })));
    if (!response.ok) {
      if (response.status === 400 || response.status === 403) {
        await wrongCodes.take(guesser, { now: at() });
      }
      return response;
    }
    // Signing in over someone else's session: their sockets reconnect as whoever they now are.
    if (before) world.drop(before.user.id);
    await becomePlayer(guestId, response);
    return response;
  }

  /**
   * better-auth's own routes, with the map kept in step: signing in turns the guest into the
   * player, and signing out turns them back.
   */
  async function authRoute(path: string, request: Request): Promise<Response> {
    if (path === SEND_CODE_PATH) return sendCode(request);
    if (path === SIGN_IN_PATH) return signInWithCode(request);
    if (path === NAME_FREE_PATH && (await asksForReservedName(request))) {
      return json({ available: false });
    }
    const before = path === '/sign-out' ? await session(request) : null;
    const guestId = await guests.read(request);
    const response = await authAnswer(request);
    if (!response.ok || !before) return response;
    const id = guestId ?? guests.mint();
    if (!guestId) response.headers.append('set-cookie', await guests.cookie(id));
    world.signedOut(before.user.id, before.session.token, guestAccount(id));
    return response;
  }

  /** A guest's own view of themselves; every visit renews the cookie, so one ends a month on. */
  async function guestMe(request: Request): Promise<Response> {
    const id = (await guests.read(request)) ?? guests.mint();
    const guest = guestAccount(id);
    const reply = json({
      guest: true,
      name: world.who(guest.userId)?.name ?? guest.name,
      outfit: guest.outfit,
      at: world.stateOf(guest.userId),
    });
    reply.headers.append('set-cookie', await guests.cookie(id));
    return reply;
  }

  /** A signed-in player keeps a new name or look, and everyone online hears of it. */
  async function changeMe(userId: string, request: Request): Promise<Response> {
    const body = await readJson(request);
    if (typeof body?.name === 'string') return rename(userId, body.name);
    const outfit = body?.outfit;
    if (!isOutfit(outfit)) return problem(400, 'INVALID_OUTFIT', 'Send four 24-bit colours.');
    store.player(userId, () => outfit);
    store.saveOutfit(userId, outfit);
    world.setOutfit(userId, outfit);
    return json({ outfit });
  }

  async function me(request: Request): Promise<Response> {
    const current = await session(request);
    if (!current) {
      if (request.method !== 'GET') return problem(401, 'UNAUTHORIZED', 'Not signed in');
      return guestMe(request);
    }
    const userId = current.user.id;
    if (request.method === 'PUT') return changeMe(userId, request);
    const record = store.player(userId, randomOutfit);
    return json({
      guest: false,
      name: current.user.name,
      outfit: record.outfit,
      at: world.stateOf(userId) ?? record.at,
      fresh: Boolean(current.user.fresh),
    });
  }

  /** Takes a new name, if it's free, and tells everyone who can see them. */
  async function rename(userId: string, name: string): Promise<Response> {
    if (!isUsername(name)) return problem(400, 'INVALID_USERNAME', 'That name won’t do.');
    if (isReservedName(name))
      return problem(400, 'USERNAME_IS_ALREADY_TAKEN', 'That name is taken.');
    if (limited && !(await renames.take(userId, { now: at() })).allowed) {
      return problem(429, 'TOO_MANY_REQUESTS', 'Too many changes. Wait a minute, then try again.');
    }
    const username = name.toLowerCase();
    const free = await inTurn(async () => {
      const owner = ownerOf.get(username)?.id;
      if (owner && owner !== userId) return false;
      const { internalAdapter } = await auth.$context;
      // Only `name` when it's the same username in another case: it is already theirs.
      await internalAdapter.updateUser(
        userId,
        owner ? { name, fresh: false } : { name, username, fresh: false },
      );
      return true;
    });
    if (!free) return problem(400, 'USERNAME_IS_ALREADY_TAKEN', 'That name is taken.');
    world.setName(userId, name);
    return json({ name });
  }

  /**
   * Upgrades to the presence socket: the session cookie says which account it speaks for, and
   * without one it is this browser's guest, made here if new.
   */
  async function openSocket(
    request: Request,
    server: Bun.Server<SocketData>,
  ): Promise<Response | undefined> {
    if (!fromUs(request)) return new Response('Forbidden', { status: 403 });
    const current = await session(request);
    const address = clientKey(
      request.headers.get('x-real-ip') ?? server.requestIP(request)?.address ?? null,
    );
    const headers = new Headers();
    let account: Account;
    if (current) {
      account = {
        userId: current.user.id,
        name: current.user.name,
        outfit: store.player(current.user.id, randomOutfit).outfit,
      };
    } else {
      let guestId = await guests.read(request);
      if (!guestId) {
        guestId = guests.mint();
        headers.append('set-cookie', await guests.cookie(guestId));
      }
      account = guestAccount(guestId);
    }
    const data = { account, session: current?.session.token ?? null, address, id: 0 };
    // Bun answers an upgraded request itself.
    if (server.upgrade(request, { data, headers })) return undefined;
    return new Response('Expected a WebSocket', { status: 426 });
  }

  async function route(
    original: Request,
    server: Bun.Server<SocketData>,
  ): Promise<Response | undefined> {
    const { pathname } = new URL(original.url);
    // Only the request Bun handed us can be upgraded, so the copy is for the API alone.
    if (pathname === '/ws') return openSocket(original, server);
    const request = withClientIp(original, server);
    const method = request.method;

    if (!pathname.startsWith('/api/')) return new Response('Not Found', { status: 404 });
    if (method !== 'GET' && method !== 'HEAD' && !fromUs(request)) {
      return problem(403, 'INVALID_ORIGIN', 'Invalid origin');
    }

    if (pathname.startsWith('/api/auth/')) {
      const path = pathname.slice('/api/auth'.length);
      if (!PUBLIC_AUTH_PATHS.has(path)) return problem(404, 'NOT_FOUND', 'Not found');
      return authRoute(path, request);
    }
    if (pathname === '/api/health' && method === 'GET') return json({ ok: true, ...world.stats() });
    if (pathname === '/api/me' && (method === 'GET' || method === 'PUT')) return me(request);
    return problem(404, 'NOT_FOUND', 'Not found');
  }

  const server = Bun.serve<SocketData>({
    port: config.port,
    hostname: config.hostname ?? '127.0.0.1',
    async fetch(request, bun) {
      try {
        return await route(request, bun);
      } catch (error) {
        log.error(error);
        return problem(500, 'INTERNAL_SERVER_ERROR', 'Something went wrong');
      }
    },
    websocket: {
      // A state is about 30 bytes; anything much larger is not ours.
      maxPayloadLength: 1024,
      // The client says something at least every few seconds (throttle.ts's heartbeat).
      idleTimeout: 60,
      // The hub stops sending to a socket long before this (broadcast.ts, it recounts it when it
      // catches up): whoever is still this far behind has stopped reading.
      backpressureLimit: 1024 * 1024,
      closeOnBackpressureLimit: true,
      open(ws) {
        ws.data.id = world.connect(
          {
            send: (frame) => ws.sendBinary(frame),
            close: (code, reason) => ws.close(code, reason),
            buffered: () => ws.getBufferedAmount(),
          },
          ws.data.account,
          { session: ws.data.session, address: ws.data.address },
        );
      },
      message(ws, message) {
        void world.receive(ws.data.id, message);
      },
      close(ws) {
        world.disconnect(ws.data.id);
      },
    },
  });

  const ticker = setInterval(() => world.tick(), (config.tick ?? 100) / SLICES);
  const url = new URL(`http://${server.hostname}:${server.port}/`);
  log.info('listening on %s', url.href);

  return {
    url,
    world,
    async stop() {
      clearInterval(ticker);
      world.flush();
      await server.stop(true);
      db.close();
    },
  };
}
