/**
 * Bakes public/data/city.bin from the research downloads in data/ (see data/README.md).
 * Only this edge reads files; the transforms live in src/data and are unit-tested.
 *
 *   bun run bake
 */

import { AREA, LANDMARK_FOOTPRINTS, LANDMARKS, VIEW_AREA } from '../src/data/area.ts';
import { kindFromOsm, roofFromOsm } from '../src/data/city.ts';
import type { Building, City, Tier } from '../src/data/city.ts';
import { packCity } from '../src/data/format.ts';
import {
  areaIndex,
  clipRingToArea,
  normalizeRing,
  ringInArea,
  signedArea,
  simplifyRing,
} from '../src/data/geometry.ts';
import { toLocal } from '../src/data/projection.ts';

const root = new URL('../', import.meta.url);
const read = async <T>(path: string): Promise<T> => {
  const file = Bun.file(new URL(path, root));
  if (!(await file.exists())) {
    throw new Error(`Missing ${path}. Build it first: see data/README.md.`);
  }
  return (await file.json()) as T;
};

type Props = Record<string, string | undefined>;
interface Feature {
  properties: Props;
  geometry: { type: string; coordinates: unknown };
}
interface Collection {
  features: Feature[];
}
interface LocalBuilding {
  id: number;
  h: number;
  kind: string;
  roof: string | null;
  tier: Tier;
  ring: [number, number][];
}

/**
 * How far a footprint vertex may sit off the line through its neighbours and still be dropped.
 * Survey footprints carry many near-collinear points; each one costs three triangles. Hero
 * footprints keep theirs: landmark models are fitted to them.
 */
const SIMPLIFY: Record<Tier, number> = { hero: 0, core: 0.25, fringe: 0.5 };
/** Ground polygons are flat, so they can lose more. Specks of green smaller than this go. */
const GROUND_SIMPLIFY = 0.3;
const MIN_GREEN_AREA = 25;

/** Outer ring of a GeoJSON polygon (or a closed line) in local metres, clipped to the area. */
function areaRings(f: Feature): number[][] {
  const g = f.geometry;
  const coords =
    g.type === 'Polygon'
      ? (g.coordinates as [number, number][][])[0]
      : g.type === 'LineString'
        ? (g.coordinates as [number, number][])
        : undefined;
  if (!coords || coords.length < 4) return [];
  const ring = normalizeRing(coords.flatMap(([lon, lat]) => toLocal(lon, lat)));
  return clipRingToArea(simplifyRing(ring, GROUND_SIMPLIFY), AREA);
}

const layer = (features: Feature[], keep: (p: Props) => boolean, minArea = 0) =>
  features
    .filter((f) => keep(f.properties))
    .flatMap(areaRings)
    .filter((r) => r.length >= 6 && Math.abs(signedArea(r)) >= minArea)
    .map((r) => new Float32Array(r));

const GREEN_LEISURE = new Set(['park', 'garden', 'playground', 'pitch']);
const GREEN_LANDUSE = new Set(['grass', 'meadow', 'cemetery', 'forest', 'recreation_ground']);

const [local, wbn, wtz, osmAreas, osmRoads, osmPoints] = await Promise.all([
  read<{ buildings: LocalBuilding[] }>('data/derived/leuven_buildings_local.json'),
  read<Collection>('data/grb/grb_WBN.geojson'),
  read<Collection>('data/grb/grb_WTZ.geojson'),
  read<Collection>('data/derived/osm_areas.geojson'),
  read<Collection>('data/derived/osm_roads.geojson'),
  read<Collection>('data/derived/osm_points.geojson'),
]);

const buildings: Building[] = [];
for (const b of local.buildings) {
  const tier = LANDMARK_FOOTPRINTS.includes(b.id) ? 'hero' : b.tier;
  const ring = simplifyRing(normalizeRing(b.ring.flat()), SIMPLIFY[tier]);
  if (ring.length < 6 || !ringInArea(ring, AREA)) continue;
  buildings.push({
    id: b.id,
    tier,
    kind: kindFromOsm(b.kind),
    roof: roofFromOsm(b.roof),
    height: Math.max(2.5, Math.min(b.h, 90)),
    ring: new Float32Array(ring),
  });
}

const closedPedestrianArea = (p: Props) =>
  (p.highway === 'pedestrian' || p.highway === 'footway') && p.area === 'yes';

const trees = osmPoints.features
  .filter((f) => f.properties.natural === 'tree')
  .map((f) => toLocal(...(f.geometry.coordinates as [number, number])))
  .filter(([x, z]) => areaIndex(AREA, x, z) >= 0)
  .flat();

const city: City = {
  area: [...AREA],
  bounds: VIEW_AREA,
  labels: LANDMARKS.map(({ name, lon, lat }) => {
    const [x, z] = toLocal(lon, lat);
    return { name, x, z };
  }),
  buildings,
  roads: layer(wbn.features, () => true),
  plazas: [
    ...layer(osmAreas.features, (p) => p.place === 'square' || p['area:highway'] !== undefined),
    ...layer(osmRoads.features, closedPedestrianArea),
  ],
  green: layer(
    osmAreas.features,
    (p) => GREEN_LEISURE.has(p.leisure ?? '') || GREEN_LANDUSE.has(p.landuse ?? ''),
    MIN_GREEN_AREA,
  ),
  water: [
    ...layer(wtz.features, () => true),
    ...layer(osmAreas.features, (p) => p.natural === 'water'),
  ],
  trees: new Float32Array(trees),
};

const bytes = await packCity(city);
await Bun.write(new URL('public/data/city.bin', root), bytes);

const tiers = Object.groupBy(buildings, (b) => b.tier);
console.log(
  [
    `buildings ${buildings.length} (hero ${tiers.hero?.length ?? 0}, core ${tiers.core?.length ?? 0})`,
    `roads ${city.roads.length}, plazas ${city.plazas.length}, green ${city.green.length}, water ${city.water.length}`,
    `trees ${trees.length / 2}, labels ${city.labels.length}`,
    `public/data/city.bin ${(bytes.length / 1024).toFixed(0)} KB gzipped`,
  ].join('\n'),
);
