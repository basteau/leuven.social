/**
 * The multiplayer server: accounts over HTTP and presence over one WebSocket, in one Bun
 * process with one SQLite file. main.ts reads the environment and calls `startServer`; the
 * tests call it directly on port 0 with a database in memory.
 *
 *   /api/auth/*      better-auth, only the paths in PUBLIC_AUTH_PATHS
 *   POST /api/account  sign up with { username, password }, signed in on success
 *   GET  /api/me       { name, outfit, at }, or null for a guest (not an error: browsers log those)
 *   PUT  /api/me       { outfit }: keeps it and tells everyone online
 *   GET  /api/health   { ok, online }
 *   /ws                presence (world.ts); the session cookie decides player or guest
 */

import { Database } from 'bun:sqlite';
import * as Log from '@portable/log';
import * as RateLimit from '@portable/rate-limit';
import { APIError } from 'better-auth';

import { isOutfit } from '../src/net/protocol.ts';
import { isUsername } from '../src/net/rules.ts';
import { PUBLIC_AUTH_PATHS, createAuth, migrateAuth, syntheticEmail } from './auth.ts';
import type { AuthConfig } from './auth.ts';
import { randomOutfit } from './outfit.ts';
import { createStore } from './store.ts';
import { createWorld } from './world.ts';
import type { Account, World } from './world.ts';

/** A rate limit's key for an address: an IPv6 one by its /64, which one machine can roam. */
export function clientKey(ip: string | null): string {
  if (!ip) return 'local';
  if (!ip.includes(':')) return ip;
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
  /** Per-IP limits on signing up and in. Off only in tests. */
  rateLimit?: boolean;
  /** Keeps better-auth's warnings (a wrong password, say) out of the output, for tests. */
  quiet?: boolean;
  /** Presence tick (ms) and how often a moving player's position is saved (ms). */
  tick?: number;
  saveEvery?: number;
}

export interface RunningServer {
  url: URL;
  world: World;
  /** Saves everyone online, closes every connection and the database. */
  stop(): Promise<void>;
}

interface SocketData {
  account: Account | null;
  id: number;
}

const API_HEADERS = { 'cache-control': 'no-store' };

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

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: API_HEADERS });

