/**
 * Rebuilds the city from the downloads already in data/ and checks the result is byte for
 * byte the committed public/data/city.bin and walk.bin: data + code = map.
 *
 *   bun run data:check
 *
 * It first checks the downloads against data/sources.lock.json, so a failure says whether the
 * inputs or the code changed. It bakes in place: when the city differs, `git diff` shows it.
 */

import { outputFiles } from '../src/data/fetch-plan.ts';
import { unpackCity } from '../src/data/format.ts';
import { unpackWalk } from '../src/data/plates.ts';
import { SOURCES } from '../src/data/sources.ts';
import { DATA, hashSource, readLock } from './data-files.ts';

const root = new URL('../', import.meta.url).pathname;

const lock = await readLock();
const missing: string[] = [];
const differ: string[] = [];
for (const source of SOURCES) {
  const files = outputFiles(source);
  const present = await Promise.all(files.map((f) => Bun.file(`${DATA}/${f}`).exists()));
  if (!present.every(Boolean)) missing.push(source.id);
  else if ((await hashSource(DATA, files)).sha256 !== lock[source.id]?.sha256)
    differ.push(source.id);
}
if (missing.length) {
  console.error(`Not downloaded yet: ${missing.join(', ')}. Run bun run data:fetch first.`);
  process.exit(1);
}
if (differ.length) {
  console.error(
    `These downloads differ from data/sources.lock.json: ${differ.join(', ')}.\n` +
      'The committed city.bin was built from the locked ones. Refetch them, or rebake and commit.',
  );
  process.exit(1);
}
console.log('Downloads match the lock.');

async function run(cmd: string[]) {
  const proc = Bun.spawn(cmd, { cwd: root, stdout: 'inherit', stderr: 'inherit' });
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(' ')} failed`);
}

const city = `${root}public/data/city.bin`;
const walk = `${root}public/data/walk.bin`;
const before = await Bun.file(city).bytes();
const walkBefore = await Bun.file(walk).bytes();
await run(['bun', 'run', 'data:build']);
await run(['bun', 'run', 'bake']);
const after = await Bun.file(city).bytes();
const walkAfter = await Bun.file(walk).bytes();

let failed = false;
if (Bun.deepEquals(walkAfter, walkBefore)) {
  console.log('public/data/walk.bin is reproduced byte for byte.');
} else {
  const [a, b] = await Promise.all([unpackWalk(walkAfter), unpackWalk(walkBefore)]);
  const counts = (w: typeof a) =>
    `${w.houses.length} house numbers, ${w.streets.length} plates, ${w.boards.length} name boards`;
  console.error(
    `The rebuilt plates differ from the ones you had.\n  rebuilt: ${counts(a)}\n  before:  ${counts(b)}\n` +
      'They are in public/data/walk.bin now: commit them if the change is intended, or restore the file.',
  );
  failed = true;
}
if (Bun.deepEquals(after, before)) {
  console.log('public/data/city.bin is reproduced byte for byte.');
} else {
  const [a, b] = await Promise.all([unpackCity(after), unpackCity(before)]);
  const counts = (c: typeof a) =>
    Object.entries(c)
      .filter(([, v]) => Array.isArray(v))
      .map(([k, v]) => `${k} ${(v as unknown[]).length}`)
      .join(', ');
  console.error(
    `The rebuilt city differs from the one you had.\n  rebuilt: ${counts(a)}\n  before:  ${counts(b)}\n` +
      'It is in public/data/city.bin now: commit it if the change is intended, or git restore it.',
  );
  failed = true;
}
if (failed) process.exit(1);
