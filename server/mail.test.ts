import { describe, expect, test } from 'bun:test';

import { MailError, codeMail, consoleMailer, mailerFrom, noMailer, resendMailer } from './mail.ts';

const asError = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => e as Error,
  );

const mailer = (post: typeof fetch) =>
  resendMailer({ apiKey: 'sekret-key', from: 'Leuven <hi@leuven.test>', fetch: post });

describe('the code in a mail', () => {
  test('says what it is, how long it works, and to ignore it if unasked', () => {
    const mail = codeMail('123456');
    expect(mail.subject).toBe('123456 is your leuven.social code');
    expect(mail.text).toContain('123456 is your leuven.social code.');
    expect(mail.text).toContain('10 minutes');
    expect(mail.text).toContain('ignore');
    expect(mail.html).toContain('123456');
  });
});

describe('sending through Resend', () => {
  const sent: { url: string; init: RequestInit }[] = [];
  const answering = (...responses: (Response | Error)[]) => {
    sent.length = 0;
    return (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      const next = responses.shift()!;
      if (next instanceof Error) throw next;
      return next;
    }) as typeof fetch;
  };
  test('posts the message with the key and an idempotency key', async () => {
    await mailer(answering(Response.json({ id: 'm1' }))).send('a@b.co', '654321');
    expect(sent[0]?.url).toBe('https://api.resend.com/emails');
    const headers = sent[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sekret-key');
    expect(headers['idempotency-key']).toMatch(/^leuven-code-[0-9a-f]{64}$/);
    expect(JSON.parse(sent[0]?.init.body as string)).toMatchObject({
      from: 'Leuven <hi@leuven.test>',
      to: ['a@b.co'],
      subject: '654321 is your leuven.social code',
    });
    expect(sent[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  test('the same code to the same address has the same idempotency key', async () => {
    const post = answering(Response.json({}), Response.json({}), Response.json({}));
    const m = mailer(post);
    await m.send('a@b.co', '111111');
    await m.send('a@b.co', '111111');
    await m.send('a@b.co', '222222');
    const keys = sent.map((s) => (s.init.headers as Record<string, string>)['idempotency-key']);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  test('a refusal carries the provider’s reason, never the key', async () => {
    const refused = Response.json(
      { name: 'validation_error', message: 'domain not verified for sekret-key' },
      { status: 403 },
    );
    const error = await asError(mailer(answering(refused)).send('a@b.co', '1'));
    expect(error).toBeInstanceOf(MailError);
    expect(error?.message).toContain('403');
    expect(error?.message).toContain('domain not verified');
    expect(error?.message).not.toContain('sekret-key');
  });

  test('an unreadable refusal and a dead network are failures too', async () => {
    const bad = await asError(
      mailer(answering(new Response('oops', { status: 502 }))).send('a@b.co', '1'),
    );
    expect(bad?.message).toContain('502');
    const dead = await asError(
      mailer(answering(new DOMException('timed out', 'TimeoutError'))).send('a@b.co', '1'),
    );
    expect(dead?.message).toContain('TimeoutError');
    const weird = await asError(
      mailer((() => Promise.reject('no')) as unknown as typeof fetch).send('a@b.co', '1'),
    );
    expect(weird?.message).toContain('unknown');
  });
});

describe('the mailer without a key', () => {
  test('in production nothing can be sent, and it says so', async () => {
    const off = mailerFrom({ NODE_ENV: 'production' });
    expect(off).toBe(noMailer);
    expect(off.ready).toBe(false);
    expect(await asError(off.send('a@b.co', '1'))).toBeInstanceOf(MailError);
    expect(mailerFrom({ NODE_ENV: 'production', RESEND_API_KEY: 'k' })).toBe(noMailer);
  });

  test('in development the code goes to the console', async () => {
    expect(mailerFrom({}).ready).toBe(true);
    expect(mailerFrom({ RESEND_API_KEY: 'k' }).ready).toBe(true);
    const lines: string[] = [];
    await consoleMailer((line) => lines.push(line)).send('a@b.co', '123456');
    expect(lines.join()).toContain('123456');
    expect(lines.join()).toContain('a@b.co');
    await consoleMailer().send('a@b.co', '123456');
  });

  test('with a key and a sender it goes to Resend', () => {
    expect(mailerFrom({ RESEND_API_KEY: 'k', MAIL_FROM: 'a@b.co' }).ready).toBe(true);
  });
});
