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
  { label: '3D engine JS (three.js)', pattern: 'assets/viewer-*.js', limit: 170 * KB, gzip: true },
  { label: 'CSS', pattern: 'assets/*.css', limit: 6 * KB, gzip: true },
  { label: 'City data (already gzipped)', pattern: 'data/city.bin', limit: 300 * KB, gzip: false },
  { label: 'All JS', pattern: 'assets/*.js', limit: 250 * KB, gzip: true },
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
