/**
 * Downloads every source in src/data/sources.ts into data/ and records what it got in
 * data/sources.lock.json. Safe to rerun: it fetches only what is missing or planned anew, so
 * a new source costs one rerun, and deleting a source's files fetches them again.
 *
 *   bun run data:fetch
 *
 * After a fetch, `git diff data/sources.lock.json` shows which sources changed.
 */

import {
  SourceError,
  WFS_LIMIT,
  checkOverpass,
  checkWfsPage,
  gridTiles,
  isPng,
  isTiff,
  lonLatTiles,
  mercatorTiles,
  mergeOverpass,
  mergeWfs,
  overpassQuery,
  quarter,
  sha256,
  wcsFile,
  wcsUrl,
  wfsUrl,
  wmtsFile,
  wmtsUrl,
} from '../src/data/fetch-plan.ts';
import type { OverpassResult, WfsPage } from '../src/data/fetch-plan.ts';
import {
  OSM_DATE,
  OVERPASS_ENDPOINTS,
  SOURCES,
  gridBox,
  lonLatBox,
  orthoRects,
} from '../src/data/sources.ts';
import type {
  OverpassSource,
  Source,
  WcsSource,
  WfsSource,
  WmtsSource,
} from '../src/data/sources.ts';
import { DATA, hashSource, readLock, removeStale, writeLock } from './data-files.ts';

const USER_AGENT = 'leuven.social data fetch (+https://github.com/basteau/leuven.social)';
const box = lonLatBox();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GETs or POSTs with retries: network errors, 429 and 5xx back off and try again, and so does
 * an answer `check` rejects (OGC servers report errors with HTTP 200).
 */
