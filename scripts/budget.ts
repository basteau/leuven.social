/**
 * Fails the build when what users download grows past the budget. Sizes are gzipped, as served.
 * Raise a limit only on purpose, in the same change that needs it, and say why in the commit.
 *
 *   bun run build && bun run budget
 */

import * as Compress from '@portable/compress';

const KB = 1024;
// A budget counts the files its pattern matches, or with `closure`, those files and every chunk
// they import statically: what the browser fetches before the first frame, however the bundler
// happens to split it.
const BUDGETS: {
  label: string;
  pattern: string;
  limit: number;
  gzip: boolean;
  closure?: boolean;
}[] = [
  {
    label: 'App shell JS (React + the shell)',
    pattern: 'assets/index-*.js',
    // 84: just above 83.2 KB, with a stall-watching load, a menu that fails without blanking the
    // map, and one press for a held key. It had 7 KB of slack nothing asked for.
    limit: 84 * KB,
    gzip: true,
  },
  // The engine, and the palette it shares with the chunks it loads later (vite.config.ts).
  // 166: panning and zooming the map with our own controls (map-controls.ts) instead of three's
  // MapControls took it from 170.1 to 165.9 KB.
  {
    label: '3D engine JS (three.js)',
    pattern: 'assets/{viewer,palette}-*.js',
    limit: 166 * KB,
    gzip: true,
  },
  // 3.5: just above 3.1 KB.
  { label: 'CSS', pattern: 'assets/*.css', limit: 3.5 * KB, gzip: true },
  // The page itself paints the loading screen before any script or stylesheet: the tokens, its
  // styles and the diorama's SVG are inline (about 3 KB of it the little town).
  // 7: just above 6.7 KB.
  { label: 'HTML (the loading screen)', pattern: 'index.html', limit: 7 * KB, gzip: true },
  // The menu loads while the city is built: its list, search, pages, icons and places.
  {
    label: 'Menu JS (while building)',
    pattern: 'assets/command-menu-*.js',
    // 6: just above 5.8 KB.
    limit: 6 * KB,
    gzip: true,
  },
  // The whole R23 ring plus Heverlee; the ceiling agreed for the city data is 1 MB.
  { label: 'City data (already gzipped)', pattern: 'data/city.bin', limit: 1024 * KB, gzip: false },
  // Walk mode downloads the first time someone walks (or hovers Walk), not with the map. The
  // walker's planted-foot gait, its rig and its bevelled, inked figure take about 1.8 KB of it,
  // and walking on the terrain about 0.6 KB more: 16 KB. Riding gets a chunk of its own.
  // 16.5: riding's hooks (fetching its chunk near a rack, handing it the body, the camera's
  // retuning) and the collide and slide, pose IK and parked-bike lookup it shares from here.
  // 18: starting a walk where someone clicks, GTA style (about 1.5 KB): the marker that drops
  // on the spot and the dust of the landing, the walker dropping in and settling, its wave
  // leaving, the dive, the cross-fade for reduced motion and flights that turn round midway.
  // 20: the figure's polish (about 1.5 KB): its collar, placket, pocket, belt, hands, face and
  // hair as data, and the gait's counter-rotation, idle weight shift, stop and landing.
  // Still 20 at 19.9: standing on the drawn ground, routing round dropped bikes and starting a
  // walk from the side when a house is behind the walker added 0.4 KB.
  {
    label: 'Walk mode JS (on first walk)',
    pattern: 'assets/walk-*.js',
    limit: 20 * KB,
    gzip: true,
  },
  // The street-name lookup for the sign, a chunk beside walk mode's that loads with it.
  {
    label: 'Street names JS (with walk mode)',
    pattern: 'assets/streets-*.js',
    limit: 1.5 * KB,
    gzip: true,
  },
  // Riding loads near a rack (or on F): the bike's physics, rig and model, the rider's pose, the
  // glue that takes and leaves bikes, and its sounds. The plan said 7 KB; riding along a route,
  // swinging a racked bike round to the open street and baking the bikes left about the city
  // into one mesh took it to about 8.8. 10: the richer bike asked for (round spoked wheels,
  // mudguards, a chain and its guard, a lamp, a bell, grips, carrier stays, a basket) and the
  // rider's arms reaching bars turned twice as far took it to about 9.6. 12: getting on and off
  // asked for (about 2.4 KB): rolling a bike out of its rack and walking it round, the keyed
  // swing of a leg over the carrier with legs that splay to planted feet, the kickstand, stepping
  // away and handing the camera and the walk back smoothly.
  {
    label: 'Riding JS (near a rack)',
    pattern: 'assets/ride-*.js',
    limit: 12 * KB,
    gzip: true,
  },
  // The plates on the facades load after walk mode, in a chunk and a data file of their own.
  // 6: the shops' name boards (fitting a name to its front, its paint at 4.5:1, hanging it on
  // the awning's valance or the fascia, and the shader that paints under the letters) took the
  // chunk from 4.6 to 5.6 KB. 5.8: just above that.
  {
    label: 'Facade plates JS (on first walk)',
    pattern: 'assets/plates-*.js',
    limit: 5.8 * KB,
    gzip: true,
  },
  // Street furniture, monuments and the shop fronts' awnings, signs and terraces load once the
  // first frame is drawn, with the prop and terrace footprints they share with walk mode.
  // 6: the storefronts' shapes and the fronts' places on their walls added 1.6 KB.
  // 7: standing each parked bike on the ground as drawn (the layers' outlines) and the bikes'
  // detail asked for (round spoked wheels, cranks, chain guard, kickstand, lamp, basket) took it
  // from 5.4 to 6.7 KB.
  {
    label: 'Furniture JS (after first frame)',
    pattern: 'assets/{furniture,props,shops}-*.js',
    limit: 7 * KB,
    gzip: true,
  },
  // About 11.6k house numbers and 1.8k street plates are 67 KB, and 1.1k shop name boards 17 KB
  // more; room for the map to grow.
  { label: 'Plates data (already gzipped)', pattern: 'data/walk.bin', limit: 96 * KB, gzip: false },
  // What the first visit downloads: the page's scripts and every chunk they import statically
  // (the shell, the engine, the palette and whatever the bundler splits off them), not the
  // chunks loaded later.
  // 252: land use from relations, data-chosen monuments and hold-to-turn together passed 250.
  // 253: the parked bikes' looks, rails and notes (+0.7 KB). Furniture and monument drawing then
  // moved to a chunk of their own, taking what they share with the engine as a kit, as plates.ts
  // does; only the palette, which scene/props.ts imports, loads as a chunk of its own beside it.
  // 250: panning and zooming with our own map controls (map-controls.ts) took 4.4 KB off; the
  // load, menu and key fixes put 0.4 back: 249.2 KB.
  {
    label: 'First-load JS',
    pattern: 'assets/{index,viewer}-*.js',
    limit: 250 * KB,
    gzip: true,
    closure: true,
  },
];

