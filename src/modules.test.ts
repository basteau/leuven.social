import { Glob } from 'bun';
import { test } from 'bun:test';

// Bun measures coverage only for files a test imports, so an untested new module would be
// invisible to the coverage floor. Importing every pure module makes it count.
// (The one place `bun` may be imported in src: see the oxlint override.)
const BROWSER_ONLY = new Set([
  'data/load.ts',
  'scene/viewer.ts',
  'scene/facade-material.ts',
  'scene/character-material.ts',
  'scene/avatar-layer.ts',
  'scene/bikes.ts',
]);

test('every pure module is measured by coverage', async () => {
  for await (const file of new Glob('{audio,data,scene}/*.ts').scan({ cwd: import.meta.dir })) {
    if (!file.endsWith('.test.ts') && !BROWSER_ONLY.has(file)) await import(`./${file}`);
  }
});
