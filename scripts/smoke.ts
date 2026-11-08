/**
 * Opens the production build in a real headless browser (agent-browser) and fails on load
 * errors, console errors, a broken first render or a render over budget. Screenshots for
 * desktop and phone land in .artifacts/ for a human (or agent) to look at.
 *
 *   bun run build && bun run smoke
 */

import { unpackCity } from '../src/data/format.ts';
import { bikesIn } from '../src/data/props.ts';
import { startBot } from './smoke-bot.ts';

// A free port and a browser session of our own, so parallel runs (worktrees, agents) never meet.
const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const PORT = probe.port;
await probe.stop(true);
// The multiplayer server, on a free port of its own, with a database in memory.
const apiProbe = Bun.serve({ port: 0, fetch: () => new Response() });
const API = `http://127.0.0.1:${apiProbe.port}`;
await apiProbe.stop(true);
const SESSION = `leuven-smoke-${PORT}`;
const BASE = `http://localhost:${PORT}/`;
const ARTIFACTS = Bun.fileURLToPath(new URL('../.artifacts/', import.meta.url));
const BIN = Bun.fileURLToPath(new URL('../node_modules/.bin/', import.meta.url));
/**
 * Per-frame render budget, for every frame: what a mid-range phone draws smoothly while panning.
 * The viewer publishes the first frame, the latest and the most any frame of the visit cost. The
 * city is cut into cells and only those in view are drawn, two draw calls each (surfaces,
 * outlines); a frame that redraws the shadow map adds one per casting cell, or draws the shadow
 * map alone when both wouldn't fit (`FRAME_CALLS` and `FRAME_TRIANGLES` in viewer.ts).
 */
// 160 calls: at night every lit cell in view adds a glow call, 150 in all zoomed out. Calls are
// cheap here (one program for the city, one for the glow), so the triangles are what the cap
// watches. The roofs' chimneys and dormers took the zoomed-out view from 582k to 637k.
// 1.15M was the traffic's room, zoomed out (about 923k without it); the other players' figures
// (two calls and about 1,300 triangles each) take what it left.
const MAX_DRAW_CALLS = 160;
const MAX_TRIANGLES = 1_150_000;
/**
 * What the whole city hands the GPU once every cell is built: 2.40M vertices and 57.7 MB since
 * racks park fewer bikes (it was 2.69M and 64.1 MB), 2.45M and 58.7 MB with what came since.
 * Rounder, spoked wheels, cranks, a chain guard, a kickstand, a lamp and a basket on the 3,632
 * parked bikes (83 triangles each where they were 43, asked for so they read up close) took it
 * to 2.72M and 64.9 MB (2,723,825 vertices). Houses at their exact ground: 2.73M. Café tables,
 * chairs and guests under Oude Markt's parasols, guests at the terraces and bay trees by café
 * doors, asked for to liven the city: 2.84M and 67.7 MB. Chimney stacks, dormers and roof
 * windows on the centre's houses, and the lamps' lanterns and pools of light at night, asked
 * for too: 3.13M and 74.9 MB. Just above, so nothing grows unnoticed.
 */
// 3.3M and 80 MB: the kerbstones along every carriageway (asked for, so the pavements read),
// one stone per straight run of a face's edges, took the whole city from 3.03M vertices and
// 72.1 MB to 3.25M and 77.9. 3.4M and 82 MB: a symbol sign for every trade and the public
// places' banners, flags and marquees, asked for so the city reads without words, 108k
// vertices more (3.35M, 80.2 MB).
// 3.95M and 98 MB: bikes with open spoked wheels and mudguards (318 vertices where they were 167),
// hoops, racks' roofs and the dark at the foot of the walls, asked for so the streets read up
// close, 3.91M and 96.9 MB (the lamps' pools, gone to the baked light, gave a little back).
const MAX_VERTICES = 3_950_000;
const MAX_GEOMETRY_MB = 98;
/**
 * The longest the main thread may be busy at once while the page loads (ms). About 60 on a
 * laptop since the roofs are planned lazily and the cells casting into the first frame are built
 * in slices (it was 130, finding the party walls); the rest is room for slower machines.
 */
const MAX_LONG_TASK_MS = 150;

/** The browser the test drives is muted: footsteps and bells have no business on the speakers. */
const BROWSER_ENV = { ...process.env, AGENT_BROWSER_ARGS: '--mute-audio' };

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', env: BROWSER_ENV });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.slice(1).join(' ')} failed:\n${err || out}`);
  return out.trim();
}

const browser = (...args: string[]) => run([`${BIN}agent-browser`, '--session', SESSION, ...args]);

async function browserJson<T>(...args: string[]): Promise<T> {
  const out = JSON.parse(await browser('--json', ...args)) as { success: boolean; data: T };
  if (!out.success) throw new Error(`agent-browser ${args.join(' ')} failed`);
  return out.data;
}

async function evalJson<T>(expression: string): Promise<T> {
  const { result } = await browserJson<{ result: unknown }>('eval', expression);
  return JSON.parse(String(result)) as T;
}

