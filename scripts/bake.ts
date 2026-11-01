/**
 * Bakes public/data/city.bin from data/derived/ and the GRB downloads (`bun run data` makes
 * both; see docs/DATA.md). Only this edge reads files; the transforms live in src/data and
 * are unit-tested. Same inputs, same bytes: `bun run data:check` holds it to that.
 *
 *   bun run bake
 */

import { AREA, LANDMARK_FOOTPRINTS, LANDMARKS, VIEW_AREA } from '../src/data/area.ts';
import { kindFromOsm, pathFromOsm, roofFromSurvey } from '../src/data/city.ts';
import type { Building, Carriageway, City, Marking, Path, Tank, Tier } from '../src/data/city.ts';
import { packCity } from '../src/data/format.ts';
import {
  areaIndex,
  clipLine,
  clipRingToArea,
  normalizeRing,
  orientedRect,
  ringInArea,
  signedArea,
  simplifyRing,
} from '../src/data/geometry.ts';
import { toLocal } from '../src/data/projection.ts';
import { elementCentre, findElement, labelName } from '../src/data/labels.ts';
import type { OsmElement } from '../src/data/labels.ts';
import { EdgeIndex, RingIndex, placeProps } from '../src/data/props.ts';
import { carriagewayKind, crossingMarking } from '../src/data/roads.ts';
import type { RoadRole } from '../src/data/roads.ts';
import { correctRoofColours } from '../src/data/roof-colours.ts';
import { capShedsUnderTrees } from '../src/data/sheds.ts';
import { isShopFront, markShopFronts } from '../src/data/shops.ts';
import { bridgeParapets, tankOutline } from '../src/data/structures.ts';
import { SOURCES } from '../src/data/sources.ts';
import { mergeTrees } from '../src/data/trees.ts';
import { DATA } from './data-files.ts';

