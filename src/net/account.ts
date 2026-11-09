/**
 * Accounts: an email and a code sent to it, and a name of your own. Signing in sets a session
 * cookie on our own origin (better-auth on the server, under /api/auth); every call here sends it
 * along. The errors a person can see carry a sentence written for them, whatever better-auth said.
 */

import { isOutfit } from './protocol.ts';
import type { Outfit, PlayerState } from './protocol.ts';
import {
  CODE_COOLDOWN_SECONDS,
  CODE_LENGTH,
  MIN_NAME,
  MAX_NAME,
  isEmail,
  isUsername,
  normaliseEmail,
} from './rules.ts';

const API = '/api';

/** Who this browser is, how they look and where they were last. */
export interface Me {
  /** Not signed in: a guest, with a name and look the server gave them. */
  guest: boolean;
  name: string;
  outfit: Outfit;
  /** Where they left the city, or null the first time (or a guest away a while). */
  at: PlayerState | null;
  /** A new account that hasn't chosen or kept the name it was given yet. */
  fresh: boolean;
  /** Whether sign-in codes can be sent at all; false before the mail is set up. */
  mail: boolean;
}

export type AccountErrorCode =
  | 'taken'
  | 'name'
  | 'email'
  | 'undeliverable'
  | 'code'
  | 'expired'
  | 'spent'
  | 'mail-off'
  | 'mail-failed'
  | 'sent'
  | 'signed-out'
  | 'busy'
  | 'accounts-full'
  | 'offline'
  | 'server';

/** Something went wrong with an account call; `message` is ready to show. */
export class AccountError extends Error {
  override name = 'AccountError';
  constructor(
    readonly code: AccountErrorCode,
    message: string,
    options?: ErrorOptions,
    /** With `sent`: how long until another can go, in seconds. */
    readonly retryAfter = 0,
  ) {
    super(message, options);
  }
}

const MESSAGES: Record<AccountErrorCode, string> = {
  taken: 'That name is taken.',
  name: `Use ${MIN_NAME} to ${MAX_NAME} letters, digits, _, - or . for your name, with no dot at either end.`,
  email: 'That doesn’t look like an email address. Check it and try again.',
  undeliverable: 'That address can’t receive mail. Use another one.',
  code: 'That code isn’t right. Check the digits, or send a new one.',
  expired: 'That code has expired. Send a new one.',
  spent: 'Too many wrong tries for that code. Send a new one.',
  'mail-off': 'Joining isn’t switched on yet. Keep exploring as you are.',
  'mail-failed': 'Couldn’t send the email just now. Try again in a minute.',
  sent: 'A code is already on its way. Check your inbox.',
  'signed-out': 'You were signed out. Join again to keep your changes.',
  busy: 'Too many tries. Wait a minute, then try again.',
  'accounts-full': 'Too many new accounts from here today. Send a new code later.',
  offline: 'Can’t reach the server. Check your connection, then try again.',
  server: 'Something went wrong on our side. Try again in a moment.',
};

const fail = (code: AccountErrorCode, cause?: unknown, retryAfter = 0) =>
  new AccountError(code, MESSAGES[code], cause === undefined ? undefined : { cause }, retryAfter);

/** Error codes as what they mean here: better-auth's (core and the username plugin) and our server's. */
const CODES: Record<string, AccountErrorCode> = {
  INVALID_EMAIL: 'email',
  EMAIL_UNDELIVERABLE: 'undeliverable',
  INVALID_OTP: 'code',
  OTP_EXPIRED: 'expired',
  TOO_MANY_ATTEMPTS: 'spent',
  TOO_MANY_ACCOUNTS: 'accounts-full',
  MAIL_OFF: 'mail-off',
  MAIL_FAILED: 'mail-failed',
  CODE_ALREADY_SENT: 'sent',
  USERNAME_IS_ALREADY_TAKEN: 'taken',
  USERNAME_TOO_SHORT: 'name',
  USERNAME_TOO_LONG: 'name',
  INVALID_USERNAME: 'name',
};

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(`${API}${path}`, {
      ...init,
      credentials: 'include',
      headers: init.body ? { 'content-type': 'application/json' } : undefined,
    });
  } catch (error) {
    throw fail('offline', error);
  }
}