async function request<T>(
  url: string,
  check: (body: Uint8Array) => T,
  {
    body,
    attempts = 4,
    timeout = 240_000,
  }: { body?: string; attempts?: number; timeout?: number } = {},
): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        body: body === undefined ? undefined : new URLSearchParams({ data: body }),
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(timeout),
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}: ${new TextDecoder().decode(bytes.slice(0, 160))}`,
        );
      }
      return check(bytes);
    } catch (error) {
      last = error;
      if (attempt < attempts) {
        const wait = 2 ** attempt * 1000;
        console.warn(
          `  retry ${attempt}/${attempts - 1} in ${wait / 1000} s: ${String(error).slice(0, 200)}`,
        );
        await sleep(wait);
      }
    }
  }
  throw last;
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const json = (value: unknown) => JSON.stringify(value);

/** Runs `task` over `items`, `limit` at a time. */
async function pool<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: limit }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await task(item);
    }),
  );
}

/** Asks each Overpass server in turn, a few rounds over, until one answers in full. */
async function overpass(query: string): Promise<OverpassResult> {
  let last: unknown;
  for (let round = 1; round <= 3; round++) {
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        return await request(endpoint, (b) => checkOverpass(text(b), OSM_DATE), {
          body: query,
          attempts: 2,
        });
      } catch (error) {
        last = error;
        console.warn(`  ${new URL(endpoint).host} failed, trying the next server`);
      }
    }
    await sleep(round * 10_000);
  }
  throw last;
}

interface Plan {
  /** Every request, in order: the lock hashes it to notice a changed plan. */
  requests: string[];
  /** Files under data/ this source owns once fetched. */
  files: string[];
  /** Downloads whatever is missing. */
  run: () => Promise<void>;
}

const exists = async (path: string) => {
  const file = Bun.file(`${DATA}/${path}`);
  return (await file.exists()) && file.size > 0;
};

function overpassPlan(source: OverpassSource): Plan {
  const queries = lonLatTiles(box, source.tile).map((tile) =>
    overpassQuery(source, tile, OSM_DATE),
  );
  return {
    requests: queries,
    files: [source.output],
    run: async () => {
      const results: OverpassResult[] = [];
      for (const [i, query] of queries.entries()) {
        // Each tile is cached by its query, so an interrupted fetch resumes where it stopped.
        const cache = Bun.file(
          `${DATA}/.cache/${source.id}/${(await sha256(query)).slice(0, 16)}.json`,
        );
        if (await cache.exists()) {
          try {
            results.push(checkOverpass(await cache.text(), OSM_DATE));
            continue;
          } catch {
            // A cached answer from a server whose data ended too early: ask again.
          }
        }
        console.log(`  tile ${i + 1}/${queries.length}`);
        const result = await overpass(query);
        await Bun.write(cache, json(result));
        results.push(result);
      }
      await Bun.write(`${DATA}/${source.output}`, json(mergeOverpass(results, OSM_DATE)));
    },
  };
}

function wfsPlan(source: WfsSource): Plan {
  return {
    requests: [wfsUrl(source, box)],
    files: [source.output],
    run: async () => {
      const answers: WfsPage[] = [];
      const boxes = [box];
      for (let b = boxes.shift(); b !== undefined; b = boxes.shift()) {
        const answer = await request(wfsUrl(source, b), (bytes) => checkWfsPage(text(bytes)));
        if (answer.features.length >= WFS_LIMIT) boxes.push(...quarter(b));
        else answers.push(answer);
      }
      const merged = mergeWfs(answers, source.sortBy);
      console.log(`  ${merged.features.length} features from ${answers.length} boxes`);
      await Bun.write(`${DATA}/${source.output}`, json(merged));
    },
  };
}

/** Tile sources: one file per request, fetched a few at a time, skipped when already there. */
function tilePlan(
  entries: { url: string; file: string }[],
  valid: (b: Uint8Array) => boolean,
  limit: number,
): Plan {
  return {
    requests: entries.map((e) => e.url),
    files: entries.map((e) => e.file),
    run: async () => {
      let done = 0;
      await pool(entries, limit, async ({ url, file }) => {
        if (await exists(file)) return;
        const bytes = await request(url, (b) => {
          if (!valid(b)) throw new SourceError(`Not the expected format: ${text(b.slice(0, 160))}`);
          return b;
        });
        await Bun.write(`${DATA}/${file}`, bytes);
        if (++done % 100 === 0) console.log(`  ${done} tiles`);
      });
    },
  };
}

function wcsPlan(source: WcsSource): Plan {
  const tiles = gridTiles(gridBox(box), source.resolution);
  return tilePlan(
    tiles.map((t) => ({ url: wcsUrl(source, t), file: wcsFile(source, t) })),
    isTiff,
    2,
  );
}

function wmtsPlan(source: WmtsSource): Plan {
  const tiles = mercatorTiles(orthoRects(), source.zoom);
  return tilePlan(
    tiles.map(([x, y]) => ({ url: wmtsUrl(source, x, y), file: wmtsFile(source, x, y) })),
    isPng,
    6,
  );
}

function plan(source: Source): Plan {
  switch (source.kind) {
    case 'overpass':
      return overpassPlan(source);
    case 'wfs':
      return wfsPlan(source);
    case 'wcs':
      return wcsPlan(source);
    case 'wmts':
      return wmtsPlan(source);
  }
}

/**
 * The lock is the truth: with the same requests, the files must hash to what it says. A file
 * that doesn't (left over from an older plan, say) is fetched again, and a fresh download that
 * still doesn't match fails the fetch instead of rewriting the lock. `--update` accepts it, for
 * when the data really did change at the source.
 */
const update = process.argv.includes('--update');
const lock = await readLock();
const changed: string[] = [];
const mismatched: string[] = [];
for (const source of SOURCES) {
  const p = plan(source);
  const planHash = (await sha256(p.requests.join('\n'))).slice(0, 16);
  const previous = lock[source.id];
  const samePlan = previous?.plan === planHash;
  const complete = (await Promise.all(p.files.map(exists))).every(Boolean);
  // A merged file can't tell it was made for another extent; tiles are named by what they cover.
  const stale = !samePlan && source.kind !== 'wcs' && source.kind !== 'wmts';
  const drifted =
    complete && samePlan && (await hashSource(DATA, p.files)).sha256 !== previous.sha256;
  if (!complete || stale || drifted) {
    console.log(`${source.id}: fetching ${source.title.toLowerCase()}`);
    await p.run();
  } else {
    console.log(`${source.id}: cached`);
  }
  await removeStale(DATA, source, p.files);
  const digest = await hashSource(DATA, p.files);
  if (samePlan && previous.sha256 !== digest.sha256 && !update) {
    console.error(`${source.id}: the download doesn't match the lock for the same requests`);
    mismatched.push(source.id);
    continue;
  }
  if (previous?.sha256 !== digest.sha256) changed.push(source.id);
  lock[source.id] = {
    plan: planHash,
    ...digest,
    fetched:
      previous?.sha256 === digest.sha256 ? previous.fetched : new Date().toISOString().slice(0, 10),
  };
  // Saved after every source, so an interrupted fetch keeps what it finished.
  await writeLock(lock);
}

console.log(
  changed.length ? `Lock updated for ${changed.join(', ')}` : 'Everything matches the lock',
);
if (mismatched.length) {
  console.error(
    `Not reproducible: ${mismatched.join(', ')}. Run with --update only if the source itself changed.`,
  );
  process.exit(1);
}