const OUT = new URL('../public/data/city.bin', import.meta.url).pathname;
const read = async <T>(path: string): Promise<T> => {
  const file = Bun.file(`${DATA}/${path}`);
  if (!(await file.exists())) {
    throw new Error(`Missing data/${path}. Make it first: bun run data (docs/DATA.md).`);
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
  /** OSM's name for the building, joined by point (see tools/build_leuven_data.py). */
  name?: string | null;
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

const GREEN_LEISURE = new Set(['park', 'garden', 'playground']);
const GREEN_LANDUSE = new Set([
  'grass',
  'meadow',
  'cemetery',
  'recreation_ground',
  'village_green',
]);
const WOODS = (p: Props) => p.landuse === 'forest' || p.natural === 'wood' || p.natural === 'scrub';

/** Courtyards smaller than this are light wells: below a game pixel, and not worth the walls. */
const MIN_COURTYARD = 12;

const [local, crowns, knw, wbn, zones, wtz, osmAreas, osmRoads, osmPoints] = await Promise.all([
  read<{ buildings: LocalBuilding[] }>('derived/leuven_buildings_local.json'),
  read<{ trees: [number, number, number][] }>('derived/lidar_trees.json'),
  read<{ structures: { kind: string; h: number; ring: [number, number][] }[] }>(
    'derived/grb_structures.json',
  ),
  read<Collection>('grb/grb_WBN.geojson'),
  read<RoadZones>('derived/road_zones.json'),
  read<Collection>('grb/grb_WTZ.geojson'),
  read<Collection>('derived/osm_areas.geojson'),
  read<Collection>('derived/osm_roads.geojson'),
  read<Collection>('derived/osm_points.geojson'),
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

// The orthophoto's roof colours, white-balanced on the flat roofs (src/data/roof-colours.ts).
const roofs = buildings.map((b) => ({
  roofColor: b.roofColor,
  flat: b.roof === 'flat',
  ring: b.ring,
}));
correctRoofColours(roofs);
for (const [i, b] of buildings.entries()) b.roofColor = roofs[i]!.roofColor;

// Garden sheds whose LiDAR height is the tree over them (src/data/sheds.ts).
const shedsCapped = capShedsUnderTrees(buildings, crowns.trees);

// Shop fronts where OSM maps a shop, café or restaurant inside the footprint.
const shopFronts = markShopFronts(
  buildings,
  osmPoints.features
    .filter((f) => isShopFront(f.properties) && f.geometry.type === 'Point')
    .flatMap((f) => toLocal(...(f.geometry.coordinates as [number, number]))),
);

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

const roads = layer(wbn.features, () => true);
const plazas = [
  ...layer(osmAreas.features, (p) => p.place === 'square' || p['area:highway'] !== undefined),
  ...layer(osmRoads.features, closedPedestrianArea),
];
const water = [
  ...layer(wtz.features, () => true),
  ...layer(osmAreas.features, (p) => p.natural === 'water'),
];

// Street furniture faces the nearest kerb, path or wall, and never stands in a house or the river.
const edges = new EdgeIndex();
for (const ring of [...roads, ...plazas, ...buildings.map((b) => b.ring)]) edges.add(ring);
for (const p of paths) edges.add(p.line, false);
const blocked = new RingIndex();
for (const ring of [...water, ...buildings.map((b) => b.ring)]) blocked.add(ring);
const river = new RingIndex();
for (const ring of water) river.add(ring);
// Tanks lower than this were built after the 2013–15 LiDAR, or are buried: leave them out.
const MIN_TANK = 2.5;
const tanks: Tank[] = knw.structures.flatMap(({ kind, h, ring }) => {
  const footprint = tankOutline(normalizeRing(ring.flat()));
  return kind === 'tank' && h >= MIN_TANK && footprint.length >= 6 && ringInArea(footprint, AREA)
    ? [{ height: h, ring: new Float32Array(footprint) }]
    : [];
});
const parapets = knw.structures
  .filter((s) => s.kind === 'bridge')
  .flatMap((s) => bridgeParapets(normalizeRing(s.ring.flat()), river))
  .flatMap((line) => AREA.flatMap((rect) => clipLine(line, rect)))
  .map((line) => new Float32Array(line));

// Labels: names and places read from the OSM element (or GRB footprint) each one refers to,
// in every Overpass download of the manifest.
const osmElements = (
  await Promise.all(
    SOURCES.filter((s) => s.kind === 'overpass').map((s) =>
      read<{ elements: OsmElement[] }>(s.output),
    ),
  )
).flatMap((dump) => dump.elements);
const labels = LANDMARKS.map((ref) => {
  const minZoom = ref.minZoom ?? 0;
  if ('grb' in ref) {
    const name = local.buildings.find((building) => building.id === ref.grb)?.name;
    const b = buildings.find((building) => building.id === ref.grb);
    if (!name || !b) throw new Error(`Label: GRB footprint ${ref.grb} has no OSM name.`);
    const { cx: x, cz: z } = orientedRect(b.ring);
    return { name, x, z, minZoom };
  }
  const element = findElement(ref, osmElements);
  const name = element?.tags && labelName(element.tags);
  const centre = element && elementCentre(element);
  if (!name || !centre) throw new Error(`Label: no named OSM element for ${JSON.stringify(ref)}.`);
  const [x, z] = toLocal(...centre);
  return { name, x, z, minZoom };
});

const STRIP = 50; // sorted in strips, so neighbours are near each other and deltas stay small
const props = placeProps(
  osmPoints.features.flatMap((f) => {
    const [x, z] = toLocal(...(f.geometry.coordinates as [number, number]));
    return areaIndex(AREA, x, z) >= 0 ? [{ x, z, tags: f.properties }] : [];
  }),
  edges,
  blocked,
).toSorted((a, b) => Math.floor(a.z / STRIP) - Math.floor(b.z / STRIP) || a.x - b.x);

const city: City = {
  area: [...AREA],
  bounds: VIEW_AREA,
  labels,
  buildings,
  roads,
  carriageways,
  markings,
  plazas,
  green: layer(
    osmAreas.features,
    (p) => GREEN_LEISURE.has(p.leisure ?? '') || GREEN_LANDUSE.has(p.landuse ?? ''),
    MIN_GREEN_AREA,
  ),
  woods: layer(osmAreas.features, WOODS, MIN_GREEN_AREA),
  pitches: layer(osmAreas.features, (p) => p.leisure === 'pitch', MIN_GREEN_AREA),
  parking: layer(
    osmAreas.features,
    (p) => p.amenity === 'parking' && p.parking !== 'underground' && p.parking !== 'multi-storey',
    MIN_GREEN_AREA,
  ),
  water,
  paths,
  trees: new Float32Array(trees.positions),
  treeHeights: new Float32Array(trees.heights),
  props,
  tanks,
  parapets,
};

const bytes = await packCity(city);
await Bun.write(OUT, bytes);

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
    `woods ${city.woods.length}, pitches ${city.pitches.length}, parking ${city.parking.length}`,
    `paths ${paths.length} (${paths.filter((p) => !p.paved).length} unpaved)`,
    `trees ${trees.heights.length} (${osmTrees.length / 2} mapped), labels ${city.labels.length}`,
    `sheds under trees capped ${shedsCapped}, shop fronts ${shopFronts} (${buildings.filter((b) => b.kind === 'retail').length} retail)`,
    `roofs ${buildings.filter((b) => b.roof === 'flat').length} flat, ${buildings.filter((b) => b.roofColor !== null).length} with a sampled colour, ${buildings.filter((b) => b.holes.length).length} with courtyards`,
    `props ${props.length}: ${Object.entries(Object.groupBy(props, (p) => p.kind))
      .map(([kind, list]) => `${list!.length} ${kind}`)
      .join(', ')}`,
    `tanks ${tanks.length}, bridge parapets ${parapets.length}`,
    `labels: ${labels.map((l) => l.name).join(', ')}`,
    `public/data/city.bin ${(bytes.length / 1024).toFixed(0)} KB gzipped`,
  ].join('\n'),
);
