/**
 * Accounts with better-auth: a username and a password, sessions in a cookie, everything in our
 * own SQLite file. better-auth wants an email for each account; players have none, so each one
 * is filed under `<name>@players.invalid` (a domain that can never receive mail) and signs in
 * by name through the username plugin.
 */

import type { Database } from 'bun:sqlite';
import { betterAuth } from 'better-auth';
import type { BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { username } from 'better-auth/plugins/username';

import { MAX_NAME, MAX_PASSWORD, MIN_NAME, MIN_PASSWORD, isUsername } from '../src/net/rules.ts';

/** Signed in for 60 days, renewed once a day of play: a game, not a bank. */
const DAY = 60 * 60 * 24;
const SESSION = { expiresIn: 60 * DAY, updateAge: DAY };

/** The few endpoints the browser may call; the rest of better-auth stays server-side. */
export const PUBLIC_AUTH_PATHS: ReadonlySet<string> = new Set([
  '/sign-in/username',
  '/sign-out',
  '/get-session',
  '/change-password',
  '/is-username-available',
]);

export interface AuthConfig {
  db: Database;
  secret: string;
  /** Where the site is served, such as https://leuven.exe.xyz. */
  baseURL: string;
  /** Origins allowed to post with the cookie, beyond `baseURL`'s. */
  trustedOrigins?: string[];
  /** better-auth's per-IP limits on sign-in and sign-up. Off only in tests. */
  rateLimit?: boolean;
  /** Logs only better-auth's errors, not its warnings. */
  quiet?: boolean;
}

export const syntheticEmail = (name: string): string => `${name.toLowerCase()}@players.invalid`;

export function authOptions(config: AuthConfig) {
  return {
    appName: 'leuven.social',
    database: config.db,
    secret: config.secret,
    baseURL: config.baseURL,
    basePath: '/api/auth',
    trustedOrigins: config.trustedOrigins ?? [],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: MIN_PASSWORD,
      maxPasswordLength: MAX_PASSWORD,
    },
    session: SESSION,
    rateLimit: {
      enabled: config.rateLimit ?? true,
      window: 60,
      max: 100,
      customRules: { '/sign-in/username': { window: 60, max: 10 } },
    },
    telemetry: { enabled: false },
    logger: { level: config.quiet ? 'error' : 'warn' },
    advanced: {
      // nginx sets this from the end of exe.dev's X-Forwarded-For, the one hop a client can't
      // forge (docs/DEPLOY.md); without nginx, server.ts fills it in from the socket.
      ipAddress: { ipAddressHeaders: ['x-real-ip'] },
    },
    plugins: [
      username({
        minUsernameLength: MIN_NAME,
        maxUsernameLength: MAX_NAME,
        usernameValidator: isUsername,
        displayUsername: false,
      }),
    ],
  } satisfies BetterAuthOptions;
}

export function createAuth(config: AuthConfig) {
  return betterAuth(authOptions(config));
}

/** Creates or updates better-auth's tables, so a fresh database just works. */
export async function migrateAuth(config: AuthConfig): Promise<void> {
  const { runMigrations } = await getMigrations(authOptions(config));
  await runMigrations();
}

/** A fixed secret for local play only: production refuses to start without its own. */
const DEV_SECRET = 'leuven-social-dev-secret-not-for-production-use';

export function secretFrom(env: Record<string, string | undefined>): string {
  const secret = env.BETTER_AUTH_SECRET;
  if (secret) return secret;
  if (env.NODE_ENV === 'production') {
    throw new Error('BETTER_AUTH_SECRET must be set in production (see docs/DEPLOY.md).');
  }
  return DEV_SECRET;
}
