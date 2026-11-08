/**
 * Frame times in a real headless Chrome on hardware GL (docs/RENDERING.md): the map and the
 * street, on a desktop and a phone viewport, at full speed and at 4× CPU throttle, with a swarm of
 * other players around (scripts/swarm.ts). Prints one Markdown table.
 *
 *   bun run build && bun run build:server && bun scripts/perf.ts
 *   bun scripts/perf.ts --bots 0,50 --views map --viewports desktop --cpus 1
 *
 * Never pass --disable-frame-rate-limit to the browser: uncapped, the walk loop floods the GPU
 * queue with stalls that look like a shader problem and are not.
 */

const flag = (name: string, fallback: string) => {
  const at = Bun.argv.indexOf(`--${name}`);
  return (at < 0 ? fallback : Bun.argv[at + 1]!).split(',');
};

type Scenario = { name: string; bots: number; spread: number };
const SCENARIOS: Record<string, Scenario> = {
  '0': { name: '0', bots: 0, spread: 0 },
  // In view at the street: a few dozen round the avatar.
  '50': { name: '50 near', bots: 50, spread: 35 },
  // Connected all over the city.
  '1000': { name: '1000 city', bots: 1000, spread: 1200 },
  // The worst the map can ask of it: everyone on and round Grote Markt.
  crowd: { name: '1000 crowd', bots: 1000, spread: 90 },
};

const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  phone: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
} as const;

const scenarios = flag('bots', '0,50,1000').map((k) => SCENARIOS[k]!);
const views = flag('views', 'map,walk');
const viewports = flag('viewports', 'desktop,phone') as (keyof typeof VIEWPORTS)[];
const cpus = flag('cpus', '1,4').map(Number);
const seconds = Number(flag('seconds', '6')[0]);

const BIN = Bun.fileURLToPath(new URL('../node_modules/.bin/', import.meta.url));
const DATA = `${process.env.HOME}/.agent-browser/browsers/`;
const ARTIFACTS = Bun.fileURLToPath(new URL('../.artifacts/', import.meta.url));

async function chromePath(): Promise<string> {
  for await (const path of new Bun.Glob(
    '*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ).scan({ cwd: DATA })) {
    return DATA + path;
  }
  for await (const path of new Bun.Glob('*/chrome').scan({ cwd: DATA })) return DATA + path;
  throw new Error('no browser found: run `bunx agent-browser install`');
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = probe;
  await probe.stop(true);
  return port!;
}

interface Cdp {
  send<T = Record<string, unknown>>(method: string, params?: object): Promise<T>;
  /** Evaluates an expression in the page and returns its JSON value. */
  page<T>(expression: string): Promise<T>;
  close(): void;
}

function connect(url: string): Promise<Cdp> {
  const socket = new WebSocket(url);
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  let next = 0;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number } & Record<string, unknown>;
    if (message.id !== undefined) waiting.get(message.id)?.(message);
  });
  const send = <T>(method: string, params: object = {}) =>
    new Promise<T>((resolve, reject) => {
      const id = ++next;
      waiting.set(id, (message) => {
        waiting.delete(id);
        if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
        else resolve(message.result as T);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return new Promise((resolve) => {
    socket.addEventListener('open', () =>
      resolve({
        send,
        async page<T>(expression: string) {
          const { result, exceptionDetails } = await send<{
            result: { value?: T };
            exceptionDetails?: unknown;
          }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
          if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails));
          return result.value as T;
        },
        close: () => socket.close(),
      }),
    );
  });
}

/** A page expression: fires `key` on the map, down and up, as the shortcuts hear it. */
const tapKey = (key: string, code: string) =>
  `(()=>{const m=document.querySelector('.map');for(const t of ['keydown','keyup'])m.dispatchEvent(new KeyboardEvent(t,{key:'${key}',code:'${code}',bubbles:true}))})()`;

/**
 * Records frames for `ms` while the view keeps changing: on the map a wheel notch in and out each
 * frame (the map only draws when something changes), in the street walking in a square.
 */
const measure = (view: string, ms: number) => `(async () => {
  const c = document.querySelector('canvas');
  const map = document.querySelector('.map');
  let longest = 0;
  const watch = new PerformanceObserver((l) => { for (const e of l.getEntries()) longest = Math.max(longest, e.duration); });
  watch.observe({ entryTypes: ['longtask'] });
  const frames = [];
  const widths = [];
  let last = performance.now();
  const keys = [['w','KeyW'],['d','KeyD'],['s','KeyS'],['a','KeyA']];
  const key = (type, [k, code]) => map.dispatchEvent(new KeyboardEvent(type, { key: k, code, bubbles: true }));
  let side = 0;
  ${view === 'walk' ? `key('keydown', keys[0]);` : ''}
  const turn = ${view === 'walk'} && setInterval(() => { key('keyup', keys[side % 4]); side++; key('keydown', keys[side % 4]); }, 900);
  let sign = 1;
  await new Promise((done) => {
    const start = last;
    const step = (now) => {
      frames.push(now - last);
      widths.push(c.width);
      last = now;
      ${
        view === 'map'
          ? `c.dispatchEvent(new WheelEvent('wheel', { deltaY: 60 * (sign = -sign), clientX: innerWidth / 2, clientY: innerHeight / 2, bubbles: true, cancelable: true }));`
          : ''
      }
      if (now - start < ${ms}) requestAnimationFrame(step); else done();
    };
    requestAnimationFrame(step);
  });
  if (turn) { clearInterval(turn); key('keyup', keys[side % 4]); }
  watch.disconnect();
  const d = c.dataset;
  return { frames: frames.slice(1), longest, widths: [...new Set(widths)], calls: +d.drawCalls, triangles: +d.triangles, players: +(d.players ?? 0), scale: d.scale };
})()`;

const summarize = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    fps: Math.round((1000 * values.length) / sum),
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    max: sorted.at(-1) ?? 0,
    over20: values.filter((v) => v > 20).length,
  };
};