/** Navigates with fresh logs: agent-browser keeps console and errors across pages. */
async function openFresh(url: string): Promise<void> {
  await browser('console', '--clear');
  await browser('errors', '--clear');
  await browser('open', url);
}

async function expectHealthyPage(viewport: string): Promise<void> {
  await browser(
    'wait',
    '--fn',
    "['ready', 'error'].includes(document.documentElement.dataset.state)",
  );
  const page = await evalJson<Record<string, string> & { frame: Record<string, string> }>(
    'JSON.stringify({ ...document.documentElement.dataset, frame: { ...document.querySelector("canvas")?.dataset } })',
  );
  const problems: string[] = [];
  if (page.state !== 'ready') problems.push(`state is "${page.state}"`);
  // The first frame (published on <html> when ready), the latest one and the visit's most
  // expensive (both on the canvas).
  const { frame } = page;
  const frames = {
    first: [page.drawCalls, page.triangles],
    latest: [frame.drawCalls, frame.triangles],
    peak: [frame.peakDrawCalls, frame.peakTriangles],
  };
  const measured: string[] = [];
  for (const [name, [calls, triangles]] of Object.entries(frames).map(
    ([k, v]) => [k, v.map(Number)] as const,
  )) {
    if (!(calls! > 0 && calls! <= MAX_DRAW_CALLS))
      problems.push(`${name} frame: ${calls} draw calls (max ${MAX_DRAW_CALLS})`);
    if (!(triangles! > 0 && triangles! <= MAX_TRIANGLES))
      problems.push(`${name} frame: ${triangles} triangles (max ${MAX_TRIANGLES})`);
    measured.push(`${name} ${calls} calls, ${triangles!.toLocaleString()} tris`);
  }
  const [vertices, megabytes] = [Number(frame.vertices), Number(frame.geometryBytes) / 2 ** 20];
  if (!(vertices <= MAX_VERTICES)) problems.push(`${vertices} vertices (max ${MAX_VERTICES})`);
  if (!(megabytes <= MAX_GEOMETRY_MB))
    problems.push(`${megabytes.toFixed(1)} MB of geometry (max ${MAX_GEOMETRY_MB})`);
  measured.push(`${vertices.toLocaleString()} vertices, ${megabytes.toFixed(1)} MB`);
  const { errors } = await browserJson<{ errors: { text: string }[] }>('errors');
  for (const e of errors) problems.push(`page error: ${e.text.split('\n')[0]}`);
  const { messages } = await browserJson<{ messages: { type: string; text: string }[] }>('console');
  // Warnings fail too: a quiet console is the only way to notice a new one.
  for (const m of messages) {
    if (m.type === 'error' || m.type === 'warning') problems.push(`console ${m.type}: ${m.text}`);
  }
  if (problems.length) throw new Error(`${viewport}: ${problems.join('; ')}`);
  console.log(`ok  ${viewport}: ${measured.join('; ')}`);
}

/** The page's long tasks so far: the browser keeps them for an observer that asks. */
async function expectShortTasks(viewport: string): Promise<void> {
  const tasks = await evalJson<number[]>(
    `new Promise((resolve) => {
      new PerformanceObserver((list, observer) => {
        observer.disconnect();
        resolve(JSON.stringify(list.getEntries().map((e) => Math.round(e.duration))));
      }).observe({ type: 'longtask', buffered: true });
      setTimeout(() => resolve('[]'), 1000); // none so far: the observer stays quiet
    })`,
  );
  const longest = Math.max(0, ...tasks);
  if (longest > MAX_LONG_TASK_MS) {
    throw new Error(`${viewport}: a ${longest} ms long task (max ${MAX_LONG_TASK_MS})`);
  }
  console.log(`ok  ${viewport}: longest task ${longest} ms`);
}

/** A tap at (x, y): down and up in one go, as quick as a person's (a slow press is no tap). */
const tapAt = (x: number, y: number) =>
  browser('batch', `mouse move ${x} ${y}`, 'mouse down', 'mouse up');

/** Drags the map with the mouse, as a person panning would, in a few steps. */
async function drag(dx: number, dy: number): Promise<void> {
  const [x, y] = [640, 400];
  await browser('mouse', 'move', String(x), String(y));
  await browser('mouse', 'down');
  for (let i = 1; i <= 4; i++) {
    const at = [x + (dx * i) / 4, y + (dy * i) / 4].map((v) => String(Math.round(v)));
    await browser('mouse', 'move', ...at);
  }
  await browser('mouse', 'up');
}

/** The data licences require the credit to be visible on the map. */
async function expectCreditsShown(): Promise<void> {
  const credits = await evalJson<{ visible: boolean; text: string }>(
    'JSON.stringify({ visible: !!document.getElementById("credits-text")?.checkVisibility(), text: document.getElementById("credits-text")?.textContent ?? "" })',
  );
  if (!credits.visible || !credits.text.includes('OpenStreetMap')) {
    throw new Error('the OpenStreetMap credit is not visible (ODbL attribution)');
  }
  console.log('ok  credits visible');
}

/**
 * The loading screen is the page's own HTML, there before any script, and gone once the map is
 * drawn; then the map has no controls on it but the map and menu buttons.
 */
