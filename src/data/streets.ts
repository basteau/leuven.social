import type { City } from './city.ts';
import { pointInRing } from './geometry.ts';

/**
 * Street names for the street sign: OpenStreetMap's `name` on every road, path and square, read
 * by the bake and looked up here around the walker. Nothing is typed in by hand.
 */

type Tags = Record<string, string | undefined>;

/**
 * The name a road's sign shows, or null. Bus and tram platforms carry their stop's name, not a
 * street's, and a closed pedestrian area is a square, named as one (see `plazaNames`).
 */
export function streetName(tags: Tags): string | null {
  if (!tags.highway || tags.highway === 'platform' || tags.area === 'yes') return null;
  return tags.name?.trim() || null;
}

/**
 * A sorted table of distinct names, and each name's place in it (-1 for none): every street
 * then costs a small number instead of its name.
 */
export function nameTable(names: readonly (string | null)[]): { table: string[]; index: number[] } {
  const table = [...new Set(names.filter((n): n is string => n !== null))].toSorted();
  const at = new Map(table.map((name, i) => [name, i]));
  return { table, index: names.map((n) => (n === null ? -1 : at.get(n)!)) };
}

const endKey = (line: readonly number[], i: number) => `${line[i]},${line[i + 1]}`;

function reversed(line: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = line.length - 2; i >= 0; i -= 2) out.push(line[i]!, line[i + 1]!);
  return out;
}

/**
 * Chains open polylines that share an end point into longer ones, the way a street's OSM ways
 * meet at a node. Fewer, longer lines store each shared corner once. Order and direction of
 * the result follow the input's first line of each chain.
 */
export function joinLines(lines: readonly (readonly number[])[]): number[][] {
  const open = lines.filter((line) => line.length >= 4).map((line) => Array.from(line));
  /** Lines by each of their two end points; a line is removed from both once it's used. */
  const ends = new Map<string, Set<number>>();
  const add = (k: string, i: number) => {
    const set = ends.get(k);
    if (set) set.add(i);
    else ends.set(k, new Set([i]));
  };
  for (const [i, line] of open.entries()) {
    add(endKey(line, 0), i);
    add(endKey(line, line.length - 2), i);
  }
  const used = new Uint8Array(open.length);
  const take = (k: string): number | undefined => {
    for (const i of ends.get(k) ?? []) if (!used[i]) return i;
    return undefined;
  };
  const chains: number[][] = [];
  for (const [i, first] of open.entries()) {
    if (used[i]) continue;
    used[i] = 1;
    let chain = first;
    // Grow at the end, then turn it round and grow at the other end.
    for (let side = 0; side < 2; side++) {
      for (let k = endKey(chain, chain.length - 2), next = take(k); next !== undefined;) {
        used[next] = 1;
        const line = open[next]!;
        chain = chain.concat((endKey(line, 0) === k ? line : reversed(line)).slice(2));
        k = endKey(chain, chain.length - 2);
        next = take(k);
      }
      chain = reversed(chain);
    }
    chains.push(chain);
  }
  return chains;
}

/** How far from a street's centre line the walker still reads its name (m): its pavements. */
export const STREET_REACH = 20;
/**
 * At a corner, the street already on the sign stays there until another is this much closer
 * (m), so it doesn't flicker between the two while someone walks past.
 */
export const STREET_STICKINESS = 4;
/** Segments are bucketed in squares this big (m), so a lookup meets only the few nearby. */
const CELL = 32;

type StreetData = Pick<City, 'streetNames' | 'streets' | 'plazas' | 'plazaNames'>;

/** Squared distance from (x, z) to the segment from (ax, az) to (bx, bz). */
function segmentDistance2(
  x: number,
  z: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const length2 = dx * dx + dz * dz;
  const t = length2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / length2)) : 0;
  const ex = ax + t * dx - x;
  const ez = az + t * dz - z;
  return ex * ex + ez * ez;
}

/**
 * Finds the name of the street or square at a spot. Built once, the first time anyone asks;
 * each lookup then reads one or four buckets of segments and the few named squares nearby.
 */
