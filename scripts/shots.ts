/**
 * A gallery of the same views every time, for looking at the city rather than at its numbers: the
 * dev server in a real browser on hardware GL, each view from a fresh page, framed by coordinates
 * (the viewer's own lookAt and zoom), with the on-screen controls hidden.
 *
 *   bun scripts/shots.ts                  # every view, into .artifacts/shots/
 *   bun scripts/shots.ts grote night      # only the views with these in their name
 *   bun scripts/shots.ts --dir before     # into .artifacts/before/, to compare
 *   bun scripts/shots.ts --scale 2        # at twice the density, as a Retina screen draws it
 */

type Time = 'morning' | 'midday' | 'golden' | 'dusk' | 'night';

interface Shot {
  name: string;
  /** Metres east and south of the middle of the city; the opening view without one. */
  at?: [number, number];
  /** The zoom, from 8 (a block) to 40 (the closest). */
  zoom?: number;
  time: Time;
  /** Quarter turns. */
  turn?: number;
}

const RACK: [number, number] = [980, 0];
const QUIET: [number, number] = [236, -214];
const PARK: [number, number] = [-360, 660];
const RIVER: [number, number] = [-235, -60];
const COURT: [number, number] = [839, 139];
const LIBRARY: [number, number] = [110, 575];
const UNI: [number, number] = [396, 497];
const MUSEUM: [number, number] = [-66, 260];
const HOTEL: [number, number] = [-257, 369];
const THEATRE: [number, number] = [-296, 440];

const SHOTS: Shot[] = [
  { name: 'overview-golden', time: 'golden' },
  { name: 'overview-night', time: 'night' },
  { name: 'grote-markt-night', at: [12, -4], zoom: 16, time: 'night' },
  { name: 'stadhuis-side-night', at: [-30, 42], zoom: 30, time: 'night', turn: 1 },
  { name: 'grote-markt-golden', at: [12, -4], zoom: 16, time: 'golden' },
  { name: 'oude-markt-night', at: [-135, 90], zoom: 20, time: 'night' },
  { name: 'oude-markt-midday', at: [-135, 90], zoom: 20, time: 'midday' },
  { name: 'rack-station-golden', at: RACK, zoom: 40, time: 'golden' },
  { name: 'rack-station-night', at: RACK, zoom: 32, time: 'night' },
  { name: 'rack-quiet-midday', at: QUIET, zoom: 40, time: 'midday' },
  { name: 'rack-small-golden', at: [-505, -813], zoom: 40, time: 'golden' },
  { name: 'university-morning', at: UNI, zoom: 24, time: 'morning' },
  { name: 'university-dusk', at: [974, -4], zoom: 24, time: 'dusk' },
  { name: 'museum-golden', at: MUSEUM, zoom: 24, time: 'golden' },
  { name: 'hotel-midday', at: HOTEL, zoom: 24, time: 'midday' },
  { name: 'theatre-night', at: THEATRE, zoom: 22, time: 'night' },
  { name: 'hospital-morning', at: [-103, 799], zoom: 22, time: 'morning' },
  { name: 'door-0', at: LIBRARY, zoom: 34, time: 'golden' },
  { name: 'door-1', at: LIBRARY, zoom: 34, time: 'golden', turn: 1 },
  { name: 'door-2', at: LIBRARY, zoom: 34, time: 'golden', turn: 2 },
  { name: 'door-3', at: LIBRARY, zoom: 34, time: 'night', turn: 3 },
  { name: 'park-golden', at: PARK, zoom: 10, time: 'golden' },
  { name: 'park-close-midday', at: PARK, zoom: 26, time: 'midday' },
  { name: 'park-night', at: PARK, zoom: 12, time: 'night' },
  { name: 'dijle-morning', at: RIVER, zoom: 14, time: 'morning' },
  { name: 'dijle-night', at: RIVER, zoom: 14, time: 'night' },
  { name: 'court-midday', at: COURT, zoom: 18, time: 'midday' },
];

const args = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1]! : fallback;
}
const dir = flag('dir', 'shots');
const scale = flag('scale', '1');
const wanted = SHOTS.filter((s) => !args.length || args.some((a) => s.name.includes(a)));

const ROOT = Bun.fileURLToPath(new URL('..', import.meta.url));
const OUT = `${ROOT}.artifacts/${dir}/`;
await Bun.write(`${OUT}.keep`, ''); // makes the directory
const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const PORT = probe.port;
await probe.stop(true);
const SESSION = `leuven-shots-${PORT}`;
const ENV = {
  ...process.env,
  AGENT_BROWSER_ARGS: '--mute-audio,--use-angle=metal,--ignore-gpu-blocklist',
};

async function browser(...cmd: string[]): Promise<string> {
  const proc = Bun.spawn([`${ROOT}node_modules/.bin/agent-browser`, '--session', SESSION, ...cmd], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: ENV,
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.join(' ')} failed:\n${err || out}`);
  return out.trim();
}

const server = Bun.spawn([`${ROOT}node_modules/.bin/vite`, '--port', String(PORT)], {
  cwd: ROOT,
  stdout: 'ignore',
  stderr: 'ignore',
});

const time = async () =>
  JSON.parse(await browser('eval', 'document.documentElement.dataset.time ?? ""')) as string;
const HIDE = `const s = document.createElement('style'); s.textContent = '.hud, .avatar-arrow, .player-tags { visibility: hidden !important }'; document.head.append(s); 1`;

try {
  await Bun.sleep(1200);
  await browser('set', 'viewport', '1280', '800', scale);
  for (const shot of wanted) {
    await browser('open', `http://localhost:${PORT}/`);
    await browser('wait', '--fn', "document.documentElement.dataset.state === 'ready'");
    await browser('wait', '--fn', "!document.getElementById('intro')");
    await browser('eval', HIDE);
    if (shot.at) {
      await browser('wait', '600'); // the avatar's chunk, which takes the camera there
      const [x, z] = shot.at;
      await browser('eval', `leuvenViewer.lookAt(${x}, ${z}); 1`);
      await browser('wait', '2200'); // its glide down to zoom 8 has to end, or it undoes the zoom
      await browser(
        'eval',
        `leuvenViewer.zoomBy(1e6); leuvenViewer.zoomBy(${(shot.zoom ?? 8) / 40}); 1`,
      );
    }
    for (let i = 0; i < (shot.turn ?? 0); i++) {
      await browser('eval', 'leuvenViewer.rotate(1); 1');
      await browser('wait', '400');
    }
    for (let i = 0; i < 6 && (await time()) !== shot.time; i++) {
      await browser('press', 't');
      await browser('wait', '150');
    }
    await browser('wait', '1800'); // the camera settles, the furniture and the shadows are drawn
    await browser('screenshot', `${OUT}${shot.name}.png`);
    console.log(`ok  ${shot.name}`);
  }
} finally {
  await browser('close').catch(() => {});
  server.kill();
}