async function expectBareMap(): Promise<void> {
  const html = await (await fetch(BASE)).text();
  if (!html.includes('id="intro"') || !html.includes('role="progressbar"')) {
    throw new Error('the loading screen is not in the HTML');
  }
  await browser('wait', '--fn', `!document.getElementById('intro')`);
  const buttons = await evalJson<string[]>(
    `JSON.stringify([...document.querySelectorAll('main button:not(.avatar-arrow)')].filter((b) => b.checkVisibility() && !b.closest('dialog')).map((b) => b.getAttribute('aria-label') ?? b.textContent))`,
  );
  // Who you are (Join, as a guest), the minimap and the menu: nothing else.
  const expected = ['Join', 'Minimap: show more of the city', 'Open the map', 'Menu'];
  if (buttons.join() !== expected.join()) {
    throw new Error(`the map should show only ${expected.join(', ')}, not ${buttons.join(', ')}`);
  }
  // And the arrow over the avatar, far out at the default view: a marker, not a control.
  const arrow = await evalJson<string>(
    `JSON.stringify(document.querySelector('.avatar-arrow')?.hidden === false && document.querySelector('.avatar-arrow').dataset.edge)`,
  );
  if (arrow !== 'false') throw new Error(`the arrow over the avatar isn't showing (${arrow})`);
  console.log(
    'ok  loading screen in the HTML, then a bare map: Join, the minimap, the map and menu buttons and the arrow over you',
  );
}

const menu = {
  open: `!!document.querySelector('dialog.menu:not(.account)')?.open`,
  closed: `!document.querySelector('dialog.menu:not(.account)')?.open && document.activeElement === document.querySelector('.map')`,
  first: `document.querySelector('[role=option][aria-selected=true] .menu-option-label')?.textContent`,
};

/** Runs a command from the menu by searching for it, as a person would with the keyboard. */
async function runFromMenu(query: string, expected: string): Promise<void> {
  await browser('press', 'Control+k');
  await browser('wait', '--fn', `${menu.open} && document.activeElement?.matches('.menu-search')`);
  await browser('keyboard', 'type', query);
  await browser('wait', '--fn', `${menu.first} === ${JSON.stringify(expected)}`);
  await browser('press', 'Enter');
  // The menu closes and gives the keys back to the map.
  await browser('wait', '--fn', menu.closed);
}

/**
 * The menu: ⌘K or Ctrl+K opens it, it lists commands for the moment with their keys, a search
 * finds one and Enter runs it; ? opens the controls; the chord closes it again.
 */
async function expectMenu(): Promise<void> {
  await browser('press', 'Control+k');
  await browser('wait', '--fn', menu.open);
  const rows = await evalJson<{ label: string; keys: string }[]>(
    `JSON.stringify([...document.querySelectorAll('[role=option]')].map((o) => ({ label: o.querySelector('.menu-option-label').textContent, keys: o.querySelector('.keycaps').textContent })))`,
  );
  for (const name of ['Back to you', 'Zoom in', 'Turn left', 'North up', 'Mute']) {
    const row = rows.find((r) => r.label === name);
    if (!row?.keys) throw new Error(`the menu has no "${name}" with its keys`);
  }
  await browser('wait', '500'); // its entrance has played
  await browser('screenshot', `${ARTIFACTS}smoke-menu.png`);
  await browser('press', 'Control+k');
  await browser('wait', '--fn', menu.closed);
  // Running a command: Mute, which says so, and the menu then offers Unmute.
  await runFromMenu('mute', 'Mute');
  await browser('wait', '--fn', `document.querySelector('.hint')?.textContent === 'Sound off'`);
  await runFromMenu('unmute', 'Unmute');
  await browser('wait', '--fn', `document.querySelector('.hint')?.textContent === 'Sound on'`);
  // ? opens the controls, every key and gesture.
  await browser('press', '?');
  await browser(
    'wait',
    '--fn',
    `document.querySelector('.menu-title')?.textContent === 'Controls and keys' && document.querySelectorAll('.key-row').length > 15`,
  );
  await browser('press', 'Control+k');
  await browser('wait', '--fn', menu.closed);
  // Opened with its button, a command still gives focus to the map, not back to the button.
  await browser('click', 'button[aria-label=Menu]');
  await browser('wait', '--fn', `${menu.open} && document.activeElement?.matches('.menu-search')`);
  await browser('keyboard', 'type', 'zoom in');
  await browser('wait', '--fn', `${menu.first} === 'Zoom in'`);
  await browser('press', 'Enter');
  await browser('wait', '--fn', menu.closed);
  console.log(
    `ok  menu: ${rows.length} rows; searched, ran Mute and Unmute, opened the controls, closed to the map`,
  );
}

/**
 * The time of day: T steps round to night, where windows and lamps are lit and the lamps'
 * light shows at every zoom; P lets the day pass (a frame loop) and holds it again.
 */
/** The time of day the app publishes on <html>, as the menu names it. */
const time = () => evalJson<string>('JSON.stringify(document.documentElement.dataset.time)');