/** Turns a failed response into the error a person should see. */
async function failure(response: Response): Promise<AccountError> {
  const body = (await response.json().catch(() => null)) as {
    code?: unknown;
    retryAfter?: unknown;
  } | null;
  const code = typeof body?.code === 'string' ? CODES[body.code] : undefined;
  if (response.status === 429) {
    if (code === 'accounts-full') return fail(code);
    if (code !== 'sent') return fail('busy');
    return fail(
      'sent',
      body,
      typeof body?.retryAfter === 'number' ? body.retryAfter : CODE_COOLDOWN_SECONDS,
    );
  }
  if (response.status === 401) return fail('signed-out');
  return fail(code ?? 'server', body ?? response.status);
}

const post = (path: string, body: unknown) =>
  request(path, { method: 'POST', body: JSON.stringify(body) });

const putMe = (body: unknown, keepalive = false) =>
  request('/me', { method: 'PUT', body: JSON.stringify(body), keepalive });

/** Throws the sentence for a response that failed; a good one goes on. */
async function succeed(response: Response): Promise<void> {
  if (!response.ok) throw await failure(response);
}

/** Mails a sign-in code to this address, whether or not it has an account yet. */
export async function sendCode(email: string): Promise<void> {
  const address = normaliseEmail(email);
  if (!isEmail(address)) throw fail('email');
  await succeed(await post('/auth/email-otp/send-verification-otp', { email: address }));
}

/** Gives a code back: signs in, making the account if this address has none. */
export async function verifyCode(email: string, code: string): Promise<Me> {
  if (code.length !== CODE_LENGTH || /\D/.test(code)) throw fail('code');
  await succeed(await post('/auth/sign-in/email-otp', { email: normaliseEmail(email), otp: code }));
  return signedIn();
}

/** Takes another name, if it's free. */
export async function rename(name: string): Promise<Me> {
  if (!isUsername(name)) throw fail('name');
  await succeed(await putMe({ name }));
  return signedIn();
}

/** Whether a name is free; null when the server can't say (a check, nothing depends on it). */
export async function nameFree(name: string): Promise<boolean | null> {
  if (!isUsername(name)) return null;
  const response = await post('/auth/is-username-available', { username: name }).catch(() => null);
  if (!response?.ok) return null;
  const body = (await response.json().catch(() => null)) as { available?: unknown } | null;
  return typeof body?.available === 'boolean' ? body.available : null;
}

/** The account right after signing in; a browser that dropped the cookie is our failure. */
async function signedIn(): Promise<Me> {
  const account = await me();
  if (!account || account.guest) throw fail('server');
  return account;
}

export async function signOut(): Promise<void> {
  const response = await post('/auth/sign-out', {});
  if (!response.ok && response.status !== 401) throw await failure(response);
}

/** Who this browser is: an account or its guest, or null from a server that can't say. */
export async function me(): Promise<Me | null> {
  const response = await request('/me');
  if (response.status === 401) return null;
  await succeed(response);
  const body = (await response.json().catch(() => undefined)) as Partial<Me> | null | undefined;
  if (body === null) return null;
  if (typeof body?.name !== 'string' || !isOutfit(body.outfit)) throw fail('server', body);
  return {
    guest: body.guest === true,
    name: body.name,
    outfit: body.outfit,
    at: body.at ?? null,
    fresh: body.fresh === true,
    mail: body.mail !== false,
  };
}

/** Keeps the avatar's colours; everyone online sees them change. */
export async function saveOutfit(outfit: Outfit, { leaving = false } = {}): Promise<void> {
  // Leaving the page, the request is kept alive past it.
  await succeed(await putMe({ outfit }, leaving));
}
