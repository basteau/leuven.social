/**
 * What OpenStreetMap's areas are on the ground: which of the map's ground layers each kind of
 * land is drawn as (docs/DATA.md, "Kinds of ground"), and their rings, joined from multipolygon
 * relations as well as ways. One rule decides for the bake and for `scripts/audit-areas.ts`.
 */

import type { Bounds } from './city.ts';
import { clipRing, joinRings, pointInRing, signedArea, simplifyRing } from './geometry.ts';

type Tags = Readonly<Record<string, string | undefined>>;

/** The ground layers an OSM area can be drawn as. */
export type Cover =
  | 'green'
  | 'woods'
  | 'flowerbeds'
  | 'pitches'
  | 'parking'
  | 'water'
  | 'plazas'
  | 'islands'
  | 'railLand';

const GREEN_LEISURE = new Set(['park', 'garden', 'playground', 'dog_park']);
const GREEN_LANDUSE = new Set([
  'grass',
  'meadow',
  'cemetery',
  'recreation_ground',
  'village_green',
  'allotments',
  'vineyard',
  'greenery',
]);
const GREEN_NATURAL = new Set(['grassland', 'heath', 'wetland']);
const WOODS_LANDUSE = new Set(['forest', 'orchard']);
const WOODS_NATURAL = new Set(['wood', 'scrub']);
const WOODS_LANDCOVER = new Set(['trees', 'scrub']);
/** Car parks under or inside a building are not on the ground. */
const HIDDEN_PARKING = new Set(['underground', 'multi-storey', 'rooftop']);
const WATER_LANDUSE = new Set(['basin', 'reservoir']);

/**
 * The ground layer an OSM area is drawn as, or null for land the map leaves as plain ground:
 * built-up land use (residential, retail, industrial…) and the grounds of schools, campuses and
 * hospitals, which hold buildings, lawns, yards and car parks that are mapped on their own.
 * Where an area carries several tags, the most specific decides: a square or water before a
 * car park, a car park before a pitch, a pitch before woods and woods before green.
 */
export function coverOf(tags: Tags): Cover | null {
  if (tags.place === 'square') return 'plazas';
  const area = tags['area:highway'];
  // A real pedestrian area is a square; an island or a footway is paving; a painted-off area
  // (`prohibited`) and the roadway's own shapes aren't anything on top of the road.
  if (area === 'pedestrian' || area === 'living_street') return 'plazas';
  if (area === 'traffic_island' || area === 'footway' || area === 'bus_bay' || area === 'yes') {
    return 'islands';
  }
  if (area !== undefined) return null;
  if (tags.natural === 'water' || WATER_LANDUSE.has(tags.landuse ?? '')) return 'water';
  if (tags.waterway === 'riverbank') return 'water';
  if (tags.amenity === 'parking' && !HIDDEN_PARKING.has(tags.parking ?? '')) return 'parking';
  // A schoolyard is a hard, open yard: asphalt like a car park's.
  if (tags.leisure === 'schoolyard') return 'parking';
  if (tags.leisure === 'pitch' || tags.leisure === 'track') return 'pitches';
  if (tags.landuse === 'railway') return 'railLand';
  if (tags.landuse === 'flowerbed') return 'flowerbeds';
  // An orchard is rows of trees on grass: from above, a wood.
  if (WOODS_LANDUSE.has(tags.landuse ?? '') || WOODS_NATURAL.has(tags.natural ?? ''))
    return 'woods';
  if (WOODS_LANDCOVER.has(tags.landcover ?? '')) return 'woods';
  if (GREEN_LEISURE.has(tags.leisure ?? '') || GREEN_LANDUSE.has(tags.landuse ?? ''))
    return 'green';
  if (GREEN_NATURAL.has(tags.natural ?? '') || tags.landcover === 'grass') return 'green';
  if (tags.amenity === 'grave_yard') return 'green';
  return null;
}

/** The tags that say what an area is, in the order the audit names them. */
const KIND_KEYS = [
  'landuse',
  'natural',
  'landcover',
  'leisure',
  'amenity',
  'parking',
  'place',
  'area:highway',
  'waterway',
  'railway',
];

