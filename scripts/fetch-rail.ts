/**
 * Downloads the railway platforms that the bake reads: Leuven's are multipolygon relations, and
 * only an `out geom` query brings their member ways along. Tries the Overpass mirrors in turn,
 * since each one is often busy. Writes data/osm/raw_rail_platforms.json, sorted and rounded so
 * the same map data always gives the same file.
 *
 *   bun scripts/fetch-rail.ts
 */

const root = new URL('../', import.meta.url);
const QUERY = new URL('data/osm/queries/rail_platforms.overpassql', root);
const OUT = new URL('data/osm/raw_rail_platforms.json', root);
/** Overpass endpoints that answered for this project (research/leuven-data-sources.md §1c). */
const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const ROUNDS = 6;
/** 7 decimals of a degree is about 1 cm: finer than any survey behind OSM. */
const round = (v: number) => Math.round(v * 1e7) / 1e7;

type LatLon = { lat: number; lon: number };
interface Element {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: LatLon[];
  members?: { type: string; ref: number; role: string; geometry?: LatLon[] }[];
}

const points = (geometry?: LatLon[]) =>
  geometry?.map(({ lat, lon }) => ({ lat: round(lat), lon: round(lon) }));

async function query(body: string): Promise<Element[]> {
  for (let attempt = 0; attempt < ROUNDS; attempt++) {
    for (const mirror of MIRRORS) {
      try {
        const response = await fetch(mirror, {
          method: 'POST',
          body: new URLSearchParams({ data: body }),
          signal: AbortSignal.timeout(90_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const { elements } = (await response.json()) as { elements: Element[] };
        return elements;
      } catch (error) {
        console.warn(`${mirror}: ${(error as Error).message}`);
      }
    }
    await Bun.sleep(30_000);
  }
  throw new Error('Every Overpass mirror failed. Try again later.');
}

/** Keeps what the bake reads, in a fixed key order. Member order matters: rings chain in it. */
function tidy(e: Element): Element {
  const out: Element = { type: e.type, id: e.id };
  if (e.tags) out.tags = Object.fromEntries(Object.entries(e.tags).toSorted());
  if (e.geometry) out.geometry = points(e.geometry);
  if (e.members) {
    out.members = e.members.map((m) => {
      const member: NonNullable<Element['members']>[number] = {
        type: m.type,
        ref: m.ref,
        role: m.role,
      };
      if (m.geometry) member.geometry = points(m.geometry);
      return member;
    });
  }
  return out;
}

const elements = (await query(await Bun.file(QUERY).text()))
  .map(tidy)
  .toSorted((a, b) => a.type.localeCompare(b.type) || a.id - b.id);

await Bun.write(OUT, `${JSON.stringify({ elements })}\n`);
console.log(`${elements.length} platforms → data/osm/raw_rail_platforms.json`);
