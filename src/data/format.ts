/**
 * The compact binary city format ("LVN1"), served gzipped from public/data/.
 *
 * Layout: magic "LVN1", version, area rectangles, labels, buildings, four polygon layers, trees.
 * Coordinates are decimetres, zigzag varints, delta-encoded within each ring.
 * A building packs tier (2 bits), kind (4 bits) and roof (2 bits) into one byte.
 */

import * as Binary from '@portable/binary';
import * as Compress from '@portable/compress';

import { KINDS, ROOFS, TIERS } from './city.ts';
import type { Bounds, Building, City } from './city.ts';
import { boundsOf } from './geometry.ts';

const MAGIC = 'LVN1';
const VERSION = 2;
const DM = 10; // units per metre
const ZIGZAG = { encoding: 'zigzag' } as const;
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
    w.varint(Math.round(b.height * DM));
    writeRing(w, b.ring);
  }

  for (const layer of [city.roads, city.plazas, city.green, city.water]) {
    w.varint(layer.length);
    for (const ring of layer) writeRing(w, ring);
  }

  writeRing(w, city.trees);
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
    return { id, tier, kind, roof, height: r.varint() / DM, ring: readRing(r) };
  });

  const [roads, plazas, green, water] = [0, 1, 2, 3].map(() =>
    Array.from({ length: r.varint() }, () => readRing(r)),
  ) as [Float32Array[], Float32Array[], Float32Array[], Float32Array[]];

  const trees = readRing(r);
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
    trees,
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
