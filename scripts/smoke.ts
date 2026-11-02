/**
 * Opens the production build in a real headless browser (agent-browser) and fails on load
 * errors, console errors, a broken first render or a render over budget. Screenshots for
 * desktop and phone land in .artifacts/ for a human (or agent) to look at.
 *
 *   bun run build && bun run smoke
 */

import { unpackCity } from '../src/data/format.ts';
import { bikesIn } from '../src/data/props.ts';

// A free port and a browser session of our own, so parallel runs (worktrees, agents) never meet.
const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const PORT = probe.port;
await probe.stop(true);
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
const MAX_DRAW_CALLS = 100;
const MAX_TRIANGLES = 600_000;
/**
 * What the whole city hands the GPU once every cell is built: 2.40M vertices and 57.7 MB since
 * racks park fewer bikes (it was 2.69M and 64.1 MB), 2.45M and 58.7 MB with what came since.
 * Rounder, spoked wheels, cranks, a chain guard, a kickstand, a lamp and a basket on the 3,632
 * parked bikes (83 triangles each where they were 43, asked for so they read up close) took it
 * to 2.72M and 64.9 MB. Just above, so nothing grows unnoticed.
 */
const MAX_VERTICES = 2_750_000;
const MAX_GEOMETRY_MB = 66;
/** The longest the main thread may be busy at once while the page loads (ms). */
const MAX_LONG_TASK_MS = 750;

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
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
 * drawn; then the map has no controls on it but the menu button.
 */
async function expectBareMap(): Promise<void> {
  const html = await (await fetch(BASE)).text();
  if (!html.includes('id="intro"') || !html.includes('role="progressbar"')) {
    throw new Error('the loading screen is not in the HTML');
  }
  await browser('wait', '--fn', `!document.getElementById('intro')`);
  const buttons = await evalJson<string[]>(
    `JSON.stringify([...document.querySelectorAll('main button')].filter((b) => b.checkVisibility() && !b.closest('dialog')).map((b) => b.getAttribute('aria-label') ?? b.textContent))`,
  );
  if (buttons.join() !== 'Menu') {
    throw new Error(`the map should show only the menu button, not ${buttons.join(', ')}`);
  }
  console.log('ok  loading screen in the HTML, then a bare map with the menu button');
}

