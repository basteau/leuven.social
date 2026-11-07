/**
 * Bakes public/data/city.bin from data/derived/ and the GRB and OSM downloads (`bun run data`
 * makes it; see docs/DATA.md). Only this edge reads files; the transforms live in src/data and
 * are unit-tested. Same inputs, same bytes: `bun run data:check` holds it to that.
 *
 *   bun run bake
 */

import { AREA, LANDMARK_FOOTPRINTS, VIEW_AREA } from '../src/data/area.ts';
import {
  kindFromOsm,
  pathFromOsm,
  railFromOsm,
  roofAcross,
  roofFromSurvey,
} from '../src/data/city.ts';
import { PAVED } from '../src/data/city.ts';
import type {
  Bounds,
  Building,
  Carriageway,
  City,
  Marking,
  Path,
  Rail,
  Tank,
  TerrainGrid,
  Tier,
} from '../src/data/city.ts';
import { packCity } from '../src/data/format.ts';
import { Facades, streetSegments } from '../src/data/facades.ts';
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
import { coverOf, groundRings, osmAreas as areasOf } from '../src/data/landcover.ts';
import type { Cover, OsmElement } from '../src/data/landcover.ts';
import { FIELD_SPORTS, fieldOf, pitchSurface } from '../src/data/pitches.ts';
import { toLocal } from '../src/data/projection.ts';
import {
  EdgeIndex,
  RingIndex,
  Shapes,
  discInFootprint,
  placeProps,
  propFootprint,
  rackFill,
} from '../src/data/props.ts';
import type { FillClass } from '../src/data/props.ts';
import { carriagewayKind, surfaceOf, crossingMarking } from '../src/data/roads.ts';
import type { RoadRole } from '../src/data/roads.ts';
import { correctRoofColours } from '../src/data/roof-colours.ts';
import { capShedsUnderTrees } from '../src/data/sheds.ts';
import { fitTerraces, markShopFronts, placeFronts } from '../src/data/shops.ts';
import { bridgeParapets, tankOutline } from '../src/data/structures.ts';
import { joinLines, nameTable, streetName } from '../src/data/streets.ts';
import { sidesOf, sidesWithTags, splitAtJunctions, wayFromOsm } from '../src/data/traffic.ts';
import type { Way } from '../src/data/city.ts';
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
  elements: {
    type: string;
    tags?: Props;
    geometry?: LatLon;
    members?: { role: string; geometry?: LatLon }[];
  }[];
}
/** tools/build_road_zones.py: carriageways cut from the road surface, lane lines and crossings. */
interface RoadZones {
  faces: { role: RoadRole; tags: Props; ring: [number, number][] }[];
  lines: { kind: 'dashed' | 'solid' | 'cycle-lane'; line: [number, number][] }[];
  crossings: { tags: Props; line: [number, number][] }[];
}
/** tools/build_leuven_data.py: the landform (m TAW), node (i, j) at ((i0 + i) step, (j0 + j) step). */
interface TerrainJson {
  step: number;
  i0: number;
  j0: number;
  cols: number;
  rows: number;
  heights: number[];
}

/**
 * The part of the landform that covers the map, a node past every edge, as heights above the
 * ground at Grote Markt (the node on the origin): y = 0 stays at the map's centre.
 */
function terrainOver(t: TerrainJson, { minX, minZ, maxX, maxZ }: Bounds): TerrainGrid {
  const [i0, j0] = [Math.floor(minX / t.step), Math.floor(minZ / t.step)];
  const [cols, rows] = [Math.ceil(maxX / t.step) - i0 + 1, Math.ceil(maxZ / t.step) - j0 + 1];
  const at = (i: number, j: number) => {
    const [c, r] = [i - t.i0, j - t.j0];
    if (c < 0 || r < 0 || c >= t.cols || r >= t.rows) {
      throw new Error(`data/derived/terrain.json stops short of the map at node ${i}, ${j}.`);
    }
    return t.heights[r * t.cols + c]!;
  };
  const datum = at(0, 0);
  const heights = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) heights[r * cols + c] = at(i0 + c, j0 + r) - datum;
  }
  return { step: t.step, minX: i0 * t.step, minZ: j0 * t.step, cols, rows, heights };
}

