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
    // 85.5: the arrow that shows where you are, over your head far out and at the edge of the
    // screen when you're off it (0.4 KB), asked for. 87: other people (1.3 KB), asked for: who
    // you are in the corner (Join, or your name and how many are here), the account sheet and
    // the other players' chunk loaded once the map is up, the minimap's place and its key.
    // 87.5 and a bit: the full map's button, the Stop pill and their wiring (0.5 KB), merged onto
    // multiplayer's shell.
    limit: 88 * KB,
    gzip: true,
  },
  // The engine, and the palette it shares with the chunks it loads later (vite.config.ts).
  // 166: panning and zooming the map with our own controls (map-controls.ts) instead of three's
  // MapControls took it from 170.1 to 165.9 KB.
  {
    label: '3D engine JS (three.js)',
    pattern: 'assets/{viewer,palette}-*.js',
    // 169: the map's presence list, routes and zoom limit (0.4 KB). 168: livelier facades asked for (1.4 KB): frames, sills and flower boxes on ordinary
    // windows, the Stadhuis's tiers of niches with their statues, tracery in the churches'
    // lancets, the parasols' valances and the café guests' colours.
    // 170.5: each house its own style (1.8 KB): arched or tall windows with balcony rails,
    // cornices, string courses, plinths, shutters, front doors, brick courses, shop doors and
    // mullions, windows that light up at night, and chimneys, dormers and roof windows.
    // 172: the traffic's hooks (1.2 KB): loading its chunk, the live loop that steps it and
    // the day, keeping it round the view, and counting it in the frame budget.
    // 172.5: the kerbstones along the carriageways (0.3 KB), asked for so the pavements read.
    // 171.5: the traffic went (171.1 KB), so only real players walk the streets.
    // 172.5: the zoom-out limit, catenary wires, café colour families and the routes the full
    // map asks for (0.9 KB), merged onto multiplayer's engine.
    // 173: dynamic resolution (resolution.ts and its wiring, 0.4 KB), so a phone that can't keep
    // up with the street draws fewer pixels instead of dropping frames.
    // 177.5: the look of the city, asked for (3.7 KB): roofs in courses, painted grass, water,
    // windows with bars and curtains, floodlit churches, light baked over the streets and leaves
    // in puffs, all in the one material's shader rather than in geometry to download.
    // 179.5: puffs at every zoom in place of the faceted crowns, shapes of tree, shrubs and flower
    // beds, brick and stone in the walls, roof furniture (1.6 KB), asked for.
    // 180: the puffs' own shadow material (0.1 KB).
    limit: 180 * KB,
    gzip: true,
  },
  // 3.5: just above 3.1 KB. 3.75: the minimap, the other players' name tags and who you are in
  // the corner (0.4 KB). The account sheet's own styles load with it, below.
  // 4.1: the rail of view controls, the minimap's tab and the Go to pill (0.3 KB), asked for so
  // the map can be learnt without knowing the menu's keys.
  { label: 'CSS', pattern: 'assets/index-*.css', limit: 4.1 * KB, gzip: true },
  // 1.6: the search field and its results on the full map (0.1 KB), asked for so a street can be
  // found from there.
  { label: 'Map CSS (with the map)', pattern: 'assets/map-*.css', limit: 1.6 * KB, gzip: true },
  {
    label: 'Account sheet CSS (when opened)',
    pattern: 'assets/account-sheet-*.css',
    limit: 1.25 * KB,
    gzip: true,
  },
  // The account sheet: joining, signing in, and your look, fetched the first time it opens.
  {
    label: 'Account sheet JS (when opened)',
    pattern: 'assets/account-sheet-*.js',
    // 3: telling a guest who they are and that joining keeps a name of their own (0.4 KB).
    limit: 3 * KB,
    gzip: true,
  },
  // Other people, once the map is up: accounts, the presence socket (and Portable's
  // reconnecting WebSocket), the binary protocol and the smoothing between updates.
  {
    label: 'Multiplayer JS (once the map is up)',
    pattern: 'assets/multiplayer-*.js',
    // 9: interest management's messages (who comes into view and leaves it, compact moves, doors,
    // the count, the full map's dots) and telling the server where the map looks (0.9 KB).
    // 9.5: delta moves (0.2 KB), about 5 bytes for a figure nearby where a whole move is 9.
    // 9.75: guests and tabs (0.2 KB): who you are from the server, renames, and one tab driving.
    limit: 9.75 * KB,
    gzip: true,
  },
  // The page itself paints the loading screen before any script or stylesheet: the tokens, its
  // styles and the diorama's SVG are inline (about 3 KB of it the little town).
  // 7: just above 6.7 KB.
  { label: 'HTML (the loading screen)', pattern: 'index.html', limit: 7 * KB, gzip: true },
  // The menu loads while the city is built: its list, search, pages, icons and places.
  {
    label: 'Menu JS (while building)',
    pattern: 'assets/{command-menu,menu-icons}-*.js',
    // 6: just above 5.8 KB. 6.5: Time of day and Let the day pass, with their icons (0.4 KB).
    // 7: the minimap's toggle and Join Leuven or Your look, with their icons (0.3 KB).
    limit: 7 * KB,
    gzip: true,
  },
  // The whole R23 ring plus Heverlee; the ceiling agreed for the city data is 1 MB.
  { label: 'City data (already gzipped)', pattern: 'data/city.bin', limit: 1024 * KB, gzip: false },
  // The avatar loads once the first frame is drawn: its figure, walking it by the screen,
  // routes and jumps, the marker, and the camera following it. Walk mode was 20.5 KB with its
  // chase camera, flight, sky dome, thumb stick and spawn dive; one camera and one avatar took
  // that to about 13.2 KB. 19: the rooms inside the landmarks (5.4 KB): reading and checking
  // rooms.json, each floor's walk grid, its meshes, the stairs, and going in and out. They ride
  // here: a chunk loaded from this one would split three.js off the engine. 19.5: lining a
  // room's walls, going straight to a floor, and the review's fixes (rooms retried after a
  // failure, a late answer dropped, in and out with a step past the edge) took it to 19.3 KB,
  // still under walk mode's 20.5. Reading back what a tap touched (a square of depth round it,
  // the place meant from it, the places beside a building) took it to 19.7 KB. 22: the walker's figure (2.7 KB), a chunk of its own while
  // the traffic shared it, rides here now the traffic is gone: 21.5 KB. 24: the other players
  // (players.ts, crowd.ts: their figures, gaits and name tags), 2 KB. 25: with the tap's
  // read-back above, 24.2 KB.
  // 26: the pool of figures and the crowd's one draw call beyond them (0.8 KB), so a thousand
  // players on the map cost a few numbers each, not a rig and a tag.
  {
    label: 'Avatar JS (after first frame)',
    pattern: 'assets/avatar-layer-*.js',
    limit: 26 * KB,
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
  // rider's x-ray silhouette behind houses, as the walker has (0.3 KB). The rider and the
  // bike's rig, which rode in the traffic's chunk, are a chunk of their own below, shared with
  // the other players' riders: 2.6 KB.
  {
    label: 'Bikes JS (near a rack)',
    pattern: 'assets/bikes-*.js',
    limit: 3 * KB,
    gzip: true,
  },
  // The minimap: its index of the city's footprints and drawing them round you, once the map is up.
  {
    label: 'Minimap JS (once the map is up)',
    pattern: 'assets/minimap-view-*.js',
    limit: 2 * KB,
    gzip: true,
  },
  // The rider (rider.ts) and the bike's rig: the avatar's and the other players' bikes, loaded
  // with the bikes or when someone near rides. 6.5 KB, where the traffic and its figure were 20.
  {
    label: 'Rider JS (with the bikes)',
    pattern: 'assets/rider-*.js',
    limit: 7 * KB,
    gzip: true,
  },
  // The full map and its marks, and the raster of the city's layers: all lazy, when it is opened.
  { label: 'Map JS (lazy)', pattern: 'assets/map-*.js', limit: 8 * KB, gzip: true },
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
    // 10.75: a symbol sign for every trade (a cup, a croissant, a shirt, a bike…), what stands
    // by the doors (a barrel, crates of fruit, buckets of flowers), a barber's pole, and the
    // public places' banners, flags, hangings and marquees, asked for so the city reads without
    // words (2.2 KB).
    // 11: terrace layouts and menu boards, merged onto every trade's symbol (0.1 KB).
    // 13.75: bikes with open spoked wheels and mudguards, hoops and roofs for the racks, a lantern
    // on a slim post, a public place's door, medallion and flag, the dark at the foot of the walls
    // and the baked light (2.4 KB), asked for.
    // 14.25: the banks of the water and the street trees' pits (0.2 KB).
    // 14.5: contact bands mitred round corners and tapered at their ends, in place of a square
    // block at every building corner, and the lamps' light summed before it is flattened, asked
    // for (0.4 KB, after trimming).
    limit: 14.5 * KB,
    gzip: true,
  },
  // The rooms inside the landmarks, authored by hand, fetched near one.
  { label: 'Rooms data', pattern: 'data/rooms.json', limit: 80 * KB, gzip: true },
  // What the first visit downloads: the page's scripts and every chunk they import statically
  // (the shell, the engine, the palette and whatever the bundler splits off them), not the
  // chunks loaded later.
  // 252: land use from relations, data-chosen monuments and hold-to-turn together passed 250.
  // 253: the parked bikes' looks, rails and notes (+0.7 KB). Furniture and monument drawing then
  // moved to a chunk of their own, taking what they share with the engine as a kit, as the plates
  // did; only the palette, which scene/props.ts imports, loads as a chunk of its own beside it.
  // 250: panning and zooming with our own map controls (map-controls.ts) took 4.4 KB off; the
  // load, menu and key fixes put 0.4 back: 249.2 KB. 251: the livelier facades (1.4 KB).
  // 253.5: each house its own style, and roofs with chimneys and dormers (1.8 KB).
  // 256: a day and a night over the city (1.6 KB): the light's keyframes, the lamps' glow
  // and the sun that moves the shadows. 257.5: the traffic's hooks in the engine (1.2 KB).
  // 256.5: the traffic went (256.2 KB). 257: the minimap's place, its key and the store it
  // reads, and the other players' tags (0.5 KB). 258: who you are in the corner and the account
  // and multiplayer chunks' loading (1.1 KB), asked for. 258.5: the new kinds of front, public
  // places among them, in the shops' tables the engine reads (0.4 KB).
  {
    label: 'First-load JS',
    pattern: 'assets/{index,viewer}-*.js',
    // 260: the engine's and the shell's additions above (1 KB). 260.5: dynamic resolution (0.4 KB).
    // 264.75: the look of the city (3.9 KB), asked for; the engine's own note says what.
    // 267.5: the engine's additions above, and the city format's new layers (0.3 KB).
    // 269.5: the view's controls on the map, the first minute's coaching and the Go to pill in
    // the shell (1.7 KB), asked for so the map can be learnt without knowing its keys.
    limit: 269.5 * KB,
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
