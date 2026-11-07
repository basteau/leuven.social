/**
 * The compact binary city format ("LVN1"), served gzipped from public/data/.
 *
 * Layout: magic "LVN1", version, area rectangles, buildings, carriageways, markings, eleven polygon
 * layers (roads, plazas, green, water, platforms, railway land, platform roofs, woods, pitches,
 * car parks, bridge decks), pitch surfaces and fields, paths, rails, trees, props, tanks, parapets,
 * street names, church towers.
 * Coordinates are decimetres, zigzag varints, delta-encoded within each ring. A ring starts from
 * where the ring before it in the same list started (the first from 0, 0): the bake writes
 * neighbours next to each other, so the jump is short.
 * A building is its id (zigzag, the change from the building before), then tier (2 bits), kind
 * (3 bits) and roof (3 bits) packed into one byte, then its height, roof rise and roof colour
 * (0 = none, else 0xRRGGBB + 1), outer ring and courtyards.
 * Carriageways are a byte each (their kind in CARRIAGEWAY_KINDS in the low three bits, their
 * surface in SURFACES above it, v21) and a ring; markings a kind byte and a line.
 * Pitch surfaces (v18) follow the polygon layers, a byte per pitch ring in the order of the
 * pitches, then the fields painted on them: a sport byte, centre (zigzag decimetres), the long
 * side's direction (4096ths of half a turn), length and width (decimetres) and a count byte.
 * Paths are a width in decimetres shifted left three bits over their surface, then a centre line.
 * Rails are their kind shifted left two bits over an electrified and a bridge flag, then a
 * centre line: the gauge is standard everywhere, so a track needs no more.
 * Trees are a ring of positions followed by their heights in decimetres.
 * Props are a kind per prop, then their positions as one ring, then a turn (a byte: 256ths of a
 * full turn) and a size in decimetres each; a monument (v14) adds its plinth's width and depth
 * (decimetres) and its material (a byte), and a bike rack (v16) how full it is (a byte: 255ths of
 * its stands, which the bake picks by where it stands).
 * Tanks are a height in decimetres and a footprint each; parapets are open lines.
 * Street names are a table of strings, then each street as its name's place in the table and a
 * centre line, then one number per plaza: 0 for none, else its name's place plus one.
 * Church towers (v13) come next, as few as there are churches with one: each is its building's
 * place in the list (the change from the tower before), its centre (zigzag decimetres), radius,
 * wall top and tip (decimetres). The decoder hangs each on its building as `tower`.
 * The terrain (v15) comes next: its grid step (decimetres), its first node in whole steps
 * from the origin (zigzag), columns and rows, then each height in 5 cm as its difference from the
 * plane through its neighbours to the west, north and north-west (zigzag): the land is smooth,
 * so most of those take a byte.
 * Shop fronts (v17) follow, by building: each is its building's place in the list (the change
 * from the front before), the edge of its ring it is on, how far along it (decimetres), and its
 * kind's place in SHOP_KINDS with the top bit set for a terrace. A building's first front is its
 * main one: the decoder hangs it on the building as `front`. They come last (v24: the ways
 * the traffic moved along, v19 to v23, went with the traffic).
 */

import * as Binary from '@portable/binary';
import * as Compress from '@portable/compress';

import {
  CARRIAGEWAY_KINDS,
  KINDS,
  MARKING_KINDS,
  MATERIALS,
  PROP_KINDS,
  RAIL_KINDS,
  ROOFS,
  SURFACES,
  TIERS,
  isMonument,
} from './city.ts';
import type {
  Bounds,
  Building,
  Carriageway,
  City,
  Marking,
  Prop,
  Rail,
  ShopFront,
  TerrainGrid,
} from './city.ts';
import { boundsOf } from './geometry.ts';
import { FIELD_SPORTS, PITCH_SURFACES } from './pitches.ts';
import type { Field } from './pitches.ts';
import { SHOP_KINDS } from './shop-kinds.ts';

const MAGIC = 'LVN1';
// v16: a byte per bike rack, its fill (`Prop.fill`). v17: the shop fronts. v18: pitch surfaces
// and the fields painted on them, after the polygon layers. Bump the cache in public/sw.js with it.
const VERSION = 24;
const DM = 10; // units per metre
const GROUND = 20; // terrain heights per metre: 5 cm
const ZIGZAG = { encoding: 'zigzag' } as const;
const TURN = Math.PI * 2;
/** A field's direction in 4096ths of half a turn: 4 cm off at the end of a 100 m pitch. */
const FIELD_ANGLES = 4096;
/** Refuse anything larger after decompression: the whole city must stay small. */
export const MAX_CITY_BYTES = 16_000_000;