/** An area's kind for the audit: its land-describing tags as `key=value`, joined by `+`. */
export function areaKind(tags: Tags): string {
  const parts = KIND_KEYS.filter((k) => tags[k] !== undefined).map((k) => `${k}=${tags[k]}`);
  return parts.join(' + ') || '(none)';
}

type LatLon = readonly ({ lat: number; lon: number } | null)[];
/** An element of an Overpass `out geom` answer. */
export interface OsmElement {
  type: string;
  id: number;
  tags?: Tags;
  geometry?: LatLon;
  members?: readonly { type?: string; role: string; geometry?: LatLon }[];
}

/** An OSM area: its tags, and outer rings each with the holes that lie in it. */
export interface OsmArea {
  id: string;
  tags: Tags;
  /** Flat rings in the coordinates `project` gives, outer rings counter-clockwise. */
  polygons: { outer: number[]; holes: number[][] }[];
}

/**
 * The areas in an Overpass answer: closed ways, and multipolygon relations with their outer and
 * inner rings joined from the member ways (open ones chained end to end, as mappers split long
 * outlines). `project` turns lon, lat into the plane, where rings are oriented and nested.
 * Open ways (a river's line, a railway track) and rings that never close are left out.
 */
export function osmAreas(
  elements: readonly OsmElement[],
  project: (lon: number, lat: number) => readonly [number, number],
): OsmArea[] {
  const line = (geometry: LatLon | undefined) =>
    (geometry ?? []).flatMap((p) => (p ? project(p.lon, p.lat) : []));
  const areas: OsmArea[] = [];
  for (const e of elements) {
    const tags = e.tags ?? {};
    if (e.type === 'way') {
      const ring = line(e.geometry);
      const n = ring.length;
      if (n < 8 || ring[0] !== ring[n - 2] || ring[1] !== ring[n - 1]) continue;
      areas.push({
        id: `w${e.id}`,
        tags,
        polygons: [{ outer: ccw(ring.slice(0, -2)), holes: [] }],
      });
      continue;
    }
    if (e.type !== 'relation' || tags.type !== 'multipolygon') continue;
    const ways = (e.members ?? []).filter((m) => m.type === undefined || m.type === 'way');
    const rings = (role: (r: string) => boolean) =>
      joinRings(ways.filter((m) => role(m.role)).map((m) => line(m.geometry)));
    // An empty role is an outer ring, as in older relations.
    const outers = rings((r) => r !== 'inner').map(ccw);
    const inners = rings((r) => r === 'inner').map((r) => reverse(ccw(r)));
    const polygons = outers.map((outer) => ({ outer, holes: [] as number[][] }));
    for (const hole of inners) {
      const host = polygons.find((p) => pointInRing(p.outer, hole[0]!, hole[1]!));
      host?.holes.push(hole);
    }
    if (polygons.length) areas.push({ id: `r${e.id}`, tags, polygons });
  }
  return areas;
}

/**
 * An area's polygons as the flat rings a ground layer holds: simplified to `tolerance`, cut to
 * each rectangle of the map's area, each hole bridged into the piece it lies in. Pieces whose
 * area (holes taken out) is under `minArea`, and holes under it, are left out.
 */
export function groundRings(
  polygons: OsmArea['polygons'],
  area: readonly Bounds[],
  tolerance: number,
  minArea = 0,
): number[][] {
  const out: number[][] = [];
  for (const { outer, holes } of polygons) {
    const ring = simplifyRing(outer, tolerance);
    const inner = holes
      .map((h) => simplifyRing(h, tolerance))
      .filter((h) => h.length >= 6 && -signedArea(h) >= Math.max(minArea, 1e-9));
    for (const rect of area) {
      const piece = clipRing(ring, rect);
      if (piece.length < 6) continue;
      const cut = inner
        .map((h) => clipRing(h, rect))
        .filter((h) => h.length >= 6 && pointInRing(piece, h[0]!, h[1]!));
      const bridged = cut.length ? bridgeHoles(piece, cut) : piece;
      if (signedArea(bridged) >= minArea) out.push(bridged);
    }
  }
  return out;
}

function reverse(ring: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = ring.length - 2; i >= 0; i -= 2) out.push(ring[i]!, ring[i + 1]!);
  return out;
}