async function expectNight(): Promise<void> {
  for (let i = 0; i < 6 && (await time()) !== 'night'; i++) {
    await browser('press', 't');
    await browser('wait', '300');
  }
  if ((await time()) !== 'night') throw new Error('T did not bring the night round');
  await browser('wait', '600');
  await expectHealthyPage('desktop at night');
  await browser('screenshot', `${ARTIFACTS}smoke-night.png`);
  await browser('press', 'p');
  await browser(
    'wait',
    '--fn',
    `document.querySelector('.hint')?.textContent === 'The day passes'`,
  );
  await browser('wait', '1500');
  await browser('press', 'p');
  await browser(
    'wait',
    '--fn',
    `document.querySelector('.hint')?.textContent === 'The day stands still'`,
  );
  await expectHealthyPage('desktop after the day passed a while');
  // Back to golden hour, the look the rest of the test is measured in.
  for (let i = 0; i < 6 && (await time()) !== 'golden'; i++) {
    await browser('press', 't');
    await browser('wait', '300');
  }
  console.log(
    'ok  night: lit windows and lamps, the day passed and stood still, golden hour again',
  );
}

/** Waits until `check` holds, for up to `ms`, or fails saying what didn't happen. */
async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) throw new Error(`${what} didn't happen within ${ms / 1000} s`);
    await Bun.sleep(100);
  }
}

const html = (name: string) => `document.documentElement.dataset.${name}`;

/**
 * Other people: a guest sees another player walk by, named over their head; joins from the
 * corner and is seen joining; changes shirt and is seen in it; comes back signed in where they
 * left after a reload; signs out. The other player is a bot speaking the protocol (smoke-bot.ts).
 */
async function expectPlayers(): Promise<void> {
  await browser('wait', '--fn', `${html('online')} === '0'`);
  const [x, z] = (await walker()).split(' ').map(Number) as [number, number];
  const bot = await startBot(API, BASE.slice(0, -1), 'smoke-bot', [x + 4, z + 4]);
  try {
    await browser('wait', '--fn', `${html('online')} === '1'`);
    for (let i = 0; i < 8; i++) await browser('press', '+');
    await browser('wait', '--fn', `Number(${canvasData('players')}) >= 1`);
    await browser(
      'wait',
      '--fn',
      `[...document.querySelectorAll('.player-tag')].some((t) => !t.hidden && t.textContent === 'smoke-bot')`,
    );
    await browser('wait', '600');
    await expectHealthyPage('desktop with another player');
    await browser('screenshot', `${ARTIFACTS}smoke-players.png`);
    console.log('ok  a guest sees another player walk by, their name over their head');

    // Joining, from the corner.
    await browser('click', 'button.you');
    await browser('wait', '--fn', `!!document.querySelector('dialog.account')?.open`);
    await browser('fill', 'dialog.account input[name=name]', 'smoke-anna');
    await browser('fill', 'dialog.account input[name=password]', 'smoke-password');
    await browser('press', 'Enter');
    await browser('wait', '--fn', `${html('account')} === 'smoke-anna'`);
    await until(() => bot.joined().includes('smoke-anna'), 'the bot seeing smoke-anna join');
    // A new look, worn at once and seen by the others.
    const blue = 0x4a77a8;
    await browser('click', `dialog.account input[value="${blue}"]`);
    await until(() => bot.outfitOf('smoke-anna')?.shirt === blue, 'the bot seeing the new shirt');
    await browser('wait', '400');
    await browser('screenshot', `${ARTIFACTS}smoke-account.png`);
    // Its close button: agent-browser's Escape hides the page, and a hidden page loads too slowly
    // for the reload below.
    await browser('click', 'dialog.account button[aria-label="Close"]');
    await browser('wait', '--fn', `!document.querySelector('dialog.account')?.open`);
    console.log('ok  joined from the corner, seen joining; a new shirt, seen at once');

    // Back where you left, still signed in, after a reload.
    await tapAt(760, 300);
    await browser('wait', '1500');
    await browser('wait', '--fn', `${canvasData('speed')} === '0.0'`); // arrived, or it walks on
    const left = await walker();
    await browser('wait', '1200'); // the socket sends at most ten times a second
    await openFresh(BASE);
    await browser('wait', '--fn', `${html('account')} === 'smoke-anna'`);
    await browser('wait', '--fn', `${html('online')} === '2'`);
    const [a, b] = [left, await walker()].map((p) => p.split(' ').map(Number));
    if (!(Math.hypot(a![0]! - b![0]!, a![1]! - b![1]!) < 3)) {
      throw new Error(`a reload didn't bring smoke-anna back where she left (${left} vs ${b})`);
    }
    await expectHealthyPage('desktop signed in, after a reload');
    console.log(`ok  a reload: still signed in, back where she left (${left})`);

    // Signing out: a guest again, gone for the others.
    await browser('click', 'button.you');
    await browser('wait', '--fn', `!!document.querySelector('dialog.account')?.open`);
    await browser('find', 'role', 'button', 'click', '--name', 'Sign out');
    await browser('wait', '--fn', `${html('account')} === ''`);
    await until(
      () => bot.heard.some((m) => m.type === 'leaves'),
      'the bot seeing smoke-anna leave',
    );
    await browser('press', 'Escape');
    console.log('ok  signed out: a guest again, and gone for the others');
  } finally {
    bot.close();
  }
}

