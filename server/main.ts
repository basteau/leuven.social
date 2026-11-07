/**
 * Starts the multiplayer server from the environment (docs/MULTIPLAYER.md):
 *
 *   PORT                 8787
 *   DATABASE_PATH        ./.data/leuven.sqlite
 *   BETTER_AUTH_SECRET   required when NODE_ENV=production
 *   BETTER_AUTH_URL      where the site is served; Vite's http://localhost:5173 in dev
 *   TRUSTED_ORIGINS      more origins, comma-separated (dev adds localhost on any port)
 *   DEBUG                @portable/log patterns; leuven:* at info by default
 */

import * as Log from '@portable/log';

import { secretFrom } from './auth.ts';
import { startServer } from './server.ts';

const env = process.env;
Log.enable(env.DEBUG ?? 'leuven:*=info');
const log = Log.create('leuven:main');

const production = env.NODE_ENV === 'production';
const databasePath = env.DATABASE_PATH ?? './.data/leuven.sqlite';
const trustedOrigins = [
  ...(env.TRUSTED_ORIGINS?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean) ?? []),
  // Vite moves to the next free port when 5173 is taken, and the preview runs on 4173.
  ...(production ? [] : ['http://localhost:*', 'http://127.0.0.1:*']),
];

try {
  const dir = databasePath.slice(0, Math.max(0, databasePath.lastIndexOf('/')));
  if (dir && databasePath !== ':memory:') await Bun.$`mkdir -p ${dir}`.quiet();
  const server = await startServer({
    port: Number(env.PORT ?? 8787),
    databasePath,
    secret: secretFrom(env),
    baseURL: env.BETTER_AUTH_URL ?? 'http://localhost:5173',
    trustedOrigins,
  });
  const shutdown = async () => {
    log.info('shutting down');
    await server.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch (error) {
  log.error(error);
  process.exit(1);
}
