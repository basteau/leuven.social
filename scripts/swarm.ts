/**
 * A swarm of bots on the presence socket, to load-test the multiplayer server with real accounts
 * and real frames: each walks about at 10 Hz as the page does and counts what it is sent.
 *
 *   bun scripts/swarm.ts --bots 1000                      # its own server, reports and exits
 *   bun scripts/swarm.ts --bots 50 --api http://… --at 0,0 --spread 40 --seconds 30
 *
 * Accounts are kept between runs (.artifacts/swarm.*), as making a thousand takes a minute or two
 * of password hashing. The measure is taken after the swarm has settled, and printed as JSON last.
 */

import { decodeServerMessage, encodeClientMessage } from '../src/net/protocol.ts';

const flag = (name: string) => {
  const at = Bun.argv.indexOf(`--${name}`);
  return at < 0 ? undefined : Bun.argv[at + 1];
};

const BOTS = Number(flag('bots') ?? 100);
const SECONDS = Number(flag('seconds') ?? 20);
const SETTLE_MS = Number(flag('settle') ?? 4000);
const SPREAD = Number(flag('spread') ?? 1200);
const [CENTRE_X, CENTRE_Z] = (flag('at') ?? '0,500').split(',').map(Number) as [number, number];
const ORIGIN = 'http://localhost:5173';
const ARTIFACTS = Bun.fileURLToPath(new URL('../.artifacts/', import.meta.url));
const COOKIES = `${ARTIFACTS}swarm-cookies.json`;
const DATABASE = `${ARTIFACTS}swarm.sqlite`;
/** The server allows 30 accounts an hour from one address. */
const PER_ADDRESS = 25;
const SIGNUPS_AT_ONCE = 8;

let api = flag('api');
let server: Bun.Subprocess | undefined;

