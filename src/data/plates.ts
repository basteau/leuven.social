/**
 * House-number and street-name plates on the facades, close to the street: where each hangs, which
 * way its wall faces and what it says. The bake places them (src/data/plate-placement.ts) and
 * writes them to their own file, `public/data/walk.bin`, which only a walk downloads.
 *
 * Layout ("LVW1", gzipped): magic, version, then
 * - the house numbers' texts as a table of strings, sorted;
 * - the house numbers: a count, their positions as one ring (decimetres, zigzag deltas, as in
 *   city.bin), then each one's place in the table and its wall's facing (a byte: 256ths of a turn);
 * - the street plates: a count, their positions as one ring, then each one's name (its place in
 *   `City.streetNames`) and facing;
 * - (v3) the shops' names, as a table of strings, sorted;
 * - (v3) the shops' name boards: a count, their positions as one ring, then each one's name (its
 *   place in that table), facing, width (decimetres, a byte) and kind (its place in SHOP_KINDS,
 *   the top bit set where its front has room for an awning).
 * Positions are the plate's face, a few centimetres proud of its wall (`PROUD`), so rounding to
 * decimetres never sinks it into the wall. How high a plate hangs is the renderer's to say, from
 * the windows of the house it is on (src/scene/plate-mesh.ts), so it isn't stored.
 */

import * as Binary from '@portable/binary';
import * as Compress from '@portable/compress';

import type { Board } from './boards.ts';
import { SHOP_KINDS } from './shop-kinds.ts';

const MAGIC = 'LVW1';
// v2: plates keep no height. v3: the shops' name boards.
const VERSION = 3;
const DM = 10;
const ZIGZAG = { encoding: 'zigzag' } as const;
/** A name board's kind byte has this bit set when its front has room for an awning. */
const ON_AWNING = 0x80;
const TURN = Math.PI * 2;
/** Refuse anything larger after decompression. */
export const MAX_WALK_BYTES = 4_000_000;
/**
 * How far in front of its wall a plate's stored point lies (m): more than rounding to decimetres
 * can move it back (3.5 cm along the normal at worst), so the plate stays out of the wall.
 */
export const PROUD = 0.06;
/**
 * Plates are drawn half again larger than life, a little more than the walker and the street
 * furniture (1.3×), so a number reads from the chase camera across the street on a phone: a
 * house number 20 cm tall (30 drawn), a street plate 30 cm tall (45 drawn).
 */
export const PLATE_SCALE = 1.5;
export const HOUSE_PLATE_HEIGHT = 0.2 * PLATE_SCALE;
export const STREET_PLATE_HEIGHT = 0.3 * PLATE_SCALE;

/** A house number on the wall that faces its street. */
export interface HousePlate {
  x: number;
  z: number;
  /** Which way its wall faces (radians from +x towards +z): its normal is (cos, sin). */
  angle: number;
  text: string;
}

/** A street's name plate, on a corner building where it meets another street. */
export interface StreetPlate {
  x: number;
  z: number;
  angle: number;
  /** Where its name is in `City.streetNames`. */
  name: number;
}

export interface WalkData {
  houses: HousePlate[];
  streets: StreetPlate[];
  boards: Board[];
}

export class WalkFormatError extends Error {
  override name = 'WalkFormatError';
}

const turn = (angle: number) => Math.round((angle / TURN) * 256) & 255;

function writePoints(w: Binary.Writer, points: readonly { x: number; z: number }[]): void {
  let [px, pz] = [0, 0];
  for (const { x, z } of points) {
    const [qx, qz] = [Math.round(x * DM), Math.round(z * DM)];
    w.varint(qx - px, ZIGZAG);
    w.varint(qz - pz, ZIGZAG);
    [px, pz] = [qx, qz];
  }
}

function readPoints(r: Binary.Reader, n: number): Float32Array {
  const points = new Float32Array(n * 2);
  let [x, z] = [0, 0];
  for (let i = 0; i < n * 2; i += 2) {
    x += r.varint(ZIGZAG);
    z += r.varint(ZIGZAG);
    points[i] = x / DM;
    points[i + 1] = z / DM;
  }
  return points;
}

