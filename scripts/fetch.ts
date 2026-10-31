/**
 * Downloads every source in src/data/sources.ts into data/ and records what it got in
 * data/sources.lock.json. Safe to rerun: what is already there and still planned is kept.
 *
 *   bun run data:fetch                 fetch what is missing, update the lock
 *   bun run data:fetch --only osm-roads,grb-gbg
 *   bun run data:fetch --refresh       fetch everything again
 *   bun run data:fetch --frozen        fail if anything differs from the lock (CI)
 *   bun run data:fetch --data /tmp/d   another data folder
 */

import {
  SourceError,
  WFS_PAGE,
  checkOverpass,
  checkWfsPage,
  checkWikidata,
  gridTiles,
  isPng,
  isTiff,
  lonLatTiles,
  mercatorTiles,
  mergeOverpass,
  mergeWfs,
  mergeWikidata,
  overpassQuery,
  sha256,
  wcsFile,
  wcsUrl,
  wfsUrl,
  wikidataUrls,
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
  WikidataSource,
  WmtsSource,
} from '../src/data/sources.ts';
import { dataDir, flags, hashSource, readLock, removeStale, writeLock } from './data-files.ts';

const args = flags(Bun.argv.slice(2), ['refresh', 'frozen'], ['only', 'data']);

const DATA = dataDir(typeof args.data === 'string' ? args.data : undefined);
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
        return await request(endpoint, (b) => checkOverpass(text(b)), { body: query, attempts: 2 });
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
  /** Downloads whatever is missing (or everything, when refreshing). */
  run: (refresh: boolean) => Promise<void>;
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
          results.push(checkOverpass(await cache.text()));
          continue;
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
    requests: [wfsUrl(source, box, 0, WFS_PAGE)],
    files: [source.output],
    run: async () => {
      const pages: WfsPage[] = [];
      for (let start = 0; ; start += WFS_PAGE) {
        const page = await request(wfsUrl(source, box, start, WFS_PAGE), (b) =>
          checkWfsPage(text(b)),
        );
        pages.push(page);
        console.log(`  ${start + page.features.length} features`);
        if (page.features.length < WFS_PAGE) break;
      }
      await Bun.write(`${DATA}/${source.output}`, json(mergeWfs(pages, source.sortBy)));
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
    run: async (refresh) => {
      let done = 0;
      await pool(entries, limit, async ({ url, file }) => {
        if (!refresh && (await exists(file))) return;
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

function wikidataPlan(source: WikidataSource): Plan {
  const urls = wikidataUrls(source);
  return {
    requests: urls,
    files: [source.output],
    run: async () => {
      const results = [];
      for (const url of urls) results.push(await request(url, (b) => checkWikidata(text(b))));
      await Bun.write(`${DATA}/${source.output}`, json(mergeWikidata(results, source.items)));
    },
  };
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
    case 'wikidata':
      return wikidataPlan(source);
  }
}

const only = typeof args.only === 'string' ? args.only.split(',') : undefined;
const unknown = only?.filter((id) => !SOURCES.some((s) => s.id === id)) ?? [];
if (unknown.length)
  throw new Error(`Unknown source ${unknown.join(', ')}: see src/data/sources.ts`);

const lock = await readLock();
const changed: string[] = [];
for (const source of SOURCES) {
  if (only && !only.includes(source.id)) continue;
  const p = plan(source);
  const planHash = (await sha256(p.requests.join('\n'))).slice(0, 16);
  const previous = lock[source.id];
  const complete = (await Promise.all(p.files.map(exists))).every(Boolean);
  // A merged file can't tell it was made for another extent; tiles are named by what they cover.
  const stale = previous?.plan !== planHash && source.kind !== 'wcs' && source.kind !== 'wmts';
  if (args.refresh === true || !complete || stale) {
    console.log(`${source.id}: fetching ${source.title.toLowerCase()}`);
    await p.run(args.refresh === true);
  } else {
    console.log(`${source.id}: cached`);
  }
  await removeStale(DATA, source, p.files);
  const digest = await hashSource(DATA, p.files);
  if (previous?.sha256 !== digest.sha256) changed.push(source.id);
  lock[source.id] = {
    plan: planHash,
    ...digest,
    fetched:
      previous?.sha256 === digest.sha256 ? previous.fetched : new Date().toISOString().slice(0, 10),
  };
}

if (args.frozen === true && changed.length) {
  console.error(`These sources differ from data/sources.lock.json: ${changed.join(', ')}`);
  process.exit(1);
}
await writeLock(lock);
console.log(
  changed.length ? `Lock updated for ${changed.join(', ')}` : 'Everything matches the lock',
);
