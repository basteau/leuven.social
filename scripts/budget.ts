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
    // 85: the time of day (1.5 KB): its keyframes and clock (daylight.ts, which the shell and
    // the engine share, so the bundler keeps it with the shell), the sky tokens, T and P.
    limit: 85 * KB,
    gzip: true,
  },
  // The engine, and the palette it shares with the chunks it loads later (vite.config.ts).
  // 166: panning and zooming the map with our own controls (map-controls.ts) instead of three's
  // MapControls took it from 170.1 to 165.9 KB.
  {
    label: '3D engine JS (three.js)',
    pattern: 'assets/{viewer,palette}-*.js',
    // 168: livelier facades asked for (1.4 KB): frames, sills and flower boxes on ordinary
    // windows, the Stadhuis's tiers of niches with their statues, tracery in the churches'
    // lancets, the parasols' valances and the café guests' colours.
    // 170.5: each house its own style (1.8 KB): arched or tall windows with balcony rails,
    // cornices, string courses, plinths, shutters, front doors, brick courses, shop doors and
    // mullions, windows that light up at night, and chimneys, dormers and roof windows.
    // 172: the traffic's hooks (1.2 KB): loading its chunk, the live loop that steps it and
    // the day, keeping it round the view, and counting it in the frame budget.
    // 172.5: the kerbstones along the carriageways (0.3 KB), asked for so the pavements read.
    limit: 172.5 * KB,
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
    // 6: just above 5.8 KB. 6.5: Time of day and Let the day pass, with their icons (0.4 KB).
    limit: 6.5 * KB,
    gzip: true,
  },
  // The whole R23 ring plus Heverlee; the ceiling agreed for the city data is 1 MB.
  { label: 'City data (already gzipped)', pattern: 'data/city.bin', limit: 1024 * KB, gzip: false },
  // The avatar loads once the first frame is drawn: its figure, walking it by the screen,
  // routes and jumps, the marker, and the camera following it. Walk mode was 20.5 KB with its
  // chase camera, flight, sky dome, thumb stick and spawn dive; one camera and one avatar took
  // that to about 13.2 KB. 19: the rooms inside the landmarks (5.4 KB): reading and checking
  // rooms.json, each floor's walk grid, its meshes, the stairs, and going in and out. They ride
  // here: a chunk loaded from this one would split three.js off the engine.
  {
    label: 'Avatar JS (after first frame)',
    pattern: 'assets/avatar-layer-*.js',
    limit: 19 * KB,
    gzip: true,
  },
  // The street-name lookup for the sign, a chunk beside the avatar's that loads with it.
  {
    label: 'Street names JS (with the avatar)',
    pattern: 'assets/streets-*.js',
    limit: 1.5 * KB,
    gzip: true,
  },
  // Bikes load near a rack (or on F): taking and leaving one, the bell, the bikes left standing.
  // Riding was 12 KB with its kinematic bicycle, rider IK and scripted mounts; a bike is now the
  // avatar at a bike's paces, drawn as the traffic's own cyclist, at about 2.8 KB. 3.5: the
  // rider's x-ray silhouette behind houses, as the walker has (0.3 KB).
  {
    label: 'Bikes JS (near a rack)',
    pattern: 'assets/bikes-*.js',
    limit: 3.5 * KB,
    gzip: true,
  },
  // The traffic loads once the first frame is drawn: the road graph and its router, the
  // vehicles' driving (routes, lanes, corners, junctions), their shapes and the instanced layer
  // that draws them. 9: routes, corners, junctions, people, the richer models and their lights
  // and limbs took it from 4.7 to 8.2 KB.
  // 12: lanes from the kerbs, cars queuing behind bikes, routes by class, and the people and
  // cyclists near the view drawn as the walker's figure on the rideable bike (the figure's
  // shader, the near meshes and their tints) took it to 11.6 KB; the figure and the bike
  // themselves are chunks shared with walk mode and riding, counted below.
  // 12.5: the lamps' halos, beams in three strips that soften at the edges, and the bikes'
  // lamps and pools (0.3 KB), asked for. 13: standing on the slope and on the squares (the
  // squares found by their boxes), and no gridlock, at 12.6 KB. 14: corners and bends built
  // in lane space, spawning out of the view's corners and turning round at a cul-de-sac in
  // view (0.7 KB), at 13.3 KB. 17: the bike's rig (2.8 KB), its own chunk while riding shared
  // it, now rides here, as the avatar's bike draws the traffic's cyclist; the figure's chunk
  // below went from 6 KB to 3, so the two together are 20 KB as before.
  {
    label: 'Traffic JS (after first frame)',
    pattern: 'assets/vehicles-*.js',
    limit: 17 * KB,
    gzip: true,
  },
  // The walker's figure, shared by the traffic (which loads first) with the avatar, so the one
  // figure is drawn in every role.
  {
    label: 'Figure JS (with the traffic)',
    pattern: 'assets/figure-*.js',
    limit: 3 * KB,
    gzip: true,
  },
  // The plates on the facades load once the view comes down to the street, in a chunk and a
  // data file of their own.
  // 6: the shops' name boards (fitting a name to its front, its paint at 4.5:1, hanging it on
  // the awning's valance or the fascia, and the shader that paints under the letters) took the
  // chunk from 4.6 to 5.6 KB. 5.8: just above that.
  {
    label: 'Facade plates JS (near the street)',
    pattern: 'assets/plates-*.js',
    limit: 5.8 * KB,
    gzip: true,
  },
  // Street furniture, monuments and the shop fronts' awnings, signs and terraces load once the
  // first frame is drawn, with the prop and terrace footprints they share with the avatar.
  // 6: the storefronts' shapes and the fronts' places on their walls added 1.6 KB.
  // 7: standing each parked bike on the ground as drawn (the layers' outlines) and the bikes'
  // detail asked for (round spoked wheels, cranks, chain guard, kickstand, lamp, basket) took it
  // from 5.4 to 6.7 KB.
  {
    label: 'Furniture JS (after first frame)',
    pattern: 'assets/{furniture,props,shops}-*.js',
    // 8: a table under each of Oude Markt's parasols, chairs round it and people at them with
    // their drinks, and bay trees by café doors, asked for to liven the square (0.9 KB).
    // 8.5: each lamp's pool under its lantern, fading in two rings (0.1 KB).
    limit: 8.5 * KB,
    gzip: true,
  },
  // The rooms inside the landmarks, authored by hand, fetched near one.
  { label: 'Rooms data', pattern: 'data/rooms.json', limit: 80 * KB, gzip: true },
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
  // load, menu and key fixes put 0.4 back: 249.2 KB. 251: the livelier facades (1.4 KB).
  // 253.5: each house its own style, and roofs with chimneys and dormers (1.8 KB).
  // 256: a day and a night over the city (1.6 KB): the light's keyframes, the lamps' glow
  // and the sun that moves the shadows. 257.5: the traffic's hooks in the engine (1.2 KB).
  {
    label: 'First-load JS',
    pattern: 'assets/{index,viewer}-*.js',
    limit: 257.5 * KB,
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