/** Whether segments ab and cd cross at a point inside both (touching ends don't count). */
function crosses(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
): boolean {
  const [d1, d2] = [side(cx, cz, dx, dz, ax, az), side(cx, cz, dx, dz, bx, bz)];
  const [d3, d4] = [side(ax, az, bx, bz, cx, cz), side(ax, az, bx, bz, dx, dz)];
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Whether the line from vertex `i` of `ring` to (x, z) runs along either edge at `i`. */
function inLine(ring: readonly number[], i: number, x: number, z: number): boolean {
  const n = ring.length;
  const [vx, vz] = [ring[i]!, ring[i + 1]!];
  return [(i + n - 2) % n, (i + 2) % n].some((k) => {
    const [ex, ez, dx, dz] = [ring[k]! - vx, ring[k + 1]! - vz, x - vx, z - vz];
    return Math.abs(ex * dz - ez * dx) <= 1e-9 * Math.hypot(ex, ez) * Math.hypot(dx, dz);
  });
}

/** Whether the segment from (ax, az) to (bx, bz) crosses an edge of any of the rings. */
function blocked(ax: number, az: number, bx: number, bz: number, rings: readonly number[][]) {
  for (const ring of rings) {
    for (let i = 0, n = ring.length; i < n; i += 2) {
      const [cx, cz, dx, dz] = [ring[i]!, ring[i + 1]!, ring[(i + 2) % n]!, ring[(i + 3) % n]!];
      if (crosses(ax, az, bx, bz, cx, cz, dx, dz)) return true;
    }
  }
  return false;
}

/** How many corners in sight a hole's cut tries before it settles for the nearest. */
const MAX_CUTS = 32;

/** The index of a ring's vertex furthest east (the first of equals). */
function east(ring: readonly number[]): number {
  let best = 0;
  for (let i = 2; i < ring.length; i += 2) if (ring[i]! > ring[best]!) best = i;
  return best;
}

const side = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number) =>
  (qx - px) * (rz - pz) - (qz - pz) * (rx - px);

const ccw = (ring: number[]) => (signedArea(ring) < 0 ? reverse(ring) : ring);

/**
 * One ring for a polygon with holes, the way earcut works inside: each hole (clockwise) joined
 * to the ring by a cut of no width, from its vertex furthest east to the nearest vertex it can
 * see. Filled even-odd or triangulated, it is the polygon with its holes, so a layer of single
 * rings, the city file and the walk grid all keep the holes without a new format. Its signed
 * area is the outer's minus the holes'.
 */
export function bridgeHoles(outer: readonly number[], holes: readonly (readonly number[])[]) {
  const pending = holes.map((h) => [...h]).toSorted((a, b) => b[east(b)]! - a[east(a)]!);
  let ring = [...outer];
  while (pending.length) {
    const hole = pending.shift()!;
    const m = east(hole);
    const [mx, mz] = [hole[m]!, hole[m + 1]!];
    const order = Array.from({ length: ring.length / 2 }, (_, i) => i * 2).toSorted(
      (a, b) =>
        Math.hypot(ring[a]! - mx, ring[a + 1]! - mz) - Math.hypot(ring[b]! - mx, ring[b + 1]! - mz),
    );
    const others = [ring, hole, ...pending];
    // A cut in line with an edge at either end, or to a corner an earlier cut already uses,
    // leaves the triangulator points it drops as collinear: the hole would fill in. Take the
    // nearest corner in sight without that, else the nearest in sight.
    const clean = (i: number) =>
      !inLine(ring, i, mx, mz) &&
      !inLine(hole, m, ring[i]!, ring[i + 1]!) &&
      ring.filter((v, k) => k % 2 === 0 && v === ring[i] && ring[k + 1] === ring[i + 1]).length ===
        1;
    let [at, seen] = [-1, 0];
    for (const i of order) {
      if (blocked(mx, mz, ring[i]!, ring[i + 1]!, others)) continue;
      const ok = clean(i);
      if (at < 0 || ok) at = i;
      if (ok || ++seen >= MAX_CUTS) break;
    }
    if (at < 0) at = order[0]!;
    const loop = [...hole.slice(m), ...hole.slice(0, m), mx, mz];
    ring = [...ring.slice(0, at + 2), ...loop, ...ring.slice(at)];
  }
  return ring;
}