/**
 * The full map: M opens it (its chunk loads then), it has a canvas and the Marks button, and
 * Escape shuts it again, giving the keys back to the map.
 */
async function expectMap(): Promise<void> {
  await browser(
    'eval',
    `localStorage.setItem('leuven-waypoints', '[{"id":"smoke","x":64,"z":50,"name":"Smoke","colour":"#d2553f"}]')`,
  );
  await browser('press', 'm');
  await browser('wait', '--fn', `!!document.querySelector('dialog.bigmap')?.open`);
  await browser('wait', '800'); // its first paint
  await browser('screenshot', `${ARTIFACTS}smoke-bigmap.png`);
  const parts = await evalJson<string[]>(
    `JSON.stringify([...document.querySelectorAll('dialog.bigmap .map-btn')].map((b) => b.getAttribute('aria-label')))`,
  );
  if (!parts.some((p) => p.startsWith('Marks'))) throw new Error('the map has no Marks button');
  await browser('press', 'Escape');
  await browser(
    'wait',
    '--fn',
    `!document.querySelector('dialog.bigmap') && document.activeElement === document.querySelector('.map')`,
  );
  console.log('ok  full map: M opens it with its tools, Escape shuts it');

  // A mark's Navigate walks there; the Stop pill shows while it does, and Escape lets go of it.
  const stop = `[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Stop'))`;
  await browser('press', 'm');
  await browser('wait', '--fn', `!!document.querySelector('dialog.bigmap')?.open`);
  await browser('click', 'dialog.bigmap .map-btn[aria-label^="Marks"]');
  await browser('click', '[aria-label="Navigate to Smoke"]');
  await browser('wait', '--fn', `!document.querySelector('dialog.bigmap') && ${stop}`);
  await expectNothingDrawnUnderMap(stop);
  // Dispatched, not pressed: agent-browser's Escape hides the page, which stops its frames.
  await holdKeys(['Escape'], 0);
  await browser('wait', '--fn', `!(${stop})`);
  console.log('ok  a mark: Navigate walks there, Stop shows, Escape lets go of the route');
}

/**
 * The map over the city while the avatar walks: not one WebGL draw call under it, and the city
 * drawn again once it shuts. Counted on the context itself, where every draw has to pass.
 */
async function expectNothingDrawnUnderMap(walking: string): Promise<void> {
  const names = `['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']`;
  const gl = `document.querySelector('canvas').getContext('webgl2')`;
  await browser('press', 'm');
  await browser('wait', '--fn', `!!document.querySelector('dialog.bigmap')?.open`);
  await browser(
    'eval',
    `(() => { const gl = ${gl}; window.smokeDraws = 0; for (const name of ${names}) { const real = gl[name].bind(gl); gl[name] = (...args) => { window.smokeDraws++; return real(...args); }; } })()`,
  );
  await browser('wait', '1000');
  const under = await evalJson<number>('JSON.stringify(window.smokeDraws)');
  if (under !== 0) throw new Error(`${under} draw calls under the open map`);
  if (!(await evalJson<boolean>(`JSON.stringify(${walking})`))) {
    throw new Error('the walk ended before the map was shown to stop the drawing');
  }
  await browser('press', 'm');
  await browser(
    'wait',
    '--fn',
    `!document.querySelector('dialog.bigmap') && window.smokeDraws > 0`,
  );
  await browser(
    'eval',
    `(() => { const gl = ${gl}; for (const name of ${names}) delete gl[name]; })()`,
  );
  console.log(
    'ok  nothing is drawn under the full map while the avatar walks, and the city comes back',
  );
}

/** Where the keys the smoke test holds sit on the keyboard: walking reads `code`, not `key`. */
const CODES: Record<string, string> = {
  w: 'KeyW',
  d: 'KeyD',
  e: 'KeyE',
  Shift: 'ShiftLeft',
  ' ': 'Space',
};

/** Holds keys down for a while, as a person walking would (agent-browser only taps keys). */
async function holdKeys(keys: string[], ms: number): Promise<void> {
  const send = (type: string) =>
    browser(
      'eval',
      keys
        .map(
          (key) =>
            `document.querySelector('.map').dispatchEvent(new KeyboardEvent('${type}', { key: '${key}', code: '${CODES[key] ?? key}', bubbles: true }))`,
        )
        .join(';'),
    );
  await send('keydown');
  await browser('wait', String(ms));
  await send('keyup');
}

const canvasData = (name: string) => `document.querySelector('canvas')?.dataset.${name}`;

const walker = () => evalJson<string>(`JSON.stringify(${canvasData('walker')} ?? '')`);

/** Pans and the like are no taps: the avatar must still be where it was. */
async function expectStill(after: string, before: string): Promise<void> {
  const now = await walker();
  // It publishes where it is each metre, and the last few centimetres of a stop once at rest.
  const [a, b] = [before, now].map((p) => p.split(' ').map(Number));
  if (!(Math.hypot(a![0]! - b![0]!, a![1]! - b![1]!) < 1.5)) {
    throw new Error(`${after} moved the avatar (${before} to ${now})`);
  }
  console.log(`ok  ${after} didn't move the avatar`);
}