/** Natural order: 2 before 10, 10 before 10A. Plain comparisons, so it is the same everywhere. */
export function compareNumbers(a: string, b: string): number {
  const [na, nb] = [Number.parseInt(a, 10), Number.parseInt(b, 10)];
  const [ka, kb] = [Number.isNaN(na) ? Infinity : na, Number.isNaN(nb) ? Infinity : nb];
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function encodeWalk(data: WalkData): Uint8Array {
  const w = Binary.createWriter();
  w.string(MAGIC);
  w.varint(VERSION);
  const table = [...new Set(data.houses.map((h) => h.text))].toSorted(compareNumbers);
  const at = new Map(table.map((text, i) => [text, i]));
  w.varint(table.length);
  for (const text of table) {
    w.varint(Binary.utf8Length(text));
    w.string(text);
  }
  w.varint(data.houses.length);
  writePoints(w, data.houses);
  for (const h of data.houses) {
    w.varint(at.get(h.text)!);
    w.uint8(turn(h.angle));
  }
  w.varint(data.streets.length);
  writePoints(w, data.streets);
  for (const s of data.streets) {
    w.varint(s.name);
    w.uint8(turn(s.angle));
  }
  const names = [...new Set(data.boards.map((b) => b.name))].toSorted((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const named = new Map(names.map((name, i) => [name, i]));
  w.varint(names.length);
  for (const name of names) {
    w.varint(Binary.utf8Length(name));
    w.string(name);
  }
  w.varint(data.boards.length);
  writePoints(w, data.boards);
  for (const b of data.boards) {
    w.varint(named.get(b.name)!);
    w.uint8(turn(b.angle));
    w.uint8(Math.min(255, Math.round(b.width * DM)));
    w.uint8(SHOP_KINDS.indexOf(b.kind) | (b.awning ? ON_AWNING : 0));
  }
  return w.toBytes();
}

export function decodeWalk(bytes: Uint8Array): WalkData {
  const r = Binary.createReader(bytes);
  if (bytes.length < 4 || r.string(4) !== MAGIC) throw new WalkFormatError('Not a walk file.');
  const version = r.varint();
  if (version !== VERSION) throw new WalkFormatError(`Unsupported walk format v${version}.`);
  const table = Array.from({ length: r.varint() }, () => r.string(r.varint()));
  const count = r.varint();
  const places = readPoints(r, count);
  const houses = Array.from({ length: count }, (_, i): HousePlate => {
    const text = table[r.varint()];
    if (text === undefined) throw new WalkFormatError('Bad house number.');
    const angle = (r.uint8() / 256) * TURN;
    return { x: places[i * 2]!, z: places[i * 2 + 1]!, angle, text };
  });
  const plates = r.varint();
  const spots = readPoints(r, plates);
  const streets = Array.from({ length: plates }, (_, i): StreetPlate => {
    const name = r.varint();
    const angle = (r.uint8() / 256) * TURN;
    return { x: spots[i * 2]!, z: spots[i * 2 + 1]!, angle, name };
  });
  const names = Array.from({ length: r.varint() }, () => r.string(r.varint()));
  const fronts = r.varint();
  const at = readPoints(r, fronts);
  const boards = Array.from({ length: fronts }, (_, i): Board => {
    const name = names[r.varint()];
    const angle = (r.uint8() / 256) * TURN;
    const width = r.uint8() / DM;
    const packed = r.uint8();
    const kind = SHOP_KINDS[packed & (ON_AWNING - 1)];
    if (name === undefined || kind === undefined) throw new WalkFormatError('Bad name board.');
    const awning = (packed & ON_AWNING) !== 0;
    return { x: at[i * 2]!, z: at[i * 2 + 1]!, angle, width, awning, kind, name };
  });
  if (r.remaining !== 0) throw new WalkFormatError(`${r.remaining} trailing bytes.`);
  return { houses, streets, boards };
}

export async function packWalk(data: WalkData): Promise<Uint8Array> {
  return Compress.encode(encodeWalk(data));
}

/** Accepts gzipped or plain bytes: some servers already inflate .gz responses. */
export async function unpackWalk(bytes: Uint8Array): Promise<WalkData> {
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  return decodeWalk(gzipped ? await Compress.decode(bytes, { maxBytes: MAX_WALK_BYTES }) : bytes);
}

/** Plates are filed in squares this big (m), so finding those near the walker reads a few. */
const BUCKET = 32;
const key = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);

/** Plates of one kind filed by square once, for "which are within this far of here". */
export class PlateIndex {
  readonly #buckets = new Map<number, number[]>();
  readonly #points: Float32Array;

  constructor(plates: readonly { x: number; z: number }[]) {
    this.#points = new Float32Array(plates.length * 2);
    for (const [i, { x, z }] of plates.entries()) {
      this.#points[i * 2] = x;
      this.#points[i * 2 + 1] = z;
      const k = key(Math.floor(x / BUCKET), Math.floor(z / BUCKET));
      const list = this.#buckets.get(k);
      if (list) list.push(i);
      else this.#buckets.set(k, [i]);
    }
  }

  /** The plates within `reach` of (x, z), nearest first, at most `limit` of them. */
  near(x: number, z: number, reach: number, limit = Infinity): number[] {
    const found: { i: number; d: number }[] = [];
    const p = this.#points;
    for (let i = Math.floor((x - reach) / BUCKET); i <= Math.floor((x + reach) / BUCKET); i++) {
      for (let j = Math.floor((z - reach) / BUCKET); j <= Math.floor((z + reach) / BUCKET); j++) {
        for (const n of this.#buckets.get(key(i, j)) ?? []) {
          const d = Math.hypot(p[n * 2]! - x, p[n * 2 + 1]! - z);
          if (d <= reach) found.push({ i: n, d });
        }
      }
    }
    found.sort((a, b) => a.d - b.d || a.i - b.i);
    return found.slice(0, limit).map((f) => f.i);
  }
}

/** Squares the walker's position is snapped to: the plates near it are chosen again only on a new one. */
export const PLATE_BUCKET = 16;
/** Which square of PLATE_BUCKET metres (x, z) lies in, as one number. */
export const plateBucket = (x: number, z: number) =>
  key(Math.floor(x / PLATE_BUCKET), Math.floor(z / PLATE_BUCKET));
