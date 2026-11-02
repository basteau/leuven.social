/**
 * Fails the build when what users download grows past the budget. Sizes are gzipped, as served.
 * Raise a limit only on purpose, in the same change that needs it, and say why in the commit.
 *
 *   bun run build && bun run budget
 */

import * as Compress from '@portable/compress';

const KB = 1024;
const BUDGETS: { label: string; pattern: string; limit: number; gzip: boolean }[] = [
  { label: 'App shell JS (React + HUD)', pattern: 'assets/index-*.js', limit: 90 * KB, gzip: true },
  // The engine, and the palette it shares with the chunks it loads later (vite.config.ts).
  {
    label: '3D engine JS (three.js)',
    pattern: 'assets/{viewer,palette}-*.js',
    limit: 171 * KB,
    gzip: true,
  },
  { label: 'CSS', pattern: 'assets/*.css', limit: 6 * KB, gzip: true },
  // The whole R23 ring plus Heverlee; the ceiling agreed for the city data is 1 MB.
  { label: 'City data (already gzipped)', pattern: 'data/city.bin', limit: 1024 * KB, gzip: false },
  // Walk mode downloads the first time someone walks (or hovers Walk), not with the map.
  {
    label: 'Walk mode JS (on first walk)',
    pattern: 'assets/walk-*.js',
    limit: 14.5 * KB,
    gzip: true,
  },
  // The plates on the facades load after walk mode, in a chunk and a data file of their own.
  {
    label: 'Facade plates JS (on first walk)',
    pattern: 'assets/plates-*.js',
    limit: 5 * KB,
    gzip: true,
  },
  // Street furniture and monuments load once the first frame is drawn, with the prop footprints
  // they share with walk mode.
  {
    label: 'Furniture JS (after first frame)',
    pattern: 'assets/{furniture,props}-*.js',
    limit: 4 * KB,
    gzip: true,
  },
  // About 11k house numbers and 1.3k street plates are 64 KB; room for the map to grow by half.
  { label: 'Plates data (already gzipped)', pattern: 'data/walk.bin', limit: 96 * KB, gzip: false },
  // What the first visit downloads: the shell and the engine, not the chunks loaded later.
  // 252: land use from relations, data-chosen monuments and hold-to-turn together passed 250;
  // furniture and monument drawing moved to a chunk of their own to win some of it back.
  {
    label: 'First-load JS',
    pattern: 'assets/{index,viewer,palette}-*.js',
    limit: 252 * KB,
    gzip: true,
  },
];

const dist = new URL('../dist/', import.meta.url);
const distPath = Bun.fileURLToPath(dist);

const rows = await Promise.all(
  BUDGETS.map(async ({ label, pattern, limit, gzip }) => {
    const files = await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: distPath }));
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
