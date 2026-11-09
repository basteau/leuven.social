/**
 * The file side of the data pipeline, shared by scripts/fetch.ts and scripts/data-check.ts:
 * where data/ is, hashing what a source downloaded, and the lock file.
 */

import { digestFiles, sha256 } from '../src/data/fetch-plan.ts';
import type { LockEntry } from '../src/data/fetch-plan.ts';
import { SOURCES } from '../src/data/sources.ts';
import type { Source } from '../src/data/sources.ts';

const root = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const LOCK = `${root}/data/sources.lock.json`;

export const DATA = `${root}/data`;

export type Lock = Record<string, LockEntry>;

export async function readLock(): Promise<Lock> {
  const file = Bun.file(LOCK);
  return (await file.exists()) ? ((await file.json()) as Lock) : {};
}

/** In manifest order, so the file diffs cleanly; sources no longer in the manifest drop out. */
export async function writeLock(lock: Lock) {
  const ordered: Lock = {};
  for (const s of SOURCES) if (lock[s.id]) ordered[s.id] = lock[s.id]!;
  await Bun.write(LOCK, `${JSON.stringify(ordered, null, 2)}\n`);
}

/** Hashes a source's files (relative to the data folder) into one lock digest. */
export async function hashSource(data: string, files: readonly string[]) {
  return digestFiles(
    await Promise.all(
      files.map(async (path) => {
        const bytes = await Bun.file(`${data}/${path}`).bytes();
        return { path, bytes: bytes.length, sha256: await sha256(bytes) };
      }),
    ),
  );
}

/**
 * Tile sources own their folder: tiles from an older, different extent would otherwise end
 * up in the mosaic.
 */
export async function removeStale(data: string, source: Source, keep: readonly string[]) {
  if (source.kind !== 'wcs' && source.kind !== 'wmts') return;
  const wanted = new Set(keep);
  for await (const name of new Bun.Glob('*').scan(`${data}/${source.output}`)) {
    const path = `${source.output}/${name}`;
    if (!wanted.has(path)) await Bun.file(`${data}/${path}`).delete();
  }
}