interface LocalBuilding {
  id: number;
  h: number;
  /** LiDAR p15 height and the share of pitched roof pixels (see tools/build_leuven_data.py). */
  eave?: number;
  pitch?: number;
  /** Orthophoto roof colour, white-balanced. */
  rgb?: [number, number, number] | null;
  /** The axis the roof slopes face (degrees from x towards z) and how strongly, 0–1. */
  facing?: [number, number];
  /** A church tower: centre x, z, radius, wall top and spire tip (m). */
  tower?: [number, number, number, number, number];
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

/** Courtyards smaller than this are light wells: below a game pixel, and not worth the walls. */
const MIN_COURTYARD = 12;

const [
  local,
  crowns,
  knw,
  wbn,
  zones,
  wtz,
  gba,
  osmAreaElements,
  osmRoads,
  osmPoints,
  osmPlatforms,
  landform,
] = await Promise.all([
  read<{ buildings: LocalBuilding[] }>('derived/leuven_buildings_local.json'),
  read<{ trees: [number, number, number][] }>('derived/lidar_trees.json'),
  read<{ structures: { kind: string; h: number; ring: [number, number][] }[] }>(
    'derived/grb_structures.json',
  ),
  read<Collection>('grb/grb_WBN.geojson'),
  read<RoadZones>('derived/road_zones.json'),
  read<Collection>('grb/grb_WTZ.geojson'),
  read<Collection>('grb/grb_GBA.geojson'),
  read<{ elements: OsmElement[] }>('osm/areas.json'),
  read<Collection>('derived/osm_roads.geojson'),
  read<Collection>('derived/osm_points.geojson'),
  read<Overpass>('osm/rail_platforms.json'),
  read<TerrainJson>('derived/terrain.json'),
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
  const building: Building = {
    id: b.id,
    tier,
    kind: kindFromOsm(b.kind),
    roof: roofAcross(roofFromSurvey(b.roof, b.pitch), b.facing, orientedRect(ring)),
    height,
    eave: Math.min(height, Math.max(2.5, b.eave ?? height)),
    roofColor: b.rgb ? (b.rgb[0] << 16) | (b.rgb[1] << 8) | b.rgb[2] : null,
    ring: new Float32Array(ring),
    holes,
  };
  // A landmark model has its own tower, fitted by hand.
  if (b.tower && !LANDMARK_FOOTPRINTS.includes(b.id)) {
    const [x, z, radius, top, tip] = b.tower;
    building.tower = { x, z, radius, top, tip };
  }
  buildings.push(building);
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

const closedPedestrianArea = (p: Props) =>
  (p.highway === 'pedestrian' || p.highway === 'footway') && p.area === 'yes';

const osmTrees = osmPoints.features
  .filter((f) => f.properties.natural === 'tree')
  .map((f) => toLocal(...(f.geometry.coordinates as [number, number])))
  .filter(([x, z]) => areaIndex(AREA, x, z) >= 0);
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
// Tracks are the open railway ways (a closed one would be an area).
const rails: Rail[] = osmAreaElements.elements.flatMap((e) => {
  const style = railFromOsm(e.tags ?? {});
  const points = (e.geometry ?? []).flatMap((p) => (p ? [p] : []));
  const [first, last] = [points[0], points.at(-1)];
  const closed = points.length >= 4 && first?.lon === last?.lon && first?.lat === last?.lat;
  if (!style || e.type !== 'way' || points.length < 2 || closed) return [];
  const line = simplifyLine(
    points.flatMap(({ lon, lat }) => toLocal(lon, lat)),
    RAIL_SIMPLIFY,
  );
  return AREA.flatMap((rect) => clipLine(line, rect)).map((piece) =>
    Object.assign({ line: new Float32Array(piece) }, style),
  );
});

// OSM's areas, ways and multipolygons alike, each in the ground layer its tags say
// (src/data/landcover.ts), holes and all.
const covers = areasOf(osmAreaElements.elements, toLocal).flatMap((a) => {
  const cover = coverOf(a.tags);
  return cover ? [{ cover, tags: a.tags, polygons: a.polygons }] : [];
});
/** The rings of one ground layer, with the tags of the area each came from. */
const coverRings = (cover: Cover, minArea = 0) =>
  covers
    .filter((c) => c.cover === cover)
    .flatMap(({ tags, polygons }) =>
      groundRings(polygons, AREA, GROUND_SIMPLIFY, minArea).map((r) => ({
        props: tags as Props,
        ring: new Float32Array(r),
      })),
    );
const coverLayer = (cover: Cover, minArea = 0) =>
  coverRings(cover, minArea).map(({ ring }) => ring);

// Pitches keep what they're made of, and the lines of the fields their whole outlines hold
// (src/data/pitches.ts), measured before the area cuts them.
const pitchRings = coverRings('pitches', MIN_GREEN_AREA);
const fields = covers
  .filter((c) => c.cover === 'pitches')
  .flatMap(({ tags, polygons }) => polygons.flatMap((p) => fieldOf(tags, p, AREA) ?? []));

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

const railLand = coverLayer('railLand');
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
  const surface = surfaceOf(tags);
  return clipRingToArea(normalizeRing(ring.flat()), AREA)
    .filter((r) => r.length >= 6)
    .map((r) => ({ kind, surface, ring: new Float32Array(r) }));
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

// Footprints and carriageways, for keeping trees and traffic out of houses and off the road.
const footprints = new RingIndex();
for (const b of buildings) footprints.add(b.ring);
const carriagewayGround = new RingIndex();
for (const c of carriageways) carriagewayGround.add(c.ring);
// A mapped tree inside a footprint is in the wrong place: the house is surveyed, the tree typed.
const allTrees = mergeTrees(
  osmTrees.filter(([x, z]) => !footprints.contains(x, z)).flat(),
  crowns.trees.filter(([x, z]) => areaIndex(AREA, x, z) >= 0 && !underRoof(x, z)),
);

const roads = layer(wbn.features, () => true);
const squareRings = [
  ...coverRings('plazas'),
  ...featureRings(osmRoads.features, closedPedestrianArea),
];
const plazas = squareRings.map(({ ring }) => ring);
const water = [...layer(wtz.features, () => true), ...coverLayer('water')];

// A path under a carriageway or a square is never seen: keep the rest, which runs over the
// plain road surface too (a track the GRB surveyed as a road, an earth path in a verge).
const hard = new RingIndex();
for (const ring of [...carriageways.map((c) => c.ring), ...plazas]) hard.add(ring);
const shownPaths: Path[] = paths.flatMap((p) =>
  uncoveredPieces(p.line, (x, z) => hard.contains(x, z)).map((piece): Path => ({
    width: p.width,
    surface: p.surface,
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
// How full each rack is: by the station (the middle of its platform roofs), how many stands
// stand round it, and whether it's behind a gate (src/data/props.ts).
const roofCorners = canopies.flatMap((ring) => [...ring]);
const station: [number, number] | null = roofCorners.length
  ? ([0, 1].map(
      (k) =>
        roofCorners.filter((_, i) => i % 2 === k).reduce((a, b) => a + b) /
        (roofCorners.length / 2),
    ) as [number, number])
  : null;
const racks = placed.props.flatMap((p, i) =>
  p.kind === 'bikes' ? [{ p, access: placed.tags[i]!.access }] : [],
);
const fills = rackFill(
  racks.map(({ p, access }) => ({ x: p.x, z: p.z, size: p.size, access })),
  station,
);
const byFill = new Map<FillClass, { racks: number; stands: number; bikes: number }>();
for (const [i, { p }] of racks.entries()) {
  const { class: kind, bikes } = fills[i]!;
  p.fill = bikes / p.size;
  const sum = byFill.get(kind) ?? { racks: 0, stands: 0, bikes: 0 };
  byFill.set(kind, { racks: sum.racks + 1, stands: sum.stands + p.size, bikes: sum.bikes + bikes });
}
const props = placed.props.toSorted(
  (a, b) => Math.floor(a.z / STRIP) - Math.floor(b.z / STRIP) || a.x - b.x,
);
// LiDAR crowns give way to mapped furniture (the Totem's needle is no tree), and a crown
// whose trunk would stand on a carriageway or in a house leans over it from a trunk elsewhere.
const near = Map.groupBy(
  props.map(propFootprint),
  (f) => `${Math.round(f.x / 16)},${Math.round(f.z / 16)}`,
);
const trees = clearCrowns(
  allTrees,
  mappedTrees,
  (x, z, r) =>
    carriagewayGround.contains(x, z) ||
    footprints.contains(x, z) ||
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

// Shop fronts (src/data/shops.ts): each shop's kind, on the wall its house number would take,
// and a terrace where OSM maps outdoor seating and the pavement has room for it.
const nameIndex = new Map(names.table.map((name, i) => [name, i]));
const facades = new Facades(buildings.map((b) => b.ring));
const landmarks = new Set(
  buildings.flatMap((b, i) => (LANDMARK_FOOTPRINTS.includes(b.id) ? [i] : [])),
);
const segments = streetSegments(streets);
const namedSquares = new Map<number, Float32Array[]>();
for (const [i, ring] of plazas.entries()) {
  const name = plazaNames[i]!;
  if (name >= 0) namedSquares.set(name, [...(namedSquares.get(name) ?? []), ring]);
}
const publicGround = new RingIndex();
for (const ring of [...roads, ...plazas]) publicGround.add(ring);
const shops = placeFronts(
  osmPoints.features.flatMap((f) => {
    if (f.geometry.type !== 'Point') return [];
    const [x, z] = toLocal(...(f.geometry.coordinates as [number, number]));
    return areaIndex(AREA, x, z) >= 0 ? [{ x, z, tags: f.properties }] : [];
  }),
  {
    facades,
    streets: segments,
    names: nameIndex,
    squares: namedSquares,
    open: (x, z) => publicGround.contains(x, z),
    skip: landmarks,
  },
);
const terraces = fitTerraces(
  shops.fronts,
  buildings.map((b) => b.ring),
  {
    roads: kerbs,
    solid,
    water: pools,
    props: props.map(propFootprint),
    trunks: Array.from({ length: trees.heights.length }, (_, i) => [
      trees.positions[i * 2]!,
      trees.positions[i * 2 + 1]!,
      trunkRadius(trees.heights[i]!),
    ]),
  },
);
const shopFronts = markShopFronts(buildings, shops.fronts);

const city: City = {
  area: [...AREA],
  bounds: VIEW_AREA,
  buildings,
  roads,
  carriageways,
  markings,
  plazas,
  green: coverLayer('green', MIN_GREEN_AREA),
  woods: coverLayer('woods', MIN_GREEN_AREA),
  pitches: pitchRings.map(({ ring }) => ring),
  pitchSurfaces: pitchRings.map((p) => pitchSurface(p.props)),
  fields,
  parking: coverLayer('parking', MIN_GREEN_AREA),
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
  terrain: terrainOver(landform, VIEW_AREA),
  fronts: shops.fronts,
  ways: [],
};

// The ways traffic moves along (src/data/traffic.ts): the driveable roads, cycle tracks,
// pedestrian streets and paths, turned to run the way their traffic does, split where they
// meet (on OSM's own shared nodes, before anything moves them), clipped to the area,
// simplified to 1 m, and cut wherever they would run through a building (an archway the GRB
// draws solid, a misdrawn way), so nothing drives through a house. Each piece measures both
// its sides: how far the carriageway reaches from its line before the GRB's kerb, and how
// far the open ground goes on to a facade, so cars keep to the carriageway and people to the
// pavement between, however narrow the street. A path's sides are a metre of its own.
const WAY_SIMPLIFY = 1;
/** Whether a spot is open ground: the road surface or a square, and not inside a house. */
const openGround = (x: number, z: number) =>
  publicGround.contains(x, z) && !footprints.contains(x, z);
const onCarriageway = (x: number, z: number) => carriagewayGround.contains(x, z);
const PATH_SIDE = { kerb: 0, edge: 1 } as const;
const drivable = osmRoads.features.flatMap((f) => {
  const style = wayFromOsm(f.properties);
  if (!style || f.geometry.type !== 'LineString') return [];
  const line = lineOf(f);
  if (style.reverse) {
    const back: number[] = [];
    for (let i = line.length - 2; i >= 0; i -= 2) back.push(line[i]!, line[i + 1]!);
    return [{ ...style, line: back }];
  }
  return [{ ...style, line }];
});
const ways: Way[] = splitAtJunctions(drivable)
  .flatMap(({ kind, oneway, bikesBoth, surface, sidewalks, through, minor, line }) =>
    AREA.flatMap((rect) => clipLine(line, rect))
      .flatMap((piece) => uncoveredPieces(piece, (x, z) => footprints.contains(x, z), 1))
      .map((piece) => {
        const simplified = simplifyLine(piece, WAY_SIMPLIFY);
        const [right, left] =
          kind === 'path'
            ? [{ ...PATH_SIDE }, { ...PATH_SIDE }]
            : sidesWithTags(
                sidesOf(simplified, openGround, onCarriageway),
                sidewalks,
                (kind === 'street' || kind === 'main') && !minor,
              );
        return { kind, oneway, bikesBoth, surface, right, left, through, minor, line: simplified };
      }),
  )
  .filter((w) => w.line.length >= 4)
  .toSorted(
    (a, b) =>
      Math.floor(a.line[1]! / STRIP) - Math.floor(b.line[1]! / STRIP) || a.line[0]! - b.line[0]!,
  )
  .map((w) => Object.assign(w, { line: new Float32Array(w.line) }) as unknown as Way);
city.ways = ways;

const bytes = await packCity(city);
await Bun.write(OUT, bytes);

const reasons = (skipped: Record<string, number>) =>
  Object.entries(skipped)
    .map(([why, n]) => `${n} ${why}`)
    .join(', ');

const tiers = Object.groupBy(buildings, (b) => b.tier);
console.log(
  [
    `buildings ${buildings.length} (hero ${tiers.hero?.length ?? 0}, core ${tiers.core?.length ?? 0})`,
    `ways for traffic ${ways.length} (${ways.filter((w) => w.oneway).length} one-way, ${ways.reduce((n, w) => n + w.line.length / 2, 0)} points)`,
    `roads ${city.roads.length}, carriageways ${carriageways.length} (${Object.entries(
      Object.groupBy(carriageways, (r) => r.kind),
    )
      .map(([k, v]) => `${k} ${v?.length}`)
      .join(', ')})`,
    `markings ${Object.entries(Object.groupBy(markings, (m) => m.kind))
      .map(([k, v]) => `${k} ${v?.length}`)
      .join(', ')}`,
    `plazas ${city.plazas.length}, green ${city.green.length}, water ${city.water.length}`,
    `woods ${city.woods.length}, pitches ${city.pitches.length} (${fields.length} with lines: ${FIELD_SPORTS.map((s) => `${fields.filter((f) => f.sport === s).length} ${s}`).join(', ')}), parking ${city.parking.length}`,
    `paths ${shownPaths.length} (${shownPaths.filter((p) => !PAVED.has(p.surface)).length} unpaved), ${(pathLength(shownPaths) / 1000).toFixed(0)} of ${(pathLength(paths) / 1000).toFixed(0)} km not under a road or square`,
    `rails ${rails.length} (${rails.filter((r) => r.bridge).length} on bridges, ${rails.reduce((sum, r) => sum + r.line.length / 2 - 1, 0)} segments), platforms ${city.platforms.length}, railway land ${railLand.length}, platform roofs ${canopies.length}`,
    `trees ${trees.heights.length} (${osmTrees.length / 2} mapped)`,
    `sheds under trees capped ${shedsCapped}, retail ${buildings.filter((b) => b.kind === 'retail').length} (${shopFronts} by their shop fronts)`,
    `shop fronts ${shops.fronts.length} on ${new Set(shops.fronts.map((f) => f.building)).size} buildings, ${terraces} with a terrace: ${reasons(shops.placed)} (skipped ${reasons(shops.skipped)}); main fronts ${Object.entries(
      Object.groupBy(
        buildings.flatMap((b) => b.front ?? []),
        (f) => f.kind,
      ),
    )
      .map(([kind, list]) => `${list!.length} ${kind}`)
      .join(', ')}`,
    `roofs ${buildings.filter((b) => b.roof === 'flat').length} flat, ${buildings.filter((b) => b.roof === 'across').length} with the ridge across, ${buildings.filter((b) => b.roofColor !== null).length} with a sampled colour, ${buildings.filter((b) => b.holes.length).length} with courtyards`,
    `props ${props.length} (${placed.nudged} nudged, ${placed.dropped} dropped, ${allTrees.heights.length - trees.heights.length} crowns cleared): ${Object.entries(
      Object.groupBy(props, (p) => p.kind),
    )
      .map(([kind, list]) => `${list!.length} ${kind}`)
      .join(', ')}`,
    `bikes ${fills.reduce((sum, f) => sum + f.bikes, 0)} in ${racks.length} racks: ${[...byFill]
      .map(([kind, n]) => `${kind} ${n.bikes} of ${n.stands} stands in ${n.racks} racks`)
      .join(', ')}`,
    `tanks ${tanks.length}, bridge decks ${bridges.length}, parapets ${parapets.length}`,
    `church towers ${buildings.filter((b) => b.tower).length}`,
    `terrain ${city.terrain.cols} × ${city.terrain.rows} nodes every ${city.terrain.step} m, ${Math.min(...city.terrain.heights).toFixed(1)} to ${Math.max(...city.terrain.heights).toFixed(1)} m about Grote Markt`,
    `street names ${names.table.length}: ${streets.length} streets (${streets.reduce((sum, s) => sum + s.line.length / 2, 0)} points), ${plazaNames.filter((n) => n >= 0).length} of ${plazas.length} squares named`,
    `public/data/city.bin ${(bytes.length / 1024).toFixed(0)} KB gzipped`,
  ].join('\n'),
);
