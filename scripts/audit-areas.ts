/**
 * Tallies every kind of OSM area in the download by how much of the map it covers, and which
 * ground layer it is drawn as (src/data/landcover.ts), so a kind of land that is drawn as
 * nothing, or as the wrong thing, shows up by its size. Reads data/osm/areas.json, or the
 * Overpass answer given.
 *
 *   bun scripts/audit-areas.ts [areas.json]
 */

import { AREA } from '../src/data/area.ts';
import { clipRing, signedArea } from '../src/data/geometry.ts';
import { areaKind, coverOf, osmAreas } from '../src/data/landcover.ts';
import type { OsmElement } from '../src/data/landcover.ts';
import { toLocal } from '../src/data/projection.ts';
import { DATA } from './data-files.ts';

/** Kinds drawn as nothing that cover more than this (m²) are flagged. */
const FLAG = 5000;
const ROWS = Number(process.env.ROWS ?? 40);

const path = process.argv[2] ?? `${DATA}/osm/areas.json`;
const { elements } = (await Bun.file(path).json()) as { elements: OsmElement[] };

/** The part of a polygon inside the area, in m². */
const inArea = (ring: number[]) =>
  AREA.reduce((sum, b) => {
    const piece = clipRing(ring, b);
    return sum + (piece.length >= 6 ? Math.abs(signedArea(piece)) : 0);
  }, 0);

const kinds = new Map<string, { area: number; count: number; relations: number; cover: string }>();
const layers = new Map<string, number>();
for (const { id, tags, polygons } of osmAreas(elements, toLocal)) {
  const area = polygons.reduce(
    (sum, p) => sum + inArea(p.outer) - p.holes.reduce((s, h) => s + inArea(h), 0),
    0,
  );
  if (area <= 0) continue;
  const kind = areaKind(tags);
  const cover = coverOf(tags) ?? 'none';
  const row = kinds.get(kind) ?? { area: 0, count: 0, relations: 0, cover };
  row.area += area;
  row.count++;
  if (id.startsWith('r')) row.relations++;
  kinds.set(kind, row);
  layers.set(cover, (layers.get(cover) ?? 0) + area);
}

const ha = (m2: number) => (m2 / 1e4).toFixed(2).padStart(8);
const rows = [...kinds].toSorted((a, b) => b[1].area - a[1].area);
console.log(
  `${'ha'.padStart(8)}  ${'n'.padStart(5)}  ${'rel'.padStart(3)}  ${'layer'.padEnd(9)}  kind`,
);
for (const [kind, { area, count, relations, cover }] of rows.slice(0, ROWS)) {
  const flag = cover === 'none' && area > FLAG ? '  ←' : '';
  console.log(
    `${ha(area)}  ${String(count).padStart(5)}  ${String(relations).padStart(3)}  ${cover.padEnd(9)}  ${kind}${flag}`,
  );
}
console.log(`… ${Math.max(0, rows.length - ROWS)} more kinds`);
console.log(
  [...layers]
    .toSorted((a, b) => b[1] - a[1])
    .map(([cover, area]) => `${cover} ${(area / 1e4).toFixed(1)} ha`)
    .join(', '),
);
