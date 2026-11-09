/**
 * A swarm of bots on the presence socket, to load-test the multiplayer server with real frames:
 * each is a guest that walks about at 10 Hz as the page does and counts what it is sent. Guests,
 * since a sign-in means a code from a mailbox, and each says it comes from its own few addresses
 * (`x-real-ip`) to stay under the cap on guests an address; nginx replaces that header, so through
 * it only a dozen are seen.
 *
 *   bun scripts/swarm.ts --bots 1000                      # its own server, reports and exits
 *   bun scripts/swarm.ts --bots 50 --api http://… --at 0,0 --spread 40 --seconds 30
 *   bun scripts/swarm.ts --bots 1000 --zoomed-out 0.3     # that share are looking at the whole city
 *
 * The measure is taken after the swarm has settled, and printed as JSON last.
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
/** The share of bots looking at the whole city from high up, rather than at the street round them. */
const ZOOMED_OUT = Number(flag('zoomed-out') ?? (Bun.argv.includes('--zoomed-out') ? 0.3 : 0));
/** How far a bot on the street reaches (m), and one zoomed right out. */
const STREET_REACH = 180;
const CITY_REACH = 3000;
/** The look is said again when the view has moved this far (m), as the page does. */
const VIEW_STEP = 40;
const ORIGIN = 'http://localhost:5173';
/** The server keeps 12 guests an address on the map. */
const PER_ADDRESS = 12;

let api = flag('api');
let server: Bun.Subprocess | undefined;

async function startServer(): Promise<void> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  api = `http://127.0.0.1:${port}`;
  server = Bun.spawn(['bun', 'server/main.ts'], {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: ':memory:', DEBUG: 'none' },
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

const addressOf = (i: number) =>
  `10.77.${Math.floor(i / PER_ADDRESS / 250)}.${Math.floor(i / PER_ADDRESS) % 250}`;

interface BotCount {
  bytes: number;
  frames: number;
  undecoded: number;
  zoomedOut: boolean;
}

/** A bot on the street says where it looks as it walks; one zoomed out looks at the city. */
function say(socket: WebSocket, x: number, z: number, reach: number) {
  socket.send(encodeClientMessage({ type: 'view', x, z, reach }));
}

function startBot(address: string, seed: number, count: BotCount, decode: boolean) {
  let random = seed * 2654435761;
  const rand = () => {
    random = (random ^ (random << 13)) >>> 0;
    random = (random ^ (random >>> 17)) >>> 0;
    random = (random ^ (random << 5)) >>> 0;
    return random / 2 ** 32;
  };
  const socket = new WebSocket(`${api!.replace(/^http/, 'ws')}/ws`, {
    headers: { origin: ORIGIN, 'x-real-ip': address },
  } as unknown as string[]);
  socket.binaryType = 'arraybuffer';
  let toldX = Number.NaN;
  let toldZ = Number.NaN;
  socket.addEventListener('open', () => {
    if (count.zoomedOut) say(socket, CENTRE_X, CENTRE_Z, CITY_REACH);
  });
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
    if (!count.zoomedOut && !(Math.hypot(x - toldX, z - toldZ) < VIEW_STEP)) {
      say(socket, x, z, STREET_REACH);
      toldX = x;
      toldZ = z;
    }
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
  if (!api) await startServer();
  const counts = Array.from({ length: BOTS }, (_, i) => ({
    bytes: 0,
    frames: 0,
    undecoded: 0,
    zoomedOut: i < BOTS * ZOOMED_OUT,
  }));
  const bots = counts.map((count, i) =>
    startBot(addressOf(i), i + 1, count, i % sampleEvery === 0),
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
  const groupRates = (zoomedOut: boolean) => {
    const group = counts
      .filter((c) => c.zoomedOut === zoomedOut)
      .map((c) => c.bytes / elapsed / 1024)
      .toSorted((a, b) => a - b);
    if (!group.length) return null;
    return {
      bots: group.length,
      mean: Number((group.reduce((a, b) => a + b, 0) / group.length).toFixed(2)),
      p95: Number(group[Math.floor(group.length * 0.95)]!.toFixed(2)),
      max: Number(group.at(-1)!.toFixed(2)),
    };
  };
  const report = {
    bots: BOTS,
    open,
    spread: SPREAD,
    zoomedOut: ZOOMED_OUT,
    seconds: Math.round(elapsed),
    kbPerClient: {
      mean: Number((total / rates.length).toFixed(2)),
      p95: Number(rates[Math.floor(rates.length * 0.95)]!.toFixed(2)),
      max: Number(rates.at(-1)!.toFixed(2)),
    },
    onTheStreet: groupRates(false),
    zoomedOutClients: groupRates(true),
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
