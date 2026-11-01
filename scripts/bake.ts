/**
 * Bakes public/data/city.bin from data/derived/ and the GRB downloads (`bun run data` makes
 * both; see docs/DATA.md). Only this edge reads files; the transforms live in src/data and
 * are unit-tested. Same inputs, same bytes: `bun run data:check` holds it to that.
 *
 *   bun run bake
 */

import { AREA, LANDMARK_FOOTPRINTS, VIEW_AREA } from '../src/data/area.ts';
import { kindFromOsm, pathFromOsm, railFromOsm, roofFromSurvey } from '../src/data/city.ts';
import type {
  Building,
  Carriageway,
  City,
  Marking,
  Path,
  Rail,
  Tank,
  Tier,
} from '../src/data/city.ts';
import { packCity } from '../src/data/format.ts';
import {
  areaIndex,
  clipLine,
  uncoveredPieces,
  clipRingToArea,
  joinRings,
  normalizeRing,
  orientedRect,
  pointInRing,
  ringInArea,
  signedArea,
  simplifyLine,
  simplifyRing,
} from '../src/data/geometry.ts';
import { toLocal } from '../src/data/projection.ts';
import {
  EdgeIndex,
  RingIndex,
  Shapes,
  discInFootprint,
  placeProps,
  propFootprint,
} from '../src/data/props.ts';
import { carriagewayKind, crossingMarking } from '../src/data/roads.ts';
import type { RoadRole } from '../src/data/roads.ts';
import { correctRoofColours } from '../src/data/roof-colours.ts';
import { capShedsUnderTrees } from '../src/data/sheds.ts';
import { isShopFront, markShopFronts } from '../src/data/shops.ts';
import { bridgeParapets, tankOutline } from '../src/data/structures.ts';
import { joinLines, nameTable, streetName } from '../src/data/streets.ts';
import { clearCrowns, mergeTrees, trunkRadius } from '../src/data/trees.ts';
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
type LatLon = { lat: number; lon: number }[];
/** An Overpass `out geom` dump: ways with their geometry, relations with their members'. */
interface Overpass {
  elements: { type: string; geometry?: LatLon; members?: { role: string; geometry?: LatLon }[] }[];
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
/** Track curves are long and gentle: 10 cm off is a third of a game pixel at the closest zoom. */
const RAIL_SIMPLIFY = 0.1;

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

/** The rings of the features `keep` picks, each with the feature it came from. */
const featureRings = (features: Feature[], keep: (p: Props) => boolean, minArea = 0) =>
  features
    .filter((f) => keep(f.properties))
    .flatMap((f) => areaRings(f).map((r) => ({ f, r })))
    .filter(({ r }) => r.length >= 6 && Math.abs(signedArea(r)) >= minArea)
    .map(({ f, r }) => ({ props: f.properties, ring: new Float32Array(r) }));
const layer = (features: Feature[], keep: (p: Props) => boolean, minArea = 0) =>
  featureRings(features, keep, minArea).map(({ ring }) => ring);

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

const [local, crowns, knw, wbn, zones, wtz, gba, osmAreas, osmRoads, osmPoints, osmPlatforms] =
  await Promise.all([
    read<{ buildings: LocalBuilding[] }>('derived/leuven_buildings_local.json'),
    read<{ trees: [number, number, number][] }>('derived/lidar_trees.json'),
    read<{ structures: { kind: string; h: number; ring: [number, number][] }[] }>(
      'derived/grb_structures.json',
    ),
    read<Collection>('grb/grb_WBN.geojson'),
    read<RoadZones>('derived/road_zones.json'),
    read<Collection>('grb/grb_WTZ.geojson'),
    read<Collection>('grb/grb_GBA.geojson'),
    read<Collection>('derived/osm_areas.geojson'),
    read<Collection>('derived/osm_roads.geojson'),
    read<Collection>('derived/osm_points.geojson'),
    read<Overpass>('osm/rail_platforms.json'),
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
const roofSamples = buildings.map((b) => ({
  roofColor: b.roofColor,
  flat: b.roof === 'flat',
  ring: b.ring,
}));
correctRoofColours(roofSamples);
for (const [i, b] of buildings.entries()) b.roofColor = roofSamples[i]!.roofColor;

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

const lineOf = (f: Feature) =>
  (f.geometry.coordinates as [number, number][]).flatMap(([lon, lat]) => toLocal(lon, lat));
const rails: Rail[] = osmAreas.features.flatMap((f) => {
  const style = railFromOsm(f.properties);
  if (!style || f.geometry.type !== 'LineString') return [];
  const line = simplifyLine(lineOf(f), RAIL_SIMPLIFY);
  return AREA.flatMap((rect) => clipLine(line, rect)).map((piece) =>
    Object.assign({ line: new Float32Array(piece) }, style),
  );
});

// Station platforms are multipolygons, often chained from several open ways.
const platforms = osmPlatforms.elements
  .flatMap((e) =>
    joinRings(
      (e.type === 'way'
        ? [e.geometry]
        : (e.members ?? []).filter((m) => m.role === 'outer').map((m) => m.geometry)
      ).map((g) => (g ?? []).flatMap(({ lon, lat }) => toLocal(lon, lat))),
    ),
  )
  .flatMap((ring) => clipRingToArea(simplifyRing(normalizeRing(ring), GROUND_SIMPLIFY), AREA))
  .filter((ring) => ring.length >= 6)
  .map((ring) => new Float32Array(ring));

const railLand = layer(osmAreas.features, (p) => p.landuse === 'railway');
/**
 * Platform roofs: GRB annexes surveyed as an `afdak` (canopy), big enough to span tracks and
 * standing on railway land. In this area that is Leuven's wave roof, kept whole and unsimplified
 * since only its oriented rectangle is drawn.
 */
const MIN_CANOPY = 2000;
const canopies = gba.features
  .filter((f) => f.properties.LBLTYPE === 'afdak')
  .flatMap(areaRings)
  .filter((ring) => Math.abs(signedArea(ring)) >= MIN_CANOPY)
  .filter((ring) => {
    const n = ring.length / 2;
    const [x, z] = [0, 1].map(
      (k) => ring.filter((_, i) => i % 2 === k).reduce((a, b) => a + b) / n,
    );
    return railLand.some((land) => pointInRing(land, x!, z!));
  })
  .map((ring) => new Float32Array(ring));

// The LiDAR takes a platform roof's ribs and edges for crowns of its height. Mapped trees are
// real, so only its crowns are dropped under and right beside a roof.
const ROOF_MARGIN = 6;
const roofs = canopies.map(orientedRect);
const underRoof = (x: number, z: number) =>
  roofs.some(({ cx, cz, ux, uz, halfLength, halfWidth }) => {
    const [dx, dz] = [x - cx, z - cz];
    return (
      Math.abs(dx * ux + dz * uz) < halfLength + ROOF_MARGIN &&
      Math.abs(dx * uz - dz * ux) < halfWidth + ROOF_MARGIN
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

const allTrees = mergeTrees(
  osmTrees,
  crowns.trees.filter(([x, z]) => areaIndex(AREA, x, z) >= 0 && !underRoof(x, z)),
);

const roads = layer(wbn.features, () => true);
const squareRings = [
  ...featureRings(
    osmAreas.features,
    (p) => p.place === 'square' || p['area:highway'] !== undefined,
  ),
  ...featureRings(osmRoads.features, closedPedestrianArea),
];
const plazas = squareRings.map(({ ring }) => ring);
const water = [
  ...layer(wtz.features, () => true),
  ...layer(osmAreas.features, (p) => p.natural === 'water'),
];

// A path under a road surface or a square is never seen (44% of their length): keep the rest.
const paved = new RingIndex();
for (const ring of [...roads, ...plazas]) paved.add(ring);
const shownPaths: Path[] = paths.flatMap((p) =>
  uncoveredPieces(p.line, (x, z) => paved.contains(x, z)).map((piece): Path => ({
    width: p.width,
    paved: p.paved,
    line: new Float32Array(piece),
  })),
);
const pathLength = (list: Path[]) =>
  list.reduce((sum, { line }) => {
    for (let i = 0; i + 3 < line.length; i += 2) {
      sum += Math.hypot(line[i + 2]! - line[i]!, line[i + 3]! - line[i + 1]!);
    }
    return sum;
  }, 0);

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
/** Bridge decks, clipped to the area: walkable over the water and drawn as stone above it. */
const bridges = knw.structures
  .filter((s) => s.kind === 'bridge')
  .flatMap((s) => clipRingToArea(normalizeRing(s.ring.flat()), AREA))
  .filter((r) => r.length >= 6)
  .map((r) => new Float32Array(r));
const parapets = knw.structures
  .filter((s) => s.kind === 'bridge')
  .flatMap((s) => bridgeParapets(normalizeRing(s.ring.flat()), river))
  .flatMap((line) => AREA.flatMap((rect) => clipLine(line, rect)))
  .map((line) => new Float32Array(line));

// Street furniture by rule (src/data/props.ts): turned to its kerb, kept off walls, water, tanks,
// trunks and each other, and off the carriageway unless mapped there.
const kerbs = new Shapes();
for (const { role, ring } of zones.faces) {
  if (role === 'pedestrian') continue;
  for (const r of clipRingToArea(normalizeRing(ring.flat()), AREA))
    if (r.length >= 6) kerbs.ring(r);
}
const solid = new Shapes();
for (const ring of [...buildings.map((b) => b.ring), ...tanks.map((t) => t.ring)]) solid.ring(ring);
const pools = new Shapes();
for (const ring of water) pools.ring(ring);
for (const line of parapets) solid.line(line);
const edges = new EdgeIndex();
for (const ring of [...roads, ...plazas, ...buildings.map((b) => b.ring)]) edges.add(ring);
for (const p of paths) edges.add(p.line, false);
const squares = new RingIndex();
for (const ring of plazas) squares.add(ring);
const mappedTrees = osmTrees.length / 2;
const STRIP = 50; // sorted in strips, so neighbours are near each other and deltas stay small
const placed = placeProps(
  osmPoints.features.flatMap((f) => {
    const [x, z] = toLocal(...(f.geometry.coordinates as [number, number]));
    return areaIndex(AREA, x, z) >= 0 ? [{ x, z, tags: f.properties }] : [];
  }),
  {
    roads: kerbs,
    solid,
    water: pools,
    edges,
    squares,
    trunks: allTrees.heights
      .slice(0, mappedTrees)
      .map((h, i) => [allTrees.positions[i * 2]!, allTrees.positions[i * 2 + 1]!, trunkRadius(h)]),
  },
);
const props = placed.props.toSorted(
  (a, b) => Math.floor(a.z / STRIP) - Math.floor(b.z / STRIP) || a.x - b.x,
);
// LiDAR crowns give way to mapped furniture: the Totem's needle is no tree.
const near = Map.groupBy(
  props.map(propFootprint),
  (f) => `${Math.round(f.x / 16)},${Math.round(f.z / 16)}`,
);
const trees = clearCrowns(allTrees, mappedTrees, (x, z, r) =>
  [-1, 0, 1].some((i) =>
    [-1, 0, 1].some((j) =>
      (near.get(`${Math.round(x / 16) + i},${Math.round(z / 16) + j}`) ?? []).some((f) =>
        discInFootprint(f, x, z, r),
      ),
    ),
  ),
);

// The street sign: every named road and path as a centre line, and every named square, sharing
// one table of names (src/data/streets.ts). Simplified to 2 m: well inside the sign's 20 m reach.
const STREET_SIMPLIFY = 2;
const waysByName = Map.groupBy(
  osmRoads.features.flatMap((f) => {
    const name = streetName(f.properties);
    return name && f.geometry.type === 'LineString' ? [{ name, line: lineOf(f) }] : [];
  }),
  (way) => way.name,
);
// A street's ways meet at shared nodes: joined, each corner is stored once.
const streetLines = [...waysByName].flatMap(([name, ways]) =>
  joinLines(ways.map((way) => way.line))
    .map((line) => simplifyLine(line, STREET_SIMPLIFY))
    .flatMap((line) => AREA.flatMap((rect) => clipLine(line, rect)))
    .filter((piece) => piece.length >= 4)
    .map((piece) => ({ name, line: new Float32Array(piece) })),
);
const squareNames = squareRings.map((square) => square.props.name?.trim() || null);
const names = nameTable([...streetLines.map((s) => s.name), ...squareNames]);
// In strips like the props, so each line starts near the one before it and its start costs little.
const streets = streetLines
  .map((s, i) => ({ name: names.index[i]!, line: s.line }))
  .toSorted(
    (a, b) =>
      Math.floor(a.line[1]! / STRIP) - Math.floor(b.line[1]! / STRIP) || a.line[0]! - b.line[0]!,
  );
const plazaNames = names.index.slice(streetLines.length);

const city: City = {
  area: [...AREA],
  bounds: VIEW_AREA,
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
  paths: shownPaths,
  rails,
  platforms,
  railLand,
  canopies,
  trees: new Float32Array(trees.positions),
  treeHeights: new Float32Array(trees.heights),
  props,
  tanks,
  bridges,
  parapets,
  streetNames: names.table,
  streets,
  plazaNames,
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
    `paths ${shownPaths.length} (${shownPaths.filter((p) => !p.paved).length} unpaved), ${(pathLength(shownPaths) / 1000).toFixed(0)} of ${(pathLength(paths) / 1000).toFixed(0)} km not under a road or square`,
    `rails ${rails.length} (${rails.filter((r) => r.bridge).length} on bridges, ${rails.reduce((sum, r) => sum + r.line.length / 2 - 1, 0)} segments), platforms ${city.platforms.length}, railway land ${railLand.length}, platform roofs ${canopies.length}`,
    `trees ${trees.heights.length} (${osmTrees.length / 2} mapped)`,
    `sheds under trees capped ${shedsCapped}, shop fronts ${shopFronts} (${buildings.filter((b) => b.kind === 'retail').length} retail)`,
    `roofs ${buildings.filter((b) => b.roof === 'flat').length} flat, ${buildings.filter((b) => b.roofColor !== null).length} with a sampled colour, ${buildings.filter((b) => b.holes.length).length} with courtyards`,
    `props ${props.length} (${placed.nudged} nudged, ${placed.dropped} dropped, ${allTrees.heights.length - trees.heights.length} crowns cleared): ${Object.entries(
      Object.groupBy(props, (p) => p.kind),
    )
      .map(([kind, list]) => `${list!.length} ${kind}`)
      .join(', ')}`,
    `tanks ${tanks.length}, bridge decks ${bridges.length}, parapets ${parapets.length}`,
    `street names ${names.table.length}: ${streets.length} streets (${streets.reduce((sum, s) => sum + s.line.length / 2, 0)} points), ${plazaNames.filter((n) => n >= 0).length} of ${plazas.length} squares named`,
    `public/data/city.bin ${(bytes.length / 1024).toFixed(0)} KB gzipped`,
  ].join('\n'),
);
