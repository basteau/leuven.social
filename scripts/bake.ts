/**
 * Bakes public/data/city.bin from the research downloads in data/ (see data/README.md).
 * Only this edge reads files; the transforms live in src/data and are unit-tested.
 *
 *   bun run bake
 */

import { LANDMARKS, VIEW_AREA } from '../src/data/area.ts';
import { kindFromOsm, roofFromSurvey } from '../src/data/city.ts';
import type { Building, City, Tier } from '../src/data/city.ts';
import { packCity } from '../src/data/format.ts';
import { clipRing, normalizeRing, ringInside, signedArea } from '../src/data/geometry.ts';
import { toLocal } from '../src/data/projection.ts';
import { mergeTrees } from '../src/data/trees.ts';

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
  /** LiDAR p15 height and the share of pitched roof pixels (see tools/build_leuven_data.py). */
  eave?: number;
  pitch?: number;
  /** Orthophoto roof colour, white-balanced. */
  rgb?: [number, number, number] | null;
  kind: string;
  roof: string | null;
  tier: Tier;
  ring: [number, number][];
  holes?: [number, number][][];
}

/** Outer ring of a GeoJSON polygon (or a closed line) in local metres, clipped to the area. */
function areaRing(f: Feature): number[] {
  const g = f.geometry;
  const coords =
    g.type === 'Polygon'
      ? (g.coordinates as [number, number][][])[0]
      : g.type === 'LineString'
        ? (g.coordinates as [number, number][])
        : undefined;
  if (!coords || coords.length < 4) return [];
  const ring = normalizeRing(coords.flatMap(([lon, lat]) => toLocal(lon, lat)));
  return clipRing(ring, VIEW_AREA);
}

const layer = (features: Feature[], keep: (p: Props) => boolean) =>
  features
    .filter((f) => keep(f.properties))
    .map(areaRing)
    .filter((r) => r.length >= 6)
    .map((r) => new Float32Array(r));

const GREEN_LEISURE = new Set(['park', 'garden', 'playground', 'pitch']);
const GREEN_LANDUSE = new Set(['grass', 'meadow', 'cemetery', 'forest', 'recreation_ground']);

/** Courtyards smaller than this are light wells: below a game pixel, and not worth the walls. */
const MIN_COURTYARD = 12;

const [local, crowns, wbn, wtz, osmAreas, osmRoads, osmPoints] = await Promise.all([
  read<{ buildings: LocalBuilding[] }>('data/derived/leuven_buildings_local.json'),
  read<{ trees: [number, number, number][] }>('data/derived/lidar_trees.json'),
  read<Collection>('data/grb/grb_WBN.geojson'),
  read<Collection>('data/grb/grb_WTZ.geojson'),
  read<Collection>('data/derived/osm_areas.geojson'),
  read<Collection>('data/derived/osm_roads.geojson'),
  read<Collection>('data/derived/osm_points.geojson'),
]);

const buildings: Building[] = [];
for (const b of local.buildings) {
  const ring = normalizeRing(b.ring.flat());
  if (ring.length < 6 || !ringInside(ring, VIEW_AREA)) continue;
  const height = Math.max(2.5, Math.min(b.h, 90));
  const holes = (b.holes ?? [])
    .map((hole) => normalizeRing(hole.flat()))
    .filter((hole) => hole.length >= 6 && signedArea(hole) >= MIN_COURTYARD)
    .map((hole) => {
      const cw: number[] = [];
      for (let i = hole.length - 2; i >= 0; i -= 2) cw.push(hole[i]!, hole[i + 1]!);
      return new Float32Array(cw);
    });
  buildings.push({
    id: b.id,
    tier: b.tier,
    kind: kindFromOsm(b.kind),
    roof: roofFromSurvey(b.roof, b.pitch),
    height,
    eave: Math.min(height, Math.max(2.5, b.eave ?? height)),
    roofColor: b.rgb ? (b.rgb[0] << 16) | (b.rgb[1] << 8) | b.rgb[2] : null,
    ring: new Float32Array(ring),
    holes,
  });
}

const closedPedestrianArea = (p: Props) =>
  (p.highway === 'pedestrian' || p.highway === 'footway') && p.area === 'yes';

const osmTrees = osmPoints.features
  .filter((f) => f.properties.natural === 'tree')
  .map((f) => toLocal(...(f.geometry.coordinates as [number, number])))
  .filter(([x, z]) => ringInside([x, z], VIEW_AREA))
  .flat();
const trees = mergeTrees(
  osmTrees,
  crowns.trees.filter(([x, z]) => ringInside([x, z], VIEW_AREA)),
);

const city: City = {
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
  ),
  water: [
    ...layer(wtz.features, () => true),
    ...layer(osmAreas.features, (p) => p.natural === 'water'),
  ],
  trees: new Float32Array(trees.positions),
  treeHeights: new Float32Array(trees.heights),
};

const bytes = await packCity(city);
await Bun.write(new URL('public/data/city.bin', root), bytes);

const tiers = Object.groupBy(buildings, (b) => b.tier);
console.log(
  [
    `buildings ${buildings.length} (hero ${tiers.hero?.length ?? 0}, core ${tiers.core?.length ?? 0})`,
    `roads ${city.roads.length}, plazas ${city.plazas.length}, green ${city.green.length}, water ${city.water.length}`,
    `trees ${trees.heights.length} (${osmTrees.length / 2} mapped), labels ${city.labels.length}`,
    `roofs ${buildings.filter((b) => b.roof === 'flat').length} flat, ${buildings.filter((b) => b.roofColor !== null).length} with a sampled colour, ${buildings.filter((b) => b.holes.length).length} with courtyards`,
    `public/data/city.bin ${(bytes.length / 1024).toFixed(0)} KB gzipped`,
  ].join('\n'),
);