/** Zooms in with the + key until the view shows the avatar's figure, then brings it back. */
async function zoomToStreet(): Promise<void> {
  for (let i = 0; i < 14; i++) await browser('press', '+');
  // Space, not Escape, which would first let go of a route being walked.
  await holdKeys([' '], 0);
  await browser('wait', '--fn', `${canvasData('avatar')} === 'true'`);
}

/**
 * The avatar, there from the start: zoom down to the street, walk and run it with the keys,
 * tap somewhere for it to walk to, and check the street sign.
 */
async function expectWalking(): Promise<void> {
  await browser('press', 'r');
  await browser('wait', '--fn', `!!${canvasData('walker')}`);
  await zoomToStreet();
  await browser('wait', '1500'); // the camera has come back to the avatar
  const start = await walker();
  await holdKeys(['d'], 800);
  await holdKeys(['Shift', 'w'], 800);
  // The avatar publishes where it stands once it has stopped.
  await browser('wait', '--fn', `${canvasData('walker')} !== ${JSON.stringify(start)}`);
  await expectHealthyPage('desktop walking');
  // The street sign names where the avatar stands, from OSM's names in city.bin.
  await browser('wait', '--fn', `!!document.querySelector('.sign-name')?.textContent`);
  const street = await evalJson<string>(
    `JSON.stringify(document.querySelector('.sign-name').textContent.replaceAll('\\u2011', '-'))`,
  );
  console.log(`ok  street sign close to the street: ${street}`);
  // A tap a little way off walks it there.
  const before = await walker();
  await tapAt(700, 360);
  await browser(
    'wait',
    '--timeout',
    '15000',
    '--fn',
    `${canvasData('walker')} !== ${JSON.stringify(before)}`,
  );
  console.log('ok  a tap walked the avatar there');
  await browser('screenshot', `${ARTIFACTS}smoke-walk.png`);
  // Zoomed out and back in, the map dragged off the avatar, then a tap near it: it must set off
  // every time, not only draw its path.
  for (const [dx, dy] of [
    [140, 90],
    [-160, 60],
    [100, -120],
    [-90, -80],
  ] as const) {
    await holdKeys([' '], 0);
    for (let i = 0; i < 5; i++) await browser('press', '-');
    for (let i = 0; i < 5; i++) await browser('press', '+');
    await browser('wait', '600');
    await drag(dx, dy);
    await browser('wait', '300');
    // The avatar is now (dx, dy) from the middle; a tap a little way from it.
    await tapAt(640 + dx - Math.sign(dx) * 70, 400 + dy - Math.sign(dy) * 50);
    await browser('wait', '--timeout', '3000', '--fn', `Number(${canvasData('speed')}) > 0`);
    await browser('wait', '--timeout', '15000', '--fn', `${canvasData('speed')} === '0.0'`);
  }
  console.log('ok  after zooming out and in and dragging the map, every tap nearby set off');
  // Back out to the whole city, where it isn't drawn at all.
  for (let i = 0; i < 16; i++) await browser('press', '-');
  await browser('wait', '--fn', `${canvasData('avatar')} === 'false'`);
  await expectHealthyPage('desktop zoomed back out');
}

