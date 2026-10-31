/**
 * Rebuilds the city from the downloads already in data/ and checks the result is byte for
 * byte the committed public/data/city.bin: data + code = map.
 *
 *   bun run data:check [--data <folder>]
 *
 * It first checks the downloads against data/sources.lock.json, so a failure says whether the
 * inputs or the code changed.
 */

import { outputFiles } from '../src/data/fetch-plan.ts';
import { unpackCity } from '../src/data/format.ts';
import { SOURCES } from '../src/data/sources.ts';
import { dataDir, flags, hashSource, readLock } from './data-files.ts';

const args = flags(Bun.argv.slice(2), [], ['data']);
const DATA = dataDir(typeof args.data === 'string' ? args.data : undefined);
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

const rebuilt = `${DATA}/.cache/city.bin`;
await run(['uv', 'run', '--locked', '--script', 'tools/build_leuven_data.py', DATA]);
await run(['bun', 'scripts/bake.ts', '--data', DATA, '--out', rebuilt]);

const fresh = await Bun.file(rebuilt).bytes();
const committed = await Bun.file(`${root}public/data/city.bin`).bytes();
if (Bun.deepEquals(fresh, committed)) {
  console.log('public/data/city.bin is reproduced byte for byte.');
} else {
  const [a, b] = await Promise.all([unpackCity(fresh), unpackCity(committed)]);
  const counts = (c: typeof a) =>
    Object.entries(c)
      .filter(([, v]) => Array.isArray(v))
      .map(([k, v]) => `${k} ${(v as unknown[]).length}`)
      .join(', ');
  console.error(
    `The rebuilt city differs from public/data/city.bin.\n  rebuilt:   ${counts(a)}\n  committed: ${counts(b)}\n` +
      `The rebuilt file is ${rebuilt}. If the change is intended, run bun run bake and commit city.bin.`,
  );
  process.exit(1);
}