/** An error in better-auth's shape, so the client reads every failure the same way. */
const problem = (status: number, code: string, message: string) => json({ code, message }, status);

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
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
  };
  await migrateAuth(authConfig);
  const auth = createAuth(authConfig);
  const store = createStore(db);
  const world = createWorld({
    save: (userId, state) => store.savePosition(userId, state),
    saveEvery: config.saveEvery,
  });
  // (A `take` of cost 0 reads what's left: it is always "allowed", so `remaining` is the test.)
  // better-auth limits its own routes by address; sign-up goes through auth.api, which it doesn't
  // limit. Only accounts made count: a campus shares a handful of addresses, and a name taken is
  // no abuse. Failed sign-ins count per name too, so many addresses can't guess one password.
  const signUps = RateLimit.create({ limit: 30, period: 60 * 60 * 1000 });
  const wrongPasswords = RateLimit.create({ limit: 10, period: 15 * 60 * 1000 });
  const origins = [new URL(config.baseURL).origin, ...(config.trustedOrigins ?? [])];

  /** A browser always says where a request came from; one from another site is refused. */
  const fromUs = (request: Request) => {
    const origin = request.headers.get('origin');
    return origin === null || origins.some((pattern) => originMatches(origin, pattern));
  };

  const session = (request: Request) => auth.api.getSession({ headers: request.headers });

  async function signUp(request: Request): Promise<Response> {
    const ip = clientKey(request.headers.get('x-real-ip'));
    if (config.rateLimit !== false && (await signUps.take(ip, { cost: 0 })).remaining < 1) {
      return problem(429, 'TOO_MANY_REQUESTS', 'Too many accounts from here; try again later.');
    }
    const body = await readJson(request);
    const username = body?.username;
    const password = body?.password;
    if (typeof username !== 'string' || typeof password !== 'string') {
      return problem(400, 'VALIDATION_ERROR', 'Send a username and a password.');
    }
    if (!isUsername(username)) return problem(400, 'INVALID_USERNAME', 'Username is invalid');
    try {
      const response = await auth.api.signUpEmail({
        body: { email: syntheticEmail(username), password, name: username, username },
        headers: request.headers,
        asResponse: true,
      });
      response.headers.set('cache-control', 'no-store');
      if (response.ok) {
        log.info('new player %s', username);
        if (config.rateLimit !== false) await signUps.take(ip);
      }
      return response;
    } catch (error) {
      // The username plugin's checks throw even with asResponse.
      if (error instanceof APIError) return json(error.body, error.statusCode);
      throw error;
    }
  }

  /**
   * better-auth's own routes, with two things it doesn't do: a cap on wrong passwords per name,
   * and a player whose session ends (signing out, a new password) taken off the map, so no socket
   * walks on as them. Their other devices reconnect with their own sessions.
   */
  async function authRoute(path: string, request: Request): Promise<Response> {
    let name = '';
    // Always on, unlike the limits by address: it guards an account, and is never noise.
    if (path === '/sign-in/username') {
      const body = (await readJson(request.clone())) as { username?: unknown } | null;
      name = typeof body?.username === 'string' ? body.username.toLowerCase() : '';
      if (name && (await wrongPasswords.take(name, { cost: 0 })).remaining < 1) {
        return problem(429, 'TOO_MANY_REQUESTS', 'Too many tries. Wait a while, then try again.');
      }
    }
    const ending = path === '/sign-out' || path === '/change-password';
    const before = ending ? await session(request) : null;
    const response = await auth.handler(request);
    response.headers.set('cache-control', 'no-store');
    if (name && response.status === 401) await wrongPasswords.take(name);
    if (before && response.ok) world.drop(before.user.id);
    return response;
  }

  async function me(request: Request): Promise<Response> {
    const current = await session(request);
    // A guest asking who they are is no error, and a 401 would be logged in their console.
    if (!current) {
      return request.method === 'GET' ? json(null) : problem(401, 'UNAUTHORIZED', 'Not signed in');
    }
    const userId = current.user.id;
    if (request.method === 'PUT') {
      const outfit = (await readJson(request))?.outfit;
      if (!isOutfit(outfit)) return problem(400, 'INVALID_OUTFIT', 'Send four 24-bit colours.');
      store.player(userId, () => outfit);
      store.saveOutfit(userId, outfit);
      world.setOutfit(userId, outfit);
      return json({ outfit });
    }
    const record = store.player(userId, randomOutfit);
    return json({
      name: current.user.name,
      outfit: record.outfit,
      at: world.stateOf(userId) ?? record.at,
    });
  }

  async function route(
    original: Request,
    server: Bun.Server<SocketData>,
  ): Promise<Response | undefined> {
    const { pathname } = new URL(original.url);
    // Only the request Bun handed us can be upgraded, so the copy is for the API alone.
    const request = pathname === '/ws' ? original : withClientIp(original, server);
    const method = request.method;

    if (pathname === '/ws') {
      if (!fromUs(request)) return new Response('Forbidden', { status: 403 });
      const current = await session(request);
      const account = current
        ? {
            userId: current.user.id,
            name: current.user.name,
            outfit: store.player(current.user.id, randomOutfit).outfit,
          }
        : null;
      // Bun answers an upgraded request itself.
      if (server.upgrade(request, { data: { account, id: 0 } })) return undefined;
      return new Response('Expected a WebSocket', { status: 426 });
    }

    if (!pathname.startsWith('/api/')) return new Response('Not Found', { status: 404 });
    if (method !== 'GET' && method !== 'HEAD' && !fromUs(request)) {
      return problem(403, 'INVALID_ORIGIN', 'Invalid origin');
    }

    if (pathname.startsWith('/api/auth/')) {
      if (!PUBLIC_AUTH_PATHS.has(pathname.slice('/api/auth'.length))) {
        return problem(404, 'NOT_FOUND', 'Not found');
      }
      return authRoute(pathname.slice('/api/auth'.length), request);
    }
    if (pathname === '/api/health' && method === 'GET')
      return json({ ok: true, online: world.size });
    if (pathname === '/api/account' && method === 'POST') return signUp(request);
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
      // A reader too slow to keep up is closed rather than skipped: skipped, it would miss joins
      // and leaves for good; closed, its client reconnects to everyone as they are.
      closeOnBackpressureLimit: true,
      open(ws) {
        ws.data.id = world.connect(
          {
            send: (frame) => void ws.sendBinary(frame),
            close: (code, reason) => ws.close(code, reason),
          },
          ws.data.account,
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

  const ticker = setInterval(() => world.tick(), config.tick ?? 100);
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