const menu = {
  open: `!!document.querySelector('dialog.menu')?.open`,
  closed: `!document.querySelector('dialog.menu')?.open && document.activeElement === document.querySelector('.map')`,
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
  for (const name of ['Walk here', 'Zoom in', 'Turn left', 'Reset view', 'Mute']) {
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
  // Opened with its button, it still gives focus to the map, not back to the button.
  await browser('click', 'button.menu-trigger');
  await browser('wait', '--fn', `${menu.open} && document.activeElement?.matches('.menu-search')`);
  await browser('press', 'Escape');
  await browser('wait', '--fn', menu.closed);
  console.log(
    `ok  menu: ${rows.length} rows; searched, ran Mute and Unmute, opened the controls, closed to the map`,
  );
}

/** Where the keys the smoke test holds sit on the keyboard: walking reads `code`, not `key`. */
const CODES: Record<string, string> = { w: 'KeyW', d: 'KeyD', e: 'KeyE', Shift: 'ShiftLeft' };

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

/** Walking has started and the walker has dropped in and landed (it publishes where it stands). */
const landed = `${canvasData('walk')} === 'walk' && !!${canvasData('walker')}`;

/** Pans and the like are no taps: the map must still be the map, with nobody on it. */
async function expectOnMap(after: string): Promise<void> {
  const mode = await evalJson<string>(
    `JSON.stringify((${canvasData('walk')} ?? 'map') + ' ' + (${canvasData('walker')} ?? ''))`,
  );
  if (mode.trim() !== 'map') throw new Error(`${after} started a walk (${mode})`);
  console.log(`ok  ${after} didn't start a walk`);
}

/**
 * Walk mode: click a spot on the map, dive down to it while the walker drops in, walk, run and
 * turn the view a little, then fly back to the map.
 */
async function expectWalking(): Promise<void> {
  // From the default view, so landing back on the map costs what the first frame does.
  await browser('press', 'r');
  await browser('wait', '400');
  await browser('mouse', 'move', '640', '400');
  await browser('mouse', 'down');
  await browser('mouse', 'up');
  await browser('wait', '--fn', landed);
  const start = await evalJson<string>(`JSON.stringify(${canvasData('walker')})`);
  await holdKeys(['d'], 800);
  await holdKeys(['Shift', 'w'], 800);
  await holdKeys(['e'], 400);
  // The walker publishes where it stands once it has stopped and stopped idling.
  await browser('wait', '--fn', `${canvasData('walker')} !== ${JSON.stringify(start)}`);
  await expectHealthyPage('desktop walking');
  // The street sign names where the walker stands, from OSM's names in city.bin.
  await browser('wait', '--fn', `!!document.querySelector('.sign-name')?.textContent`);
  const street = await evalJson<string>(
    `JSON.stringify(document.querySelector('.sign-name').textContent)`,
  );
  console.log(`ok  street sign while walking: ${street}`);
  // House numbers and street plates hang on the facades round the walker (walk.bin).
  await browser('wait', '--fn', `Number(${canvasData('plates')}) > 0`);
  const plates = await evalJson<string>(`JSON.stringify(${canvasData('plates')})`);
  console.log(`ok  plates on the facades while walking: ${plates}`);
  await browser('screenshot', `${ARTIFACTS}smoke-walk.png`);
  // Back to the map from the menu (riding below goes back with Escape).
  await runFromMenu('map', 'Back to the map');
  // Back on the map once the flight up has landed.
  await browser(
    'wait',
    '--fn',
    `${canvasData('walk')} === 'map' && ${canvasData('walker')} === '' && ${canvasData('plates')} === '0'`,
  );
  await expectHealthyPage('desktop back on the map');
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
 * Riding: start a walk by the rack nearest the middle (the map dragged so it's in the middle of
 * the view, then W), F walks to its nearest bike and gets on, W pedals and D turns, F gets off and leaves
 * the bike standing there.
 */
async function expectRiding(): Promise<void> {
  const [x, z] = await nearestRack();
  await browser('press', 'r');
  // The map turned a quarter from north, at zoom 1: 800 px show 560 m. A drag moves the ground
  // under the pointer, across by its screen width and along by its depth.
  const k = 800 / 560;
  const s = Math.SQRT1_2;
  const [dx, dy] = [-(x * s - z * s) * k, ((-x * s - z * s) * k) / 2.82];
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
  await expectOnMap('dragging the map');
  // W walks from the street nearest the middle of the view.
  await browser('press', 'w');
  await browser('wait', '--fn', landed);
  await browser('eval', key('keydown', 'KeyF'));
  await browser('eval', key('keyup', 'KeyF'));
  await browser('wait', '--timeout', '20000', '--fn', `${canvasData('ride')} === 'riding'`);
  await browser('wait', '1000');
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
  // A cruise is 11.5 m/s, 95% of it in 3.1 s (rider.ts); the street may end sooner.
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
  await holdKeys(['Escape'], 0);
  await browser(
    'wait',
    '--fn',
    `${canvasData('walk')} === 'map' && ${canvasData('walker')} === ''`,
  );
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

const server = Bun.spawn([`${BIN}vite`, 'preview', '--port', String(PORT), '--strictPort'], {
  stdout: 'ignore',
  stderr: 'inherit',
});

try {
  await waitForServer();
  await Bun.write(`${ARTIFACTS}.keep`, ''); // agent-browser won't create the folder
  await browser('open', 'about:blank');

  await browser('set', 'viewport', '1280', '800');
  await openFresh(BASE);
  await expectHealthyPage('desktop 1280×800');
  await expectShortTasks('desktop 1280×800');
  await expectCreditsShown();
  await expectBareMap();
  await expectMenu();
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
  // All the way out is the most city on screen at once: the heaviest steady frame.
  for (let i = 0; i < 12; i++) await browser('press', '-');
  await browser('wait', '400');
  await expectHealthyPage('desktop zoomed out');
  await browser('screenshot', `${ARTIFACTS}smoke-overview.png`);
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
  await expectOnMap('panning the map');

  await expectWalking();
  await expectRiding();

  await browser('set', 'viewport', '390', '844');
  await openFresh(BASE);
  await expectHealthyPage('phone 390×844');
  await expectShortTasks('phone 390×844');
  await browser('screenshot', `${ARTIFACTS}smoke-phone.png`);
  // On a phone the menu button opens the menu as a sheet; its close button shuts it.
  await browser('click', 'button.menu-trigger');
  await browser('wait', '--fn', menu.open);
  await browser('wait', '500');
  await browser('screenshot', `${ARTIFACTS}smoke-phone-menu.png`);
  await browser('click', 'button.menu-close');
  await browser('wait', '--fn', menu.closed);
  console.log('ok  phone: the menu button opens the menu; its close button shuts it, to the map');
  console.log(`screenshots in .artifacts/`);
} catch (error) {
  console.error(`\nSMOKE FAILED  ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await browser('close').catch(() => {});
  server.kill();
}
