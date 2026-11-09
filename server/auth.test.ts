import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

import { authOptions, secretFrom } from './auth.ts';

test('production refuses to start without a secret; dev has a fixed one', () => {
  expect(secretFrom({ BETTER_AUTH_SECRET: 's3cret' })).toBe('s3cret');
  expect(secretFrom({ BETTER_AUTH_SECRET: 's3cret', NODE_ENV: 'production' })).toBe('s3cret');
  expect(secretFrom({})).toBe(secretFrom({ NODE_ENV: 'development' }));
  expect(() => secretFrom({ NODE_ENV: 'production' })).toThrow(/BETTER_AUTH_SECRET/);
});

test('better-auth’s own way of sending a code stays shut: server.ts makes and mails it', async () => {
  const options = authOptions({ db: new Database(':memory:'), secret: 'x', baseURL: 'http://a.b' });
  const plugin = options.plugins.find((p) => p.id === 'email-otp')!;
  const send = (plugin as unknown as { options: { sendVerificationOTP(): Promise<void> } }).options
    .sendVerificationOTP;
  expect(await send()).toBeUndefined();
});