async function startSwarm(s: Scenario, api: string, at: string) {
  if (!s.bots) return { stop: async () => null as null };
  const proc = Bun.spawn(
    [
      'bun',
      'scripts/swarm.ts',
      '--bots',
      String(s.bots),
      '--spread',
      String(s.spread),
      '--at',
      at,
      '--api',
      api,
      '--seconds',
      '1000000',
      '--settle',
      '1000',
    ],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  // Long enough for the sockets to open and the joins to land.
  await Bun.sleep(Math.max(1500, s.bots * 6));
  return {
    async stop() {
      proc.kill();
      await proc.exited;
      return null;
    },
  };
}

await Bun.$`mkdir -p ${ARTIFACTS}`.quiet();
const [apiPort, sitePort, debugPort] = await Promise.all([freePort(), freePort(), freePort()]);
const API = `http://127.0.0.1:${apiPort}`;
const SITE = `http://localhost:${sitePort}/`;
const multiplayer = Bun.spawn(['bun', 'server/main.ts'], {
  env: {
    ...process.env,
    PORT: String(apiPort),
    DATABASE_PATH: `${ARTIFACTS}swarm.sqlite`,
    DEBUG: 'none',
  },
  stdout: 'ignore',
  stderr: 'inherit',
});
const site = Bun.spawn([`${BIN}vite`, 'preview', '--port', String(sitePort), '--strictPort'], {
  env: { ...process.env, LEUVEN_SERVER: API },
  stdout: 'ignore',
  stderr: 'ignore',
});
const profile = `${ARTIFACTS}perf-profile`;
await Bun.$`rm -rf ${profile}`.quiet();
const chrome = Bun.spawn(
  [
    await chromePath(),
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--mute-audio',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--use-angle=metal',
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdout: 'ignore', stderr: 'ignore' },
);

let cdp: Cdp | undefined;
const rows: string[][] = [];
try {
  for (let i = 0; i < 200; i++) {
    const up = await fetch(`${SITE}index.html`).then(
      (r) => r.ok,
      () => false,
    );
    const api = await fetch(`${API}/api/health`).then(
      (r) => r.ok,
      () => false,
    );
    const debug = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(
      (r) => r.ok,
      () => false,
    );
    if (up && api && debug) break;
    await Bun.sleep(100);
  }
  const targets = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as {
    type: string;
    webSocketDebuggerUrl: string;
  }[];
  cdp = await connect(targets.find((t) => t.type === 'page')!.webSocketDebuggerUrl);
  const { send, page } = cdp;
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Performance.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });

  /** Loads the page at a viewport, waits for the map and the avatar, ready to be measured. */
  const load = async (viewport: keyof typeof VIEWPORTS) => {
    await send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await send('Emulation.setDeviceMetricsOverride', VIEWPORTS[viewport]);
    await send('Page.navigate', { url: SITE });
    for (let i = 0; i < 300; i++) {
      await Bun.sleep(100);
      const ready = await page<boolean>(
        `document.documentElement.dataset.state === 'ready' && !!document.querySelector('canvas')?.dataset.walker`,
      ).catch(() => false);
      if (ready) return;
    }
    throw new Error('the page did not get ready');
  };

  await load('desktop');
  const renderer = await page<string>(`(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    return gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL);
  })()`);
  console.error(`GPU: ${renderer}`);
  const walker = await page<string>(`document.querySelector('canvas').dataset.walker`);
  const at = walker.split(' ').join(',');

  for (const scenario of scenarios) {
    const swarm = await startSwarm(scenario, API, at);
    for (const viewport of viewports) {
      await load(viewport);
      await Bun.sleep(1500); // the idle builder's first slices and the joins
      for (const view of views) {
        if (view === 'walk') {
          for (let i = 0; i < 14; i++) await page(tapKey('+', 'Equal'));
          await page(tapKey(' ', 'Space'));
          await Bun.sleep(1500);
        }
        for (const cpu of cpus) {
          await send('Emulation.setCPUThrottlingRate', { rate: cpu });
          await Bun.sleep(500);
          const before = await send<{ metrics: { name: string; value: number }[] }>(
            'Performance.getMetrics',
          );
          const result = await page<{
            frames: number[];
            longest: number;
            widths: number[];
            calls: number;
            triangles: number;
            players: number;
          }>(measure(view, seconds * 1000));
          const after = await send<{ metrics: { name: string; value: number }[] }>(
            'Performance.getMetrics',
          );
          const metric = (m: typeof after, name: string) =>
            m.metrics.find((x) => x.name === name)?.value ?? 0;
          const script =
            ((metric(after, 'ScriptDuration') - metric(before, 'ScriptDuration')) / seconds) * 100;
          const s = summarize(result.frames);
          const row = [
            scenario.name,
            viewport,
            view,
            `${cpu}×`,
            String(s.fps),
            s.p95.toFixed(1),
            s.max.toFixed(1),
            String(s.over20),
            String(result.calls),
            `${Math.round(result.triangles / 1000)}k`,
            String(result.players),
            `${(metric(after, 'JSHeapUsedSize') / 2 ** 20).toFixed(0)} MB`,
            `${Math.round(result.longest)} ms`,
            `${script.toFixed(0)}%`,
            result.widths.join('/'),
          ];
          rows.push(row);
          console.error(row.join(' | '));
        }
      }
      await send('Emulation.setCPUThrottlingRate', { rate: 1 });
    }
    await swarm.stop();
    await Bun.sleep(1000);
  }
  const head = [
    'players',
    'viewport',
    'view',
    'cpu',
    'fps',
    'p95 ms',
    'max ms',
    '>20 ms',
    'calls',
    'tris',
    'drawn',
    'heap',
    'longest task',
    'script',
    'canvas w',
  ];
  console.log(`GPU: ${renderer}\n`);
  console.log(`| ${head.join(' | ')} |`);
  console.log(`| ${head.map(() => '---').join(' | ')} |`);
  for (const row of rows) console.log(`| ${row.join(' | ')} |`);
} catch (error) {
  console.error(`\nPERF FAILED  ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  cdp?.close();
  chrome.kill();
  site.kill();
  multiplayer.kill();
  await Bun.sleep(100);
  process.exit();
}
