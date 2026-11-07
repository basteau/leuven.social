/**
 * Accounts: a name and a password, nothing else. Signing up or in sets a session cookie on our
 * own origin (better-auth on the server, under /api/auth); every call here sends it along. The
 * errors a person can see carry a sentence written for them, whatever better-auth said.
 */

import { isOutfit } from './protocol.ts';
import type { Outfit, PlayerState } from './protocol.ts';
import { MAX_PASSWORD, MIN_NAME, MAX_NAME, MIN_PASSWORD, isUsername } from './rules.ts';

const API = '/api';

/** Who is signed in, how they look and where they were last. */
export interface Me {
  name: string;
  outfit: Outfit;
  /** Where they left the city, or null the first time. */
  at: PlayerState | null;
}

export type AccountErrorCode =
  'taken' | 'credentials' | 'name' | 'password' | 'signed-out' | 'busy' | 'offline' | 'server';

/** Something went wrong with an account call; `message` is ready to show. */
export class AccountError extends Error {
  override name = 'AccountError';
  constructor(
    readonly code: AccountErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const MESSAGES: Record<AccountErrorCode, string> = {
  taken: 'That name is taken.',
  credentials: 'Wrong name or password.',
  name: `Use ${MIN_NAME} to ${MAX_NAME} letters, digits, _, - or . for your name, with no dot at either end.`,
  password: `Use at least ${MIN_PASSWORD} characters.`,
  'signed-out': 'Sign in again to keep your changes.',
  busy: 'Too many tries. Wait a minute, then try again.',
  offline: 'Can’t reach the server. Check your connection, then try again.',
  server: 'Something went wrong on our side. Try again in a moment.',
};

const fail = (code: AccountErrorCode, cause?: unknown) =>
  new AccountError(code, MESSAGES[code], cause === undefined ? undefined : { cause });

/** better-auth's error codes (core and the username plugin), as what they mean here. */
const CODES: Record<string, AccountErrorCode> = {
  USERNAME_IS_ALREADY_TAKEN: 'taken',
  USER_ALREADY_EXISTS: 'taken',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'taken',
  INVALID_USERNAME_OR_PASSWORD: 'credentials',
  INVALID_EMAIL_OR_PASSWORD: 'credentials',
  INVALID_PASSWORD: 'credentials',
  USERNAME_TOO_SHORT: 'name',
  USERNAME_TOO_LONG: 'name',
  INVALID_USERNAME: 'name',
  INVALID_EMAIL: 'name',
  PASSWORD_TOO_SHORT: 'password',
  PASSWORD_TOO_LONG: 'password',
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
  if (response.status === 429) return fail('busy');
  if (response.status === 401) return fail('signed-out');
  const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof body?.code === 'string' ? CODES[body.code] : undefined;
  return fail(code ?? 'server', body ?? response.status);
}

const post = (path: string, body: unknown) =>
  request(path, { method: 'POST', body: JSON.stringify(body) });

function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) throw fail('password');
}

/** Creates the account and signs in. */
export async function signUp(username: string, password: string): Promise<Me> {
  if (!isUsername(username)) throw fail('name');
  checkPassword(password);
  const response = await post('/account', { username, password });
  if (!response.ok) throw await failure(response);
  return signedIn();
}

export async function signIn(username: string, password: string): Promise<Me> {
  // A name that couldn't exist is just a wrong name: don't teach the rules on the way in.
  if (!isUsername(username) || !password) throw fail('credentials');
  const response = await post('/auth/sign-in/username', { username, password });
  if (!response.ok) {
    const error = await failure(response);
    throw error.code === 'name' || error.code === 'password' || error.code === 'signed-out'
      ? fail('credentials', error.cause)
      : error;
  }
  return signedIn();
}

/** The account right after signing in; a browser that dropped the cookie is our failure. */
async function signedIn(): Promise<Me> {
  const account = await me();
  if (!account) throw fail('server');
  return account;
}

export async function signOut(): Promise<void> {
  const response = await post('/auth/sign-out', {});
  if (!response.ok && response.status !== 401) throw await failure(response);
}

/** Who is signed in, or null for a guest. */
export async function me(): Promise<Me | null> {
  const response = await request('/me');
  if (response.status === 401) return null;
  if (!response.ok) throw await failure(response);
  const body = (await response.json().catch(() => null)) as Partial<Me> | null;
  if (typeof body?.name !== 'string' || !isOutfit(body.outfit)) throw fail('server', body);
  return { name: body.name, outfit: body.outfit, at: body.at ?? null };
}

/** Keeps the avatar's colours; everyone online sees them change. */
export async function saveOutfit(outfit: Outfit): Promise<void> {
  const response = await request('/me', { method: 'PUT', body: JSON.stringify({ outfit }) });
  if (!response.ok) throw await failure(response);
}
