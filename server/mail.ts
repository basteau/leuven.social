/**
 * Sign-in codes by mail, through Resend's HTTP API (no SDK). Without a key, in development the
 * code goes to this server's console so signing in works locally; production won't start without
 * one, as without its secret.
 */

import * as Log from '@portable/log';

import { CODE_MINUTES } from '../src/net/rules.ts';

const log = Log.create('leuven:mail');

/** How long the provider gets before we say it failed (ms). */
const TIMEOUT_MS = 8000;
const RESEND = 'https://api.resend.com/emails';

/** Sender when `MAIL_FROM` isn't set. Resend delivers its mail only to the account's own address. */
export const TEST_SENDER = 'Leuven <onboarding@resend.dev>';

/** Why a mail didn't go: this address is no good, the provider is full, or anything else. */
export type MailFailure = 'recipient' | 'busy' | 'failed';

/** A failed send; `message` is for the server's log and names the provider's reason. */
export class MailError extends Error {
  override name = 'MailError';
  constructor(
    message: string,
    readonly kind: MailFailure = 'failed',
  ) {
    super(message);
  }
}

export interface Mailer {
  /** Mails `code` to `to`, or throws a `MailError` saying why it couldn't. */
  send(to: string, code: string): Promise<void>;
}

/** Development: the code on the console, so a sign-in works with no account at a provider. */
export function consoleMailer(write: (line: string) => void = (line) => log.info(line)): Mailer {
  return {
    send(to, code) {
      write(`${code} is the code for ${to}`);
      return Promise.resolve();
    },
  };
}

/** One short message, as text and as the plainest HTML. */
export function codeMail(code: string): { subject: string; text: string; html: string } {
  const lines = [
    `${code} is your leuven.social code.`,
    `It works for ${CODE_MINUTES} minutes.`,
    'If it wasn’t you who asked for it, you can ignore this email.',
  ];
  return {
    subject: lines[0]!.slice(0, -1),
    text: lines.join('\n\n'),
    html: `<p style="font:600 28px/1.2 sans-serif;letter-spacing:.1em">${code}</p><p>${lines[1]}</p><p>${lines[2]}</p>`,
  };
}

const hexOf = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');

/** What a refusal means for the person waiting: Resend names a bad address in a 422 about `to`. */
function failureOf(status: number, reason: string): MailFailure {
  if (status === 429) return 'busy';
  return status === 422 && reason.includes('`to`') ? 'recipient' : 'failed';
}

export interface ResendOptions {
  apiKey: string;
  from: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function resendMailer(options: ResendOptions): Mailer {
  const { apiKey, from, fetch: post = fetch, timeoutMs = TIMEOUT_MS } = options;
  return {
    async send(to, code) {
      // The same code to the same address is one mail, however many times this request is retried.
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`${to}:${code}`),
      );
      let response: Response;
      try {
        response = await post(RESEND, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            'idempotency-key': `leuven-code-${hexOf(digest)}`,
          },
          body: JSON.stringify({ from, to: [to], ...codeMail(code) }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new MailError(
          `could not reach Resend: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      }
      if (response.ok) return;
      const body = (await response.json().catch(() => null)) as {
        name?: unknown;
        message?: unknown;
      } | null;
      const reason = [body?.name, body?.message].filter((p) => typeof p === 'string').join(': ');
      // Whatever the provider says goes in a log line; the key never does.
      throw new MailError(
        `Resend said ${response.status}: ${reason.replaceAll(apiKey, '[key]').slice(0, 300)}`,
        failureOf(response.status, reason),
      );
    },
  };
}

/** The mailer the environment asks for; production has to be able to send. */
export function mailerFrom(env: Record<string, string | undefined>): Mailer {
  const { RESEND_API_KEY: apiKey, MAIL_FROM: from } = env;
  if (apiKey) {
    if (!from) log.warn('no MAIL_FROM: codes reach only the Resend account’s own address');
    return resendMailer({ apiKey, from: from || TEST_SENDER });
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('RESEND_API_KEY must be set in production (see docs/DEPLOY.md).');
  }
  log.info('no RESEND_API_KEY: sign-in codes are printed here');
  return consoleMailer();
}