/** The rack with bikes nearest the middle of the map, from the city file the page loads. */
async function nearestRack(): Promise<[number, number]> {
  const bytes = await Bun.file(new URL('../public/data/city.bin', import.meta.url)).bytes();
  const city = await unpackCity(bytes);
  const racks = city.props.filter((p) => p.kind === 'bikes' && bikesIn(p) > 0);
  const rack = racks.toSorted((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0]!;
  return [rack.x, rack.z];
}

const key = (type: string, code: string) =>
  `document.querySelector('.map').dispatchEvent(new KeyboardEvent('${type}', { key: '${code.slice(3).toLowerCase()}', code: '${code}', bubbles: true }))`;
const canvasNumber = async (name: string) =>
  Number(await evalJson<string>(`JSON.stringify(${canvasData(name)} ?? '')`));

/**
 * Riding: drag the map so the rack nearest the middle is in the middle of the view and tap it,
 * which sends the avatar there; F walks to its nearest bike and gets on, W rides and D turns,
 * F gets off and leaves the bike standing there.
 */
async function expectRiding(): Promise<void> {
  const [x, z] = await nearestRack();
  // North up and the view back on the avatar, at a zoom that shows a few streets.
  await browser('press', 'r');
  for (let i = 0; i < 4; i++) await browser('press', '+');
  // Standing still, so whatever moves it from here is the drag's doing.
  await browser('wait', '--fn', `${canvasData('speed')} === '0.0'`);
  await browser('wait', '1500');
  const before = await walker();
  const [ax, az] = before.split(' ').map(Number);
  const zoom = await canvasNumber('zoom');
  // The map turned a quarter from north: 800 px show 560 m at zoom 1, and the view is on the
  // avatar. A drag keeps the ground under the pointer: across by its screen width, along
  // foreshortened by the isometric pitch.
  const k = (800 * zoom) / 560;
  const s = Math.SQRT1_2;
  const [rx, rz] = [x - ax!, z - az!];
  const [dx, dy] = [-(rx * s - rz * s) * k, (-rx * s - rz * s) * k * Math.sqrt(1 / 3)];
  await browser('mouse', 'move', '640', '400');
  await browser('mouse', 'down');
  for (let i = 1; i <= 4; i++) {
    await browser(
      'mouse',
      'move',
      String(Math.round(640 + (dx * i) / 4)),
      String(Math.round(400 + (dy * i) / 4)),
    );
  }
  await browser('mouse', 'up');
  await browser('wait', '400');
  await expectStill('dragging the map', before);
  // A tap in the middle of the view, where the drag brought the rack, walks the avatar there.
  await tapAt(640, 400);
  await browser(
    'wait',
    '--timeout',
    '20000',
    '--fn',
    `${canvasData('walker')} !== ${JSON.stringify(before)} && !${canvasData('walker')}.includes('NaN')`,
  );
  await zoomToStreet();
  await browser(
    'wait',
    '--timeout',
    '30000',
    '--fn',
    `(() => { const [a, b] = ${canvasData('walker')}.split(' ').map(Number); return Math.hypot(a - ${x}, b - ${z}) < 28; })()`,
  );
  await browser('eval', key('keydown', 'KeyF'));
  await browser('eval', key('keyup', 'KeyF'));
  await browser('wait', '--timeout', '20000', '--fn', `${canvasData('ride')} === 'riding'`);
  await browser('wait', '500');
  await browser('eval', key('keydown', 'KeyW'));
  // The fastest it got within three seconds: the street may end in something in the way.
  let speed = 0;
  for (let i = 0; i < 12; i++) {
    await browser('wait', '250');
    speed = Math.max(speed, await canvasNumber('speed'));
  }
  await browser('eval', key('keydown', 'KeyD'));
  await browser('wait', '400');
  await browser('screenshot', `${ARTIFACTS}smoke-ride.png`);
  await browser('eval', `${key('keyup', 'KeyD')};${key('keyup', 'KeyW')}`);
  // A cruise is 11.5 m/s (ON_BIKE in avatar.ts); the street may end sooner.
  if (!(speed > 7)) throw new Error(`riding: ${speed} m/s at most pedalling 3 s (more than 7)`);
  console.log(`ok  riding: ${speed} m/s pedalling 3 s`);
  await expectHealthyPage('desktop riding');
  await browser('eval', `${key('keydown', 'KeyF')};${key('keyup', 'KeyF')}`);
  await browser(
    'wait',
    '--timeout',
    '10000',
    '--fn',
    `${canvasData('ride')} !== 'riding' && ${canvasData('dropped')} === '1'`,
  );
  console.log('ok  got off and left the bike standing');
  await expectHealthyPage('desktop after riding');
}

/** Long tasks that started after `since` (ms of page time). */
const tasksSince = (since: number) =>
  evalJson<number[]>(
    `new Promise((resolve) => {
      new PerformanceObserver((list, observer) => {
        observer.disconnect();
        resolve(JSON.stringify(list.getEntries().filter((e) => e.startTime > ${since}).map((e) => Math.round(e.duration))));
      }).observe({ type: 'longtask', buffered: true });
      setTimeout(() => resolve('[]'), 1000);
    })`,
  );

/** Presses a key on the map as a person would (agent-browser's Escape hides the page). */
const press = (name: string, code = name) =>
  browser(
    'eval',
    ['keydown', 'keyup']
      .map(
        (type) =>
          `document.querySelector('.map').dispatchEvent(new KeyboardEvent('${type}', { key: '${name}', code: '${code}', bubbles: true }))`,
      )
      .join(';'),
  );

/**
 * A room: the menu takes the view to Sint-Pieterskerk, a tap on the church walks the avatar to
 * the street beside it, where Enter (shown on its pill) takes it in: the roof lifted, its floors
 * drawn. Enter again takes it back out, with no long task either way.
 */
async function expectRoom(): Promise<void> {
  const before = await evalJson<number>('JSON.stringify(performance.now())');
  await runFromMenu('pieters', 'Sint-Pieterskerk');
  await browser('wait', '2000'); // the view has come down to its door
  // A tap on the church's wall (a tree hides its door from here) walks to the wall's foot.
  await tapAt(900, 580);
  await browser(
    'wait',
    '--timeout',
    '45000',
    '--fn',
    `${canvasData('door')} === 'sint-pieterskerk'`,
  );
  await browser(
    'wait',
    '--fn',
    `[...document.querySelectorAll('.action')].some((b) => b.textContent.includes('Go in'))`,
  );
  await press('Enter');
  await browser('wait', '--fn', `${canvasData('place')} === 'sint-pieterskerk'`);
  await browser(
    'wait',
    '--fn',
    // The plate draws its hyphens unbreakable (U+2011); read as a person would.
    `document.querySelector('.sign-name')?.textContent.replaceAll('\\u2011', '-') === 'Sint-Pieterskerk · Nave'`,
  );
  await browser('wait', '1500');
  await browser('screenshot', `${ARTIFACTS}smoke-room.png`);
  await expectHealthyPage('desktop inside Sint-Pieterskerk');
  await press('Enter');
  await browser('wait', '--fn', `${canvasData('place')} === ''`);
  const hitches = (await tasksSince(before)).filter((ms) => ms > 50);
  if (hitches.length)
    throw new Error(`going in and out of a room took ${hitches.join(', ')} ms tasks`);
  console.log('ok  beside Sint-Pieterskerk, Enter took the avatar in and out, no long task');
  await expectHealthyPage('desktop back out of the room');
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) {
      throw new Error(
        `vite preview exited (code ${server.exitCode}). Run \`bun run build\` first?`,
      );
    }
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {
      // not listening yet
    }
    await Bun.sleep(100);
  }
  throw new Error(`vite preview did not start on ${BASE}`);
}

