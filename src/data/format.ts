/**
 * The compact binary city format ("LVN1"), served gzipped from public/data/.
 *
 * Layout: magic "LVN1", version, area rectangles, buildings, carriageways, markings, ten polygon
 * layers (roads, plazas, green, water, platforms, railway land, platform roofs, woods, pitches,
 * car parks), paths, rails, trees, props, tanks, parapets, street names.
 * Coordinates are decimetres, zigzag varints, delta-encoded within each ring. A ring starts from
 * where the ring before it in the same list started (the first from 0, 0): the bake writes
 * neighbours next to each other, so the jump is short.
 * A building is its id (zigzag, the change from the building before), then tier (2 bits), kind
 * (3 bits) and roof (3 bits) packed into one byte, then its height, roof rise and roof colour
 * (0 = none, else 0xRRGGBB + 1), outer ring and courtyards.
 * Carriageways and markings are a kind byte each, then a ring (markings: a line).
 * Paths are a width in decimetres shifted left one bit over a paved flag, then a centre line.
 * Rails are their kind shifted left two bits over an electrified and a bridge flag, then a
 * centre line: the gauge is standard everywhere, so a track needs no more.
 * Trees are a ring of positions followed by their heights in decimetres.
 * Props are a kind per prop, then their positions as one ring, then a turn (a byte: 256ths of a
 * full turn) and a size in decimetres each.
 * Tanks are a height in decimetres and a footprint each; parapets are open lines.
 * Street names are a table of strings, then each street as its name's place in the table and a
 * centre line, then one number per plaza: 0 for none, else its name's place plus one.
 */

import * as Binary from '@portable/binary';
import * as Compress from '@portable/compress';

import {
  CARRIAGEWAY_KINDS,
  KINDS,
  MARKING_KINDS,
  PROP_KINDS,
  RAIL_KINDS,
  ROOFS,
  TIERS,
} from './city.ts';
import type { Bounds, Building, Carriageway, City, Marking, Prop, Rail } from './city.ts';
import { boundsOf } from './geometry.ts';

const MAGIC = 'LVN1';
const VERSION = 13;
const DM = 10; // units per metre
const ZIGZAG = { encoding: 'zigzag' } as const;
const TURN = Math.PI * 2;
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
  for (const { kind, ring } of city.carriageways) {
    w.uint8(CARRIAGEWAY_KINDS.indexOf(kind));
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
  ];
  for (const layer of layers) {
    w.varint(layer.length);
    at = origin();
    for (const ring of layer) writeRing(w, ring, at);
  }

  w.varint(city.paths.length);
  at = origin();
  for (const p of city.paths) {
    w.varint((Math.round(p.width * DM) << 1) | (p.paved ? 1 : 0));
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
    const kind = CARRIAGEWAY_KINDS[r.uint8()];
    if (!kind) throw new CityFormatError('Bad carriageway kind.');
    return { kind, ring: readRing(r, from) };
  });
  const markings = list((from): Marking => {
    const kind = MARKING_KINDS[r.uint8()];
    if (!kind) throw new CityFormatError('Bad marking kind.');
    return { kind, line: readRing(r, from) };
  });
  const [roads, plazas, green, water, platforms, railLand, canopies, woods, pitches, parking] =
    Array.from({ length: 10 }, () => list((from) => readRing(r, from))) as [
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

  const paths = list((from) => {
    const packed = r.varint();
    return { width: (packed >> 1) / DM, paved: (packed & 1) === 1, line: readRing(r, from) };
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
  const props = kinds.map((kind, i): Prop => ({
    kind,
    x: places[i * 2]!,
    z: places[i * 2 + 1]!,
    angle: (r.uint8() / 256) * TURN,
    size: r.varint() / DM,
  }));
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
    parapets,
    streetNames,
    streets,
    plazaNames,
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
