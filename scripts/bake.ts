/**
 * Bakes public/data/city.bin from the research downloads in data/ (see data/README.md).
 * Only this edge reads files; the transforms live in src/data and are unit-tested.
 *
 *   bun run bake
 */

import { AREA, LANDMARK_FOOTPRINTS, LANDMARKS, VIEW_AREA } from '../src/data/area.ts';
import { kindFromOsm, pathFromOsm, roofFromSurvey } from '../src/data/city.ts';
import type { Building, Carriageway, City, Marking, Path, Tier } from '../src/data/city.ts';
import { packCity } from '../src/data/format.ts';
import {
  areaIndex,
  clipLine,
  clipRingToArea,
  normalizeRing,
  ringInArea,
  signedArea,
  simplifyRing,
} from '../src/data/geometry.ts';
import { toLocal } from '../src/data/projection.ts';
import { carriagewayKind, crossingMarking } from '../src/data/roads.ts';
import type { RoadRole } from '../src/data/roads.ts';
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
/** tools/build_road_zones.py: carriageways cut from the road surface, lane lines and crossings. */
interface RoadZones {
  faces: { role: RoadRole; tags: Props; ring: [number, number][] }[];
  lines: { kind: 'dashed' | 'solid' | 'cycle-lane'; line: [number, number][] }[];
  crossings: { tags: Props; line: [number, number][] }[];
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

/** Courtyards smaller than this are light wells: below a game pixel, and not worth the walls. */
const MIN_COURTYARD = 12;

const [local, crowns, wbn, zones, wtz, osmAreas, osmRoads, osmPoints] = await Promise.all([
  read<{ buildings: LocalBuilding[] }>('data/derived/leuven_buildings_local.json'),
  read<{ trees: [number, number, number][] }>('data/derived/lidar_trees.json'),
  read<Collection>('data/grb/grb_WBN.geojson'),
  read<RoadZones>('data/derived/road_zones.json'),
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
  const height = Math.max(2.5, Math.min(b.h, 90));
  const holes = (b.holes ?? [])
    .map((hole) => simplifyRing(normalizeRing(hole.flat()), SIMPLIFY[tier]))
    .filter((hole) => hole.length >= 6 && signedArea(hole) >= MIN_COURTYARD)
    .map((hole) => {
      const cw: number[] = [];
      for (let i = hole.length - 2; i >= 0; i -= 2) cw.push(hole[i]!, hole[i + 1]!);
      return new Float32Array(cw);
    });
  buildings.push({
    id: b.id,
    tier,
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
  .filter(([x, z]) => areaIndex(AREA, x, z) >= 0)
  .flat();
const paths: Path[] = osmRoads.features.flatMap((f) => {
  const style = pathFromOsm(f.properties);
  if (!style || f.geometry.type !== 'LineString') return [];
  const line = (f.geometry.coordinates as [number, number][]).flatMap(([lon, lat]) =>
    toLocal(lon, lat),
  );
  return AREA.flatMap((rect) => clipLine(line, rect)).map((piece) =>
    Object.assign({ line: new Float32Array(piece) }, style),
  );
});

// Carriageways come simplified as one coverage, so neighbours still share edges: only clip them.
const carriageways: Carriageway[] = zones.faces.flatMap(({ role, tags, ring }) => {
  const kind = carriagewayKind(role, tags);
  return clipRingToArea(normalizeRing(ring.flat()), AREA)
    .filter((r) => r.length >= 6)
    .map((r) => ({ kind, ring: new Float32Array(r) }));
});
const lineInArea = (line: [number, number][]) =>
  AREA.flatMap((rect) => clipLine(line.flat(), rect)).filter((piece) => piece.length >= 4);
const markings: Marking[] = [
  ...zones.lines.flatMap(({ kind, line }) =>
    lineInArea(line).map((piece) => ({ kind, line: new Float32Array(piece) })),
  ),
  ...zones.crossings.flatMap(({ tags, line }) => {
    const kind = crossingMarking(tags);
    // A crossing is drawn whole or not at all.
    const inside = line.every(([x, z]) => areaIndex(AREA, x, z) >= 0);
    return kind && inside ? [{ kind, line: new Float32Array(line.flat()) }] : [];
  }),
];

const trees = mergeTrees(
  osmTrees,
  crowns.trees.filter(([x, z]) => areaIndex(AREA, x, z) >= 0),
);

const city: City = {
  area: [...AREA],
  bounds: VIEW_AREA,
  labels: LANDMARKS.map(({ name, lon, lat }) => {
    const [x, z] = toLocal(lon, lat);
    return { name, x, z };
  }),
  buildings,
  roads: layer(wbn.features, () => true),
  carriageways,
  markings,
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
  paths,
  trees: new Float32Array(trees.positions),
  treeHeights: new Float32Array(trees.heights),
};

const bytes = await packCity(city);
await Bun.write(new URL('public/data/city.bin', root), bytes);

const tiers = Object.groupBy(buildings, (b) => b.tier);
console.log(
  [
    `buildings ${buildings.length} (hero ${tiers.hero?.length ?? 0}, core ${tiers.core?.length ?? 0})`,
    `roads ${city.roads.length}, carriageways ${carriageways.length} (${Object.entries(
      Object.groupBy(carriageways, (r) => r.kind),
    )
      .map(([k, v]) => `${k} ${v?.length}`)
      .join(', ')})`,
    `markings ${Object.entries(Object.groupBy(markings, (m) => m.kind))
      .map(([k, v]) => `${k} ${v?.length}`)
      .join(', ')}`,
    `plazas ${city.plazas.length}, green ${city.green.length}, water ${city.water.length}`,
    `paths ${paths.length} (${paths.filter((p) => !p.paved).length} unpaved)`,
    `trees ${trees.heights.length} (${osmTrees.length / 2} mapped), labels ${city.labels.length}`,
    `roofs ${buildings.filter((b) => b.roof === 'flat').length} flat, ${buildings.filter((b) => b.roofColor !== null).length} with a sampled colour, ${buildings.filter((b) => b.holes.length).length} with courtyards`,
    `public/data/city.bin ${(bytes.length / 1024).toFixed(0)} KB gzipped`,
  ].join('\n'),
);