async function startServer(): Promise<void> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  api = `http://127.0.0.1:${port}`;
  server = Bun.spawn(['bun', 'server/main.ts'], {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: DATABASE, DEBUG: 'none' },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  for (let i = 0; i < 100; i++) {
    const up = await fetch(`${api}/api/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) return;
    await Bun.sleep(100);
  }
  throw new Error('the server did not start');
}

async function signUp(name: string, address: string): Promise<string> {
  const response = await fetch(`${api}/api/account`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-real-ip': address },
    body: JSON.stringify({ username: name, password: 'swarm-test-password' }),
  });
  if (!response.ok) throw new Error(`${name}: ${response.status} ${await response.text()}`);
  return response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

/** Sessions for `count` bots, made only as far as earlier runs didn't. */
async function accounts(count: number): Promise<string[]> {
  const file = Bun.file(COOKIES);
  const cookies = (await file.exists()) ? ((await file.json()) as string[]) : [];
  let next = cookies.length;
  const worker = async () => {
    while (next < count) {
      const i = next++;
      const address = `10.77.${Math.floor(i / PER_ADDRESS / 250)}.${Math.floor(i / PER_ADDRESS) % 250}`;
      cookies[i] = await signUp(`swarmbot${i}`, address);
      if (i % 100 === 99) await Bun.write(COOKIES, JSON.stringify(cookies));
    }
  };
  await Promise.all(Array.from({ length: SIGNUPS_AT_ONCE }, worker));
  await Bun.write(COOKIES, JSON.stringify(cookies));
  return cookies.slice(0, count);
}

interface BotCount {
  bytes: number;
  frames: number;
  undecoded: number;
}

function startBot(cookie: string, seed: number, count: BotCount, decode: boolean) {
  let random = seed * 2654435761;
  const rand = () => {
    random = (random ^ (random << 13)) >>> 0;
    random = (random ^ (random >>> 17)) >>> 0;
    random = (random ^ (random << 5)) >>> 0;
    return random / 2 ** 32;
  };
  const socket = new WebSocket(`${api!.replace(/^http/, 'ws')}/ws`, {
    headers: { cookie, origin: ORIGIN },
  } as unknown as string[]);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', (event) => {
    const data = new Uint8Array(event.data as ArrayBuffer);
    count.bytes += data.length;
    count.frames++;
    if (decode && !decodeServerMessage(data)) count.undecoded++;
  });
  const reach = SPREAD * Math.sqrt(rand());
  const around = rand() * Math.PI * 2;
  let x = CENTRE_X + Math.cos(around) * reach;
  let z = CENTRE_Z + Math.sin(around) * reach;
  let heading = rand() * Math.PI * 2;
  const bike = rand() < 0.1;
  const speed = bike ? 8 + rand() * 6 : 1.5 + rand() * 4;
  let last = performance.now();
  const walk = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    heading += (rand() - 0.5) * 0.4;
    // Past the spread, back the way it came, so a crowd stays a crowd.
    if (Math.hypot(x - CENTRE_X, z - CENTRE_Z) > SPREAD) {
      heading = Math.atan2(CENTRE_X - x, CENTRE_Z - z);
    }
    x += Math.sin(heading) * speed * dt;
    z += Math.cos(heading) * speed * dt;
    socket.send(
      encodeClientMessage({
        type: 'state',
        state: {
          x,
          z,
          heading: ((heading % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2),
          speed,
          mode: bike ? 'bike' : 'foot',
          place: '',
          floor: 0,
        },
      }),
    );
  }, 100);
  return {
    socket,
    close() {
      clearInterval(walk);
      socket.close();
    },
  };
}

/** The server's CPU time so far (s) and memory (MB), from ps, for any build of it. */
async function serverLoad(): Promise<{ seconds: number; mb: number } | null> {
  if (!server?.pid) return null;
  const output = await new Response(
    Bun.spawn(['ps', '-o', 'cputime=,rss=', '-p', String(server.pid)]).stdout,
  ).text();
  const [time, rss] = output.trim().split(/\s+/);
  if (!time || !rss) return null;
  const seconds = time.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
  return { seconds, mb: Math.round(Number(rss) / 1024) };
}

const sampleEvery = 50;
try {
  await Bun.$`mkdir -p ${ARTIFACTS}`.quiet();
  if (!api) await startServer();
  const started = performance.now();
  const cookies = await accounts(BOTS);
  console.error(`${BOTS} accounts ready in ${Math.round(performance.now() - started)} ms`);
  const counts = cookies.map(() => ({ bytes: 0, frames: 0, undecoded: 0 }));
  const bots = cookies.map((cookie, i) =>
    startBot(cookie, i + 1, counts[i]!, i % sampleEvery === 0),
  );
  await Bun.sleep(SETTLE_MS);
  const open = bots.filter((b) => b.socket.readyState === WebSocket.OPEN).length;
  for (const c of counts) c.bytes = c.frames = 0;
  const from = performance.now();
  const before = await serverLoad();
  await Bun.sleep(SECONDS * 1000);
  const elapsed = (performance.now() - from) / 1000;
  const after = await serverLoad();
  const health = await fetch(`${api}/api/health`).then(
    (r) => r.json() as Promise<Record<string, unknown>>,
    () => null,
  );
  const rates = counts.map((c) => c.bytes / elapsed / 1024).toSorted((a, b) => a - b);
  const total = rates.reduce((a, b) => a + b, 0);
  const report = {
    bots: BOTS,
    open,
    spread: SPREAD,
    seconds: Math.round(elapsed),
    kbPerClient: {
      mean: Number((total / rates.length).toFixed(2)),
      p95: Number(rates[Math.floor(rates.length * 0.95)]!.toFixed(2)),
      max: Number(rates.at(-1)!.toFixed(2)),
    },
    framesPerClientPerSecond: Number(
      (counts.reduce((a, c) => a + c.frames, 0) / rates.length / elapsed).toFixed(1),
    ),
    totalMBPerSecond: Number((total / 1024).toFixed(2)),
    undecoded: counts.reduce((a, c) => a + c.undecoded, 0),
    server:
      before && after
        ? {
            cpuPercent: Math.round(((after.seconds - before.seconds) / elapsed) * 100),
            mb: after.mb,
          }
        : null,
    health,
  };
  for (const bot of bots) bot.close();
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  server?.kill();
  await Bun.sleep(50);
  process.exit();
}