const dist = new URL('../dist/', import.meta.url);
const distPath = Bun.fileURLToPath(dist);

/** The chunks `files` import statically (`import … from"./x.js"`, `import"./x.js"`), and theirs. */
async function staticClosure(files: string[], read: (file: string) => Promise<string>) {
  const seen = new Set(files);
  const queue = [...files];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    const dir = file.slice(0, file.lastIndexOf('/') + 1);
    for (const [, name] of (await read(file)).matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/g)) {
      const next = dir + name;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return [...seen].toSorted();
}

const rows = await Promise.all(
  BUDGETS.map(async ({ label, pattern, limit, gzip, closure }) => {
    const matched = await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: distPath }));
    const files = closure
      ? await staticClosure(matched, (file) => Bun.file(new URL(file, dist)).text())
      : matched;
    const sizes = await Promise.all(
      files.map(async (file) => {
        const bytes = await Bun.file(new URL(file, dist)).bytes();
        return gzip ? (await Compress.encode(bytes)).length : bytes.length;
      }),
    );
    const size = sizes.reduce((a, b) => a + b, 0);
    return { label, size, limit, missing: files.length === 0 };
  }),
);

let failed = false;
for (const { label, size, limit, missing } of rows) {
  const over = missing || size > limit;
  failed ||= over;
  const status = missing ? 'MISSING' : over ? 'OVER' : 'ok';
  console.log(
    `${status.padEnd(7)} ${label.padEnd(30)} ${(size / KB).toFixed(1).padStart(7)} KB / ${limit / KB} KB`,
  );
}
if (failed) {
  console.error('\nBudget exceeded. Run `bun run build` first if dist/ is missing.');
  process.exit(1);
}
