/**
 * The compact binary city format ("LVN1"), served gzipped from public/data/.
 *
 * Layout: magic "LVN1", version, area rectangles, labels, buildings, four polygon layers, paths,
 * trees.
 * Coordinates are decimetres, zigzag varints, delta-encoded within each ring.
 * A building packs tier (2 bits), kind (4 bits) and roof (2 bits) into one byte, then its
 * height, roof rise and roof colour (0 = none, else 0xRRGGBB + 1), outer ring and courtyards.
 * Paths are a width in decimetres shifted left one bit over a paved flag, then a centre line.
 * Trees are a ring of positions followed by their heights in decimetres.
 * Props are a kind per prop, then their positions as one ring, then a turn (a byte: 256ths of a
 * full turn) and a size in decimetres each.
 * Tanks are a height in decimetres and a footprint each; parapets are open lines.
 */

import * as Binary from '@portable/binary';
import * as Compress from '@portable/compress';

import { KINDS, PROP_KINDS, ROOFS, TIERS } from './city.ts';
import type { Bounds, Building, City, Prop } from './city.ts';
import { boundsOf } from './geometry.ts';

const MAGIC = 'LVN1';
const VERSION = 6;
const DM = 10; // units per metre
const ZIGZAG = { encoding: 'zigzag' } as const;
const TURN = Math.PI * 2;
/** Refuse anything larger after decompression: the whole city must stay small. */
export const MAX_CITY_BYTES = 16_000_000;

export class CityFormatError extends Error {
  override name = 'CityFormatError';
}

function writeRing(w: Binary.Writer, ring: ArrayLike<number>): void {
  w.varint(ring.length / 2);
  let px = 0;
  let pz = 0;
  for (let i = 0; i < ring.length; i += 2) {
    const x = Math.round(ring[i]! * DM);
    const z = Math.round(ring[i + 1]! * DM);
    w.varint(x - px, ZIGZAG);
    w.varint(z - pz, ZIGZAG);
    px = x;
    pz = z;
  }
}

function readRing(r: Binary.Reader): Float32Array {
  const n = r.varint();
  const ring = new Float32Array(n * 2);
  let x = 0;
  let z = 0;
  for (let i = 0; i < n * 2; i += 2) {
    x += r.varint(ZIGZAG);
    z += r.varint(ZIGZAG);
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

  w.varint(city.labels.length);
  for (const label of city.labels) {
    writeString(w, label.name);
    w.varint(Math.round(label.x * DM), ZIGZAG);
    w.varint(Math.round(label.z * DM), ZIGZAG);
  }

  w.varint(city.buildings.length);
  for (const b of city.buildings) {
    w.varint(b.id);
    w.uint8(TIERS.indexOf(b.tier) | (KINDS.indexOf(b.kind) << 2) | (ROOFS.indexOf(b.roof) << 6));
    const height = Math.round(b.height * DM);
    w.varint(height);
    w.varint(Math.max(0, height - Math.round(b.eave * DM)));
    w.varint(b.roofColor === null ? 0 : b.roofColor + 1);
    writeRing(w, b.ring);
    w.varint(b.holes.length);
    for (const hole of b.holes) writeRing(w, hole);
  }

  for (const layer of [city.roads, city.plazas, city.green, city.water]) {
    w.varint(layer.length);
    for (const ring of layer) writeRing(w, ring);
  }

  w.varint(city.paths.length);
  for (const p of city.paths) {
    w.varint((Math.round(p.width * DM) << 1) | (p.paved ? 1 : 0));
    writeRing(w, p.line);
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
  for (const t of city.tanks) {
    w.varint(Math.round(t.height * DM));
    writeRing(w, t.ring);
  }
  w.varint(city.parapets.length);
  for (const line of city.parapets) writeRing(w, line);
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

  const labels = Array.from({ length: r.varint() }, () => {
    const name = r.string(r.varint());
    return { name, x: r.varint(ZIGZAG) / DM, z: r.varint(ZIGZAG) / DM };
  });

  const buildings = Array.from({ length: r.varint() }, (): Building => {
    const id = r.varint();
    const packed = r.uint8();
    const tier = TIERS[packed & 0b11];
    const kind = KINDS[(packed >> 2) & 0b1111];
    const roof = ROOFS[packed >> 6];
    if (!tier || !kind || !roof) throw new CityFormatError(`Bad building flags ${packed}.`);
    const height = r.varint();
    const eave = (height - r.varint()) / DM;
    const color = r.varint();
    const ring = readRing(r);
    const holes = Array.from({ length: r.varint() }, () => readRing(r));
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

  const [roads, plazas, green, water] = [0, 1, 2, 3].map(() =>
    Array.from({ length: r.varint() }, () => readRing(r)),
  ) as [Float32Array[], Float32Array[], Float32Array[], Float32Array[]];

  const paths = Array.from({ length: r.varint() }, () => {
    const packed = r.varint();
    return { width: (packed >> 1) / DM, paved: (packed & 1) === 1, line: readRing(r) };
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
  const tanks = Array.from({ length: r.varint() }, () => ({
    height: r.varint() / DM,
    ring: readRing(r),
  }));
  const parapets = Array.from({ length: r.varint() }, () => readRing(r));
  if (r.remaining !== 0) throw new CityFormatError(`${r.remaining} trailing bytes.`);
  return {
    area,
    bounds: boundsOf(area),
    labels,
    buildings,
    roads,
    plazas,
    green,
    water,
    paths,
    trees,
    treeHeights,
    props,
    tanks,
    parapets,
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