const multiplayer = Bun.spawn(['bun', 'server/main.ts'], {
  env: {
    ...process.env,
    PORT: new URL(API).port,
    DATABASE_PATH: ':memory:',
    BETTER_AUTH_URL: BASE.slice(0, -1),
    DEBUG: 'leuven:*=warn',
  },
  stdout: 'ignore',
  stderr: 'inherit',
});
const server = Bun.spawn([`${BIN}vite`, 'preview', '--port', String(PORT), '--strictPort'], {
  env: { ...process.env, LEUVEN_SERVER: API },
  stdout: 'ignore',
  stderr: 'inherit',
});

try {
  await waitForServer();
  for (let i = 0; ; i++) {
    const up = await fetch(`${API}/api/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) break;
    if (i > 100 || multiplayer.exitCode !== null)
      throw new Error('the multiplayer server did not start');
    await Bun.sleep(100);
  }
  await Bun.write(`${ARTIFACTS}.keep`, ''); // agent-browser won't create the folder
  await browser('open', 'about:blank');

  await browser('set', 'viewport', '1280', '800');
  await openFresh(BASE);
  await expectHealthyPage('desktop 1280×800');
  await expectShortTasks('desktop 1280×800');
  await expectCreditsShown();
  await expectBareMap();
  await expectMenu();
  await expectMap();
  // Exercise every control once, then check nothing broke.
  await browser('press', 'e');
  await browser('press', 'r');
  await browser('wait', '400');
  await expectHealthyPage('desktop after rotate and reset');
  await browser('screenshot', `${ARTIFACTS}smoke-desktop.png`);
  for (let i = 0; i < 6; i++) await browser('press', '+');
  await browser('wait', '200');
  await expectHealthyPage('desktop zoomed in');
  await browser('screenshot', `${ARTIFACTS}smoke-detail.png`);
  await expectNight();
  // All the way out is the most city on screen at once: the heaviest steady frame.
  for (let i = 0; i < 12; i++) await browser('press', '-');
  await browser('wait', '400');
  await expectHealthyPage('desktop zoomed out');
  await browser('screenshot', `${ARTIFACTS}smoke-overview.png`);
  // At night the lamps' glow is a draw call more per cell in view, at every zoom: the most
  // calls a frame ever has.
  for (let i = 0; i < 6 && (await time()) !== 'night'; i++) {
    await browser('press', 't');
    await browser('wait', '300');
  }
  await browser('wait', '600');
  await expectHealthyPage('desktop zoomed out at night');
  await browser('screenshot', `${ARTIFACTS}smoke-overview-night.png`);
  for (let i = 0; i < 6 && (await time()) !== 'golden'; i++) {
    await browser('press', 't');
    await browser('wait', '300');
  }
  // Panning out there redraws the shadow map for the most city at once: the heaviest frames.
  for (const [dx, dy] of [
    [-500, -250],
    [-500, 250],
    [600, 400],
  ]) {
    await drag(dx!, dy!);
  }
  await browser('wait', '400');
  await expectHealthyPage('desktop zoomed out, panned');

  await expectWalking();
  await expectRiding();
  await expectRoom();
  await expectPlayers();

  await browser('set', 'viewport', '390', '844');
  await openFresh(BASE);
  await expectHealthyPage('phone 390×844');
  await expectShortTasks('phone 390×844');
  await browser('screenshot', `${ARTIFACTS}smoke-phone.png`);
  // On a phone the menu button opens the menu as a sheet; its close button shuts it.
  await browser('click', 'button[aria-label=Menu]');
  await browser('wait', '--fn', menu.open);
  await browser('wait', '500');
  await browser('screenshot', `${ARTIFACTS}smoke-phone-menu.png`);
  await browser('click', 'dialog.menu:not(.account) button.menu-close');
  await browser('wait', '--fn', menu.closed);
  console.log('ok  phone: the menu button opens the menu; its close button shuts it, to the map');
  console.log(`screenshots in .artifacts/`);
} catch (error) {
  console.error(`\nSMOKE FAILED  ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await browser('close').catch(() => {});
  server.kill();
  multiplayer.kill();
}
