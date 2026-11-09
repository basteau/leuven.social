/**
 * Accounts with better-auth: an email address and a code sent to it, sessions in a cookie,
 * everything in our own SQLite file. Every account always has a valid, unique username: when
 * better-auth creates a user the `newUser` hook gives it one, and the player can change it.
 */

import type { Database } from 'bun:sqlite';
import { betterAuth } from 'better-auth';
import type { BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { username } from 'better-auth/plugins/username';

import {
  CODE_LENGTH,
  CODE_MINUTES,
  MAX_NAME,
  MAX_PASSWORD,
  MIN_NAME,
  MIN_PASSWORD,
  isUsername,
} from '../src/net/rules.ts';

/** Signed in for 60 days, renewed once a day of play: a game, not a bank. */
const DAY = 60 * 60 * 24;
const SESSION = { expiresIn: 60 * DAY, updateAge: DAY };

/** Where the browser asks for a code, and where it gives one back. */
export const SEND_CODE_PATH = '/email-otp/send-verification-otp';
export const SIGN_IN_PATH = '/sign-in/email-otp';

/** The few endpoints the browser may call; the rest of better-auth stays server-side. */
export const PUBLIC_AUTH_PATHS: ReadonlySet<string> = new Set([
  SEND_CODE_PATH,
  SIGN_IN_PATH,
  '/sign-in/username',
  '/sign-out',
  '/get-session',
  '/change-password',
  '/is-username-available',
]);

export interface NewUser {
  /** As typed: what everyone sees. */
  name: string;
  /** Lowercased: what must be unique. */
  username: string;
  /** Not confirmed yet: the sheet asks them to keep or change it. */
  fresh: boolean;
}

export interface AuthConfig {
  db: Database;
  secret: string;
  /** Where the site is served, such as https://leuven.exe.xyz. */
  baseURL: string;
  /** Origins allowed to post with the cookie, beyond `baseURL`'s. */
  trustedOrigins?: string[];
  /** better-auth's per-IP limits on sign-in. Off only in tests. */
  rateLimit?: boolean;
  /** Logs only better-auth's errors, not its warnings. */
  quiet?: boolean;
  /** Who a new account is, from its request's headers (the guest cookie, the address). */
  newUser?(headers: Headers | undefined): Promise<NewUser>;
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
    user: {
      additionalFields: {
        /** Set when an account is made, cleared once its name was chosen or kept. */
        fresh: { type: 'boolean', required: false, defaultValue: false, input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          async before(user, context) {
            const given = (user as { username?: unknown }).username;
            if (given || !config.newUser) return { data: user };
            return { data: { ...user, ...(await config.newUser(context?.headers)) } };
          },
        },
      },
    },
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
      emailOTP({
        otpLength: CODE_LENGTH,
        expiresIn: CODE_MINUTES * 60,
        allowedAttempts: 5,
        storeOTP: 'hashed',
        rateLimit: { window: 60, max: 10 },
        // server.ts mails the code itself: this hook's failures are swallowed by better-auth,
        // and a sentence for a failed send is half the point. See `sendCode` there.
        sendVerificationOTP: () => Promise.resolve(),
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