type Rings = Float32Array[];

export class CityFormatError extends Error {
  override name = 'CityFormatError';
}

/** Where the previous ring in a list started, in decimetres: the next one starts from there. */
interface Origin {
  x: number;
  z: number;
}
const origin = (): Origin => ({ x: 0, z: 0 });

function writeRing(w: Binary.Writer, ring: ArrayLike<number>, from = origin()): void {
  w.varint(ring.length / 2);
  let px = from.x;
  let pz = from.z;
  for (let i = 0; i < ring.length; i += 2) {
    const x = Math.round(ring[i]! * DM);
    const z = Math.round(ring[i + 1]! * DM);
    w.varint(x - px, ZIGZAG);
    w.varint(z - pz, ZIGZAG);
    if (i === 0) [from.x, from.z] = [x, z];
    px = x;
    pz = z;
  }
}

function readRing(r: Binary.Reader, from = origin()): Float32Array {
  const n = r.varint();
  const ring = new Float32Array(n * 2);
  let x = from.x;
  let z = from.z;
  for (let i = 0; i < n * 2; i += 2) {
    x += r.varint(ZIGZAG);
    z += r.varint(ZIGZAG);
    if (i === 0) [from.x, from.z] = [x, z];
    ring[i] = x / DM;
    ring[i + 1] = z / DM;
  }
  return ring;
}

/** A height's guess from the ones before it: west + north - north-west, or along the edges. */
function guess(q: Int32Array, k: number, i: number, j: number, cols: number): number {
  if (i > 0 && j > 0) return q[k - 1]! + q[k - cols]! - q[k - cols - 1]!;
  return i > 0 ? q[k - 1]! : j > 0 ? q[k - cols]! : 0;
}

function writeTerrain(w: Binary.Writer, t: TerrainGrid): void {
  w.varint(Math.round(t.step * DM));
  w.varint(Math.round(t.minX / t.step), ZIGZAG);
  w.varint(Math.round(t.minZ / t.step), ZIGZAG);
  w.varint(t.cols);
  w.varint(t.rows);
  const q = Int32Array.from(t.heights, (h) => Math.round(h * GROUND));
  for (let k = 0; k < q.length; k++) {
    w.varint(q[k]! - guess(q, k, k % t.cols, Math.floor(k / t.cols), t.cols), ZIGZAG);
  }
}

function readTerrain(r: Binary.Reader): TerrainGrid {
  const step = r.varint() / DM;
  const [minX, minZ] = [r.varint(ZIGZAG) * step, r.varint(ZIGZAG) * step];
  const [cols, rows] = [r.varint(), r.varint()];
  // Every height takes at least a byte: a grid larger than what's left is a broken file.
  if (step <= 0 || cols < 2 || rows < 2 || cols * rows > r.remaining) {
    throw new CityFormatError(`Bad terrain grid ${cols} × ${rows}.`);
  }
  const q = new Int32Array(cols * rows);
  for (let k = 0; k < q.length; k++) {
    q[k] = r.varint(ZIGZAG) + guess(q, k, k % cols, Math.floor(k / cols), cols);
  }
  return { step, minX, minZ, cols, rows, heights: Float32Array.from(q, (v) => v / GROUND) };
}

// Shop fronts (v17): a section of their own, after the terrain.
const TERRACE_BIT = 0x80;

function writeFronts(w: Binary.Writer, fronts: readonly ShopFront[]): void {
  w.varint(fronts.length);
  let place = 0;
  for (const f of fronts) {
    w.varint(f.building - place);
    place = f.building;
    w.varint(f.edge);
    w.varint(Math.round(f.along * DM));
    w.uint8(SHOP_KINDS.indexOf(f.kind) | (f.terrace ? TERRACE_BIT : 0));
  }
}

