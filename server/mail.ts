/**
 * Sign-in codes by mail, through Resend's HTTP API (no SDK). Without a key, in development the
 * code goes to this server's console so signing in works locally, and in production nothing can
 * be sent: sending a code answers plainly and the guests carry on. Nothing is ever pretended.
 */

import * as Log from '@portable/log';

import { CODE_MINUTES } from '../src/net/rules.ts';

const log = Log.create('leuven:mail');

/** How long the provider gets before we say it failed (ms). */
const TIMEOUT_MS = 8000;
const RESEND = 'https://api.resend.com/emails';

/** A failed send; `message` is for the server's log and names the provider's reason. */
export class MailError extends Error {
  override name = 'MailError';
}

export interface Mailer {
  /** Whether a code can be sent at all. */
  readonly ready: boolean;
  /** Mails `code` to `to`, or throws a `MailError` saying why it couldn't. */
  send(to: string, code: string): Promise<void>;
}

/** Mail isn't set up: nothing can go out. */
export const noMailer: Mailer = {
  ready: false,
  send: () => Promise.reject(new MailError('mail is not set up')),
};

/** Development: the code on the console, so a sign-in works with no account at a provider. */
export function consoleMailer(write: (line: string) => void = (line) => log.info(line)): Mailer {
  return {
    ready: true,
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

export interface ResendOptions {
  apiKey: string;
  from: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function resendMailer(options: ResendOptions): Mailer {
  const { apiKey, from, fetch: post = fetch, timeoutMs = TIMEOUT_MS } = options;
  return {
    ready: true,
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
      );
    },
  };
}

/** The mailer the environment asks for, and a word in the log about what it means. */
export function mailerFrom(env: Record<string, string | undefined>): Mailer {
  const { RESEND_API_KEY: apiKey, MAIL_FROM: from } = env;
  if (apiKey && from) return resendMailer({ apiKey, from });
  if (env.NODE_ENV === 'production') {
    const missing = [apiKey ? '' : 'RESEND_API_KEY', from ? '' : 'MAIL_FROM'].filter(Boolean);
    log.warn(
      `${missing.join(' and ')} not set: nobody can sign in until they are (docs/DEPLOY.md); guests can still play`,
    );
    return noMailer;
  }
  log.info('no RESEND_API_KEY and MAIL_FROM: sign-in codes are printed here');
  return consoleMailer();
}
