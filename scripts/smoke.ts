/**
 * Opens the production build in a real headless browser (agent-browser) and fails on load
 * errors, console errors, a broken first render or a render over budget. Screenshots for
 * desktop and phone land in .artifacts/ for a human (or agent) to look at.
 *
 *   bun run build && bun run smoke
 */

// A free port and a browser session of our own, so parallel runs (worktrees, agents) never meet.
const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const PORT = probe.port;
await probe.stop(true);
const SESSION = `leuven-smoke-${PORT}`;
const BASE = `http://localhost:${PORT}/`;
const ARTIFACTS = Bun.fileURLToPath(new URL('../.artifacts/', import.meta.url));
const BIN = Bun.fileURLToPath(new URL('../node_modules/.bin/', import.meta.url));
/**
 * Per-frame render budget, for every frame checked: the first one (which also draws the shadow
 * map) and the latest. The city is cut into cells and only those in view are drawn, two draw
 * calls each (surfaces, outlines); a frame that redraws the shadow map adds one per casting cell.
 */
const MAX_DRAW_CALLS = 100;
/** Every ordinary frame: what a mid-range phone draws smoothly while panning. */
const MAX_TRIANGLES = 600_000;
/** Frames that redraw the shadow map: only on load and when the view leaves the shadow square. */
const MAX_SHADOW_TRIANGLES = 800_000;

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
  // The first frame (published on <html> when ready) and the latest one (on the canvas).
  const frames = { first: page, latest: page.frame };
  const measured: string[] = [];
  for (const [name, frame] of Object.entries(frames)) {
    const calls = Number(frame.drawCalls);
    const triangles = Number(frame.triangles);
    // The first frame always draws the shadow map; later ones say whether they did.
    const shadow = name === 'first' || frame.shadowPass === 'true';
    const cap = shadow ? MAX_SHADOW_TRIANGLES : MAX_TRIANGLES;
    const capName = shadow ? 'shadow-frame cap' : 'frame cap';
    if (!(calls > 0 && calls <= MAX_DRAW_CALLS))
      problems.push(`${name} frame: ${calls} draw calls (max ${MAX_DRAW_CALLS})`);
    if (!(triangles > 0 && triangles <= cap))
      problems.push(`${name} frame: ${triangles} triangles (max ${cap}, ${capName})`);
    measured.push(
      `${name} ${calls} calls, ${triangles.toLocaleString()} tris / ${cap.toLocaleString()} ${capName}`,
    );
  }
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

/** The data licences require the credit to be visible at start (it may collapse later). */
async function expectCreditsShown(): Promise<void> {
  const credits = await evalJson<{ visible: boolean; text: string }>(
    'JSON.stringify({ visible: !document.getElementById("credits-text")?.hidden, text: document.getElementById("credits-text")?.textContent ?? "" })',
  );
  if (!credits.visible || !credits.text.includes('OpenStreetMap')) {
    throw new Error('the OpenStreetMap credit is not visible at start (ODbL attribution)');
  }
  console.log('ok  credits visible at start');
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

/**
 * Walk mode: start in the middle of the view, fly down behind the walker, walk, run and turn
 * the view a little, then fly back to the map.
 */
async function expectWalking(): Promise<void> {
  // From the default view, so landing back on the map costs what the first frame does.
  await browser('press', 'r');
  await browser('press', 'w');
  await browser('wait', '--fn', `${canvasData('walk')} === 'pick'`);
  await browser('press', 'Enter');
  await browser('wait', '--fn', `${canvasData('walk')} === 'walk'`);
  const start = await evalJson<string>(`JSON.stringify(${canvasData('walker')})`);
  await holdKeys(['d'], 800);
  await holdKeys(['Shift', 'w'], 800);
  await holdKeys(['e'], 400);
  // The walker publishes where it stands once it has stopped and stopped idling.
  await browser('wait', '--fn', `${canvasData('walker')} !== ${JSON.stringify(start)}`);
  await expectHealthyPage('desktop walking');
  await browser('screenshot', `${ARTIFACTS}smoke-walk.png`);
  await browser('press', 'Escape');
  // Back on the map once the flight up has landed.
  await browser(
    'wait',
    '--fn',
    `${canvasData('walk')} === 'map' && ${canvasData('walker')} === ''`,
  );
  await expectHealthyPage('desktop back on the map');
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
  await expectCreditsShown();
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

  await expectWalking();

  await browser('set', 'viewport', '390', '844');
  await openFresh(BASE);
  await expectHealthyPage('phone 390×844');
  await browser('screenshot', `${ARTIFACTS}smoke-phone.png`);
  console.log(`screenshots in .artifacts/`);
} catch (error) {
  console.error(`\nSMOKE FAILED  ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await browser('close').catch(() => {});
  server.kill();
}