/** Reads the fronts and hangs each building's first, its main one, on it as `front`. */
function readFronts(r: Binary.Reader, buildings: Building[]): ShopFront[] {
  let place = 0;
  return Array.from({ length: r.varint() }, (): ShopFront => {
    const building = (place += r.varint());
    const [edge, along, packed] = [r.varint(), r.varint() / DM, r.uint8()];
    const b = buildings[building];
    const kind = SHOP_KINDS[packed & ~TERRACE_BIT];
    if (!b || !kind || edge * 2 >= b.ring.length) {
      throw new CityFormatError(`Bad shop front on building ${building}.`);
    }
    const front = { building, edge, along, kind, terrace: (packed & TERRACE_BIT) !== 0 };
    b.front ??= front;
    return front;
  });
}

function writeString(w: Binary.Writer, text: string): void {
  w.varint(Binary.utf8Length(text));
  w.string(text);
}

export function encodeCity(city: City): Uint8Array {
  const w = Binary.createWriter();
  w.string(MAGIC);
  w.varint(VERSION);
  w.varint(city.area.length);
  for (const { minX, minZ, maxX, maxZ } of city.area) {
    for (const v of [minX, minZ, maxX, maxZ]) w.varint(Math.round(v * DM), ZIGZAG);
  }

  w.varint(city.buildings.length);
  let id = 0;
  let at = origin();
  for (const b of city.buildings) {
    w.varint(b.id - id, ZIGZAG);
    id = b.id;
    w.uint8(TIERS.indexOf(b.tier) | (KINDS.indexOf(b.kind) << 2) | (ROOFS.indexOf(b.roof) << 5));
    const height = Math.round(b.height * DM);
    w.varint(height);
    w.varint(Math.max(0, height - Math.round(b.eave * DM)));
    w.varint(b.roofColor === null ? 0 : b.roofColor + 1);
    writeRing(w, b.ring, at);
    w.varint(b.holes.length);
    const holes = { ...at };
    for (const hole of b.holes) writeRing(w, hole, holes);
  }

  w.varint(city.carriageways.length);
  at = origin();
  for (const { kind, surface, ring } of city.carriageways) {
    w.uint8(CARRIAGEWAY_KINDS.indexOf(kind) | (SURFACES.indexOf(surface) << 3));
    writeRing(w, ring, at);
  }
  w.varint(city.markings.length);
  at = origin();
  for (const marking of city.markings) {
    w.uint8(MARKING_KINDS.indexOf(marking.kind));
    writeRing(w, marking.line, at);
  }

  const layers = [
    city.roads,
    city.plazas,
    city.green,
    city.water,
    city.platforms,
    city.railLand,
    city.canopies,
    city.woods,
    city.pitches,
    city.parking,
    city.bridges,
  ];
  for (const layer of layers) {
    w.varint(layer.length);
    at = origin();
    for (const ring of layer) writeRing(w, ring, at);
  }
  for (const surface of city.pitchSurfaces) w.uint8(PITCH_SURFACES.indexOf(surface));
  w.varint(city.fields.length);
  for (const f of city.fields) {
    w.uint8(FIELD_SPORTS.indexOf(f.sport));
    w.varint(Math.round(f.x * DM), ZIGZAG);
    w.varint(Math.round(f.z * DM), ZIGZAG);
    w.varint(Math.round((f.angle / Math.PI) * FIELD_ANGLES) % FIELD_ANGLES);
    w.varint(Math.round(f.length * DM));
    w.varint(Math.round(f.width * DM));
    w.uint8(f.count);
  }

  w.varint(city.paths.length);
  at = origin();
  for (const p of city.paths) {
    w.varint((Math.round(p.width * DM) << 3) | SURFACES.indexOf(p.surface));
    writeRing(w, p.line, at);
  }

  w.varint(city.rails.length);
  at = origin();
  for (const rail of city.rails) {
    w.varint(
      (RAIL_KINDS.indexOf(rail.kind) << 2) | (rail.electrified ? 2 : 0) | (rail.bridge ? 1 : 0),
    );
    writeRing(w, rail.line, at);
  }

  writeRing(w, city.trees);
  for (const h of city.treeHeights) w.varint(Math.round(h * DM));

  w.varint(city.props.length);
  for (const p of city.props) w.uint8(PROP_KINDS.indexOf(p.kind));
  writeRing(
    w,
    city.props.flatMap((p) => [p.x, p.z]),
  );
  for (const p of city.props) {
    w.uint8(Math.round((p.angle / TURN) * 256) & 255);
    w.varint(Math.round(p.size * DM));
    if (p.kind === 'bikes') w.uint8(Math.round(Math.min(Math.max(p.fill ?? 0, 0), 1) * 255));
    if (!isMonument(p.kind)) continue;
    w.varint(Math.round((p.width ?? 0) * DM));
    w.varint(Math.round((p.depth ?? 0) * DM));
    w.uint8(MATERIALS.indexOf(p.material ?? 'bronze'));
  }

  w.varint(city.tanks.length);
  at = origin();
  for (const t of city.tanks) {
    w.varint(Math.round(t.height * DM));
    writeRing(w, t.ring, at);
  }
  w.varint(city.parapets.length);
  at = origin();
  for (const line of city.parapets) writeRing(w, line, at);

  w.varint(city.streetNames.length);
  for (const name of city.streetNames) writeString(w, name);
  w.varint(city.streets.length);
  at = origin();
  for (const street of city.streets) {
    w.varint(street.name);
    writeRing(w, street.line, at);
  }
  for (const name of city.plazaNames) w.varint(name + 1);

  const towers = city.buildings.flatMap((b, i) => (b.tower ? [{ i, ...b.tower }] : []));
  w.varint(towers.length);
  let place = 0;
  for (const t of towers) {
    w.varint(t.i - place);
    place = t.i;
    w.varint(Math.round(t.x * DM), ZIGZAG);
    w.varint(Math.round(t.z * DM), ZIGZAG);
    for (const v of [t.radius, t.top, t.tip]) w.varint(Math.round(v * DM));
  }
  writeTerrain(w, city.terrain);
  writeFronts(w, city.fronts);
  return w.toBytes();
}