export class StreetIndex {
  readonly #names: readonly string[];
  readonly #ids: ReadonlyMap<string, number>;
  /** Every segment as ax, az, bx, bz, and the name it belongs to. */
  readonly #segments: Float32Array;
  readonly #segmentNames: Int32Array;
  readonly #buckets = new Map<number, number[]>();
  readonly #squares: { name: number; ring: Float32Array; box: [number, number, number, number] }[];
  /** Nearest distance found to each name in the latest lookup; scratch, reused. */
  readonly #nearest: Float64Array;

  constructor(city: StreetData) {
    this.#names = city.streetNames;
    this.#ids = new Map(city.streetNames.map((name, i) => [name, i]));
    let count = 0;
    for (const { line } of city.streets) count += Math.max(0, line.length / 2 - 1);
    this.#segments = new Float32Array(count * 4);
    this.#segmentNames = new Int32Array(count);
    let s = 0;
    for (const { name, line } of city.streets) {
      for (let i = 0; i + 3 < line.length; i += 2, s++) {
        const [ax, az, bx, bz] = [line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!];
        this.#segments.set([ax, az, bx, bz], s * 4);
        this.#segmentNames[s] = name;
        for (let cx = cell(Math.min(ax, bx)); cx <= cell(Math.max(ax, bx)); cx++) {
          for (let cz = cell(Math.min(az, bz)); cz <= cell(Math.max(az, bz)); cz++) {
            const key = bucket(cx, cz);
            const list = this.#buckets.get(key);
            if (list) list.push(s);
            else this.#buckets.set(key, [s]);
          }
        }
      }
    }
    this.#squares = city.plazas.flatMap((ring, i) => {
      const name = city.plazaNames[i] ?? -1;
      if (name < 0) return [];
      const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
      for (let k = 0; k < ring.length; k += 2) {
        box[0] = Math.min(box[0], ring[k]!);
        box[1] = Math.min(box[1], ring[k + 1]!);
        box[2] = Math.max(box[2], ring[k]!);
        box[3] = Math.max(box[3], ring[k + 1]!);
      }
      return [{ name, ring, box }];
    });
    this.#nearest = new Float64Array(this.#names.length);
  }

  /**
   * The name to show at (x, z): the square it stands on, else the nearest street within reach,
   * else null. `current` is what the sign shows now; it stays while it's nearly as close.
   */
  nameAt(x: number, z: number, current: string | null = null): string | null {
    for (const { name, ring, box } of this.#squares) {
      if (x >= box[0] && x <= box[2] && z >= box[1] && z <= box[3] && pointInRing(ring, x, z)) {
        return this.#names[name]!;
      }
    }
    const nearest = this.#nearest;
    nearest.fill(Infinity);
    let best = -1;
    const reach2 = STREET_REACH * STREET_REACH;
    for (let cx = cell(x - STREET_REACH); cx <= cell(x + STREET_REACH); cx++) {
      for (let cz = cell(z - STREET_REACH); cz <= cell(z + STREET_REACH); cz++) {
        for (const s of this.#buckets.get(bucket(cx, cz)) ?? []) {
          const seg = this.#segments;
          const d2 = segmentDistance2(
            x,
            z,
            seg[s * 4]!,
            seg[s * 4 + 1]!,
            seg[s * 4 + 2]!,
            seg[s * 4 + 3]!,
          );
          if (d2 > reach2) continue;
          const name = this.#segmentNames[s]!;
          if (d2 < nearest[name]!) nearest[name] = d2;
          if (best < 0 || d2 < nearest[best]!) best = name;
        }
      }
    }
    if (best < 0) return null;
    const kept = current === null ? -1 : (this.#ids.get(current) ?? -1);
    if (kept >= 0 && Math.sqrt(nearest[kept]!) <= Math.sqrt(nearest[best]!) + STREET_STICKINESS) {
      return current;
    }
    return this.#names[best]!;
  }
}

const cell = (v: number) => Math.floor(v / CELL);
/** One number per bucket: the city spans a few kilometres, far less than 2¹⁶ cells a side. */
const bucket = (cx: number, cz: number) => (cx + 32768) * 65536 + (cz + 32768);