export function decodeCity(bytes: Uint8Array): City {
  const r = Binary.createReader(bytes);
  if (bytes.length < 4 || r.string(4) !== MAGIC) throw new CityFormatError('Not a city file.');
  const version = r.varint();
  if (version !== VERSION) throw new CityFormatError(`Unsupported city format v${version}.`);
  const area = Array.from({ length: r.varint() }, (): Bounds => {
    const [minX, minZ, maxX, maxZ] = [0, 0, 0, 0].map(() => r.varint(ZIGZAG) / DM) as [
      number,
      number,
      number,
      number,
    ];
    return { minX, minZ, maxX, maxZ };
  });
  if (area.length === 0) throw new CityFormatError('The city covers no area.');

  let previous = 0;
  let at = origin();
  const buildings = Array.from({ length: r.varint() }, (): Building => {
    const id = (previous += r.varint(ZIGZAG));
    const packed = r.uint8();
    const tier = TIERS[packed & 0b11];
    const kind = KINDS[(packed >> 2) & 0b111];
    const roof = ROOFS[packed >> 5];
    if (!tier || !kind || !roof) throw new CityFormatError(`Bad building flags ${packed}.`);
    const height = r.varint();
    const eave = (height - r.varint()) / DM;
    const color = r.varint();
    const ring = readRing(r, at);
    const from = { ...at };
    const holes = Array.from({ length: r.varint() }, () => readRing(r, from));
    return {
      id,
      tier,
      kind,
      roof,
      height: height / DM,
      eave,
      roofColor: color === 0 ? null : color - 1,
      ring,
      holes,
    };
  });

  /** A list of rings, each starting from the one before. */
  const list = <T>(read: (from: Origin) => T): T[] => {
    const from = origin();
    return Array.from({ length: r.varint() }, () => read(from));
  };
  const carriageways = list((from): Carriageway => {
    const byte = r.uint8();
    const [kind, surface] = [CARRIAGEWAY_KINDS[byte & 7], SURFACES[byte >> 3]];
    if (!kind || !surface) throw new CityFormatError('Bad carriageway kind.');
    return { kind, surface, ring: readRing(r, from) };
  });
  const markings = list((from): Marking => {
    const kind = MARKING_KINDS[r.uint8()];
    if (!kind) throw new CityFormatError('Bad marking kind.');
    return { kind, line: readRing(r, from) };
  });
  const [
    roads,
    plazas,
    green,
    water,
    platforms,
    railLand,
    canopies,
    woods,
    pitches,
    parking,
    bridges,
  ] = Array.from({ length: 11 }, () => list((from) => readRing(r, from))) as [
    Rings,
    Rings,
    Rings,
    Rings,
    Rings,
    Rings,
    Rings,
    Rings,
    Rings,
    Rings,
    Rings,
  ];
  const pitchSurfaces = pitches.map(() => {
    const surface = PITCH_SURFACES[r.uint8()];
    if (!surface) throw new CityFormatError('Bad pitch surface.');
    return surface;
  });
  const fields = Array.from({ length: r.varint() }, (): Field => {
    const sport = FIELD_SPORTS[r.uint8()];
    if (!sport) throw new CityFormatError('Bad field sport.');
    const [x, z] = [r.varint(ZIGZAG) / DM, r.varint(ZIGZAG) / DM];
    const angle = (r.varint() / FIELD_ANGLES) * Math.PI;
    const [length, width] = [r.varint() / DM, r.varint() / DM];
    return { sport, x, z, angle, length, width, count: r.uint8() };
  });

  const paths = list((from) => {
    const packed = r.varint();
    const surface = SURFACES[packed & 7];
    if (!surface) throw new CityFormatError('Bad path surface.');
    return { width: (packed >> 3) / DM, surface, line: readRing(r, from) };
  });

  const rails = list((from): Rail => {
    const packed = r.varint();
    const kind = RAIL_KINDS[packed >> 2];
    if (!kind) throw new CityFormatError(`Bad rail flags ${packed}.`);
    return {
      kind,
      bridge: (packed & 1) === 1,
      electrified: (packed & 2) === 2,
      line: readRing(r, from),
    };
  });

  const trees = readRing(r);
  const treeHeights = Float32Array.from({ length: trees.length / 2 }, () => r.varint() / DM);

  const kinds = Array.from({ length: r.varint() }, () => {
    const kind = PROP_KINDS[r.uint8()];
    if (!kind) throw new CityFormatError('Bad prop kind.');
    return kind;
  });
  const places = readRing(r);
  const props = kinds.map((kind, i): Prop => {
    const prop: Prop = {
      kind,
      x: places[i * 2]!,
      z: places[i * 2 + 1]!,
      angle: (r.uint8() / 256) * TURN,
      size: r.varint() / DM,
    };
    if (kind === 'bikes') prop.fill = r.uint8() / 255;
    if (!isMonument(kind)) return prop;
    const [width, depth, material] = [r.varint() / DM, r.varint() / DM, MATERIALS[r.uint8()]];
    if (!material) throw new CityFormatError('Bad monument material.');
    return Object.assign(prop, { width, depth, material });
  });
  const tanks = list((from) => ({ height: r.varint() / DM, ring: readRing(r, from) }));
  const parapets = list((from) => readRing(r, from));

  const streetNames = Array.from({ length: r.varint() }, () => r.string(r.varint()));
  const streets = list((from) => {
    const name = r.varint();
    if (name >= streetNames.length) throw new CityFormatError(`Bad street name ${name}.`);
    return { name, line: readRing(r, from) };
  });
  const plazaNames = plazas.map(() => {
    const name = r.varint() - 1;
    if (name >= streetNames.length) throw new CityFormatError(`Bad square name ${name}.`);
    return name;
  });
  let place = 0;
  for (let n = r.varint(); n > 0; n--) {
    const b = buildings[(place += r.varint())];
    if (!b) throw new CityFormatError(`Bad tower building ${place}.`);
    const [x, z] = [r.varint(ZIGZAG) / DM, r.varint(ZIGZAG) / DM];
    const [radius, top, tip] = [r.varint() / DM, r.varint() / DM, r.varint() / DM];
    b.tower = { x, z, radius, top, tip };
  }
  const terrain = readTerrain(r);
  const fronts = readFronts(r, buildings);
  if (r.remaining !== 0) throw new CityFormatError(`${r.remaining} trailing bytes.`);
  return {
    area,
    bounds: boundsOf(area),
    buildings,
    roads,
    carriageways,
    markings,
    plazas,
    green,
    water,
    woods,
    pitches,
    pitchSurfaces,
    fields,
    parking,
    paths,
    rails,
    platforms,
    railLand,
    canopies,
    trees,
    treeHeights,
    props,
    tanks,
    bridges,
    parapets,
    streetNames,
    streets,
    plazaNames,
    terrain,
    fronts,
  };
}

export async function packCity(city: City): Promise<Uint8Array> {
  return Compress.encode(encodeCity(city));
}

/** Accepts gzipped or plain bytes: some servers already inflate .gz responses. */
export async function unpackCity(bytes: Uint8Array, signal?: AbortSignal): Promise<City> {
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const raw = gzipped
    ? await Compress.decode(bytes, { maxBytes: MAX_CITY_BYTES, ...(signal && { signal }) })
    : bytes;
  return decodeCity(raw);
}
