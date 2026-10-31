/**
 * Routes across the walk grid: A* over its cells, kept to a window around both ends so a
 * click costs a few milliseconds, then pulled taut into a handful of straight legs.
 */

import { WALK_CELL } from './walkable.ts';
import type { WalkGrid } from './walkable.ts';

/** How far past the box around both ends a route may wander (m). */
const MARGIN = 60;
/** Largest window side, in cells: routes stay within what a view at walking zoom shows. */
const MAX_WINDOW = 480;
/** Extra cost of a step next to a wall or kerb, so routes keep off the facades. */
const EDGE_COST = 0.7;
/** How far a straight leg must stay clear of closed cells on either side (m). */
const CLEARANCE = 0.4;

const NEIGHBOURS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
] as const;

/** Reuses its buffers across searches: a route is asked for on every click. */
export class Router {
  readonly #grid: WalkGrid;
  #cost = new Float32Array(0);
  #parent = new Int32Array(0);
  #state = new Uint8Array(0); // 0 unseen, 1 open, 2 closed
  /** Grows as needed: most searches touch a small part of their window. */
  #heap = new Int32Array(1024);
  #heapKey = new Float32Array(1024);

  constructor(grid: WalkGrid) {
    this.#grid = grid;
  }

  /**
   * Waypoints [x0, z0, x1, z1, …] from one walkable point to another, starting and ending at
   * them exactly, or null when there is no way within reach.
   */
  route(fromX: number, fromZ: number, toX: number, toZ: number): Float32Array | null {
    const grid = this.#grid;
    const start = grid.cellAt(fromX, fromZ);
    const goal = grid.cellAt(toX, toZ);
    if (!grid.open(start) || !grid.open(goal)) return null;
    if (start === goal) return Float32Array.of(fromX, fromZ, toX, toZ);

    const pad = Math.ceil(MARGIN / WALK_CELL);
    const [sc, sr] = [start % grid.cols, Math.floor(start / grid.cols)];
    const [gc, gr] = [goal % grid.cols, Math.floor(goal / grid.cols)];
    const c0 = Math.max(0, Math.min(sc, gc) - pad);
    const r0 = Math.max(0, Math.min(sr, gr) - pad);
    const c1 = Math.min(grid.cols - 1, Math.max(sc, gc) + pad);
    const r1 = Math.min(grid.rows - 1, Math.max(sr, gr) + pad);
    const [w, h] = [c1 - c0 + 1, r1 - r0 + 1];
    if (w > MAX_WINDOW || h > MAX_WINDOW) return null;

    const size = w * h;
    if (this.#cost.length < size) {
      this.#cost = new Float32Array(size);
      this.#parent = new Int32Array(size);
      this.#state = new Uint8Array(size);
    }
    const cost = this.#cost;
    const parent = this.#parent;
    const state = this.#state;
    state.fill(0, 0, size);

    const local = (c: number, r: number) => (r - r0) * w + (c - c0);
    const guess = (c: number, r: number) => {
      const [dx, dy] = [Math.abs(c - gc), Math.abs(r - gr)];
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };
    const open = (c: number, r: number) => grid.open(r * grid.cols + c);
    const nearEdge = (c: number, r: number) =>
      !open(c + 1, r) || !open(c - 1, r) || !open(c, r + 1) || !open(c, r - 1);

    // A binary heap of local indices keyed by estimated total cost; stale entries are skipped.
    let heapSize = 0;
    const push = (node: number, key: number) => {
      if (heapSize === this.#heap.length) {
        const [heap, keys] = [new Int32Array(heapSize * 2), new Float32Array(heapSize * 2)];
        heap.set(this.#heap);
        keys.set(this.#heapKey);
        [this.#heap, this.#heapKey] = [heap, keys];
      }
      let i = heapSize++;
      while (i > 0) {
        const up = (i - 1) >> 1;
        if (this.#heapKey[up]! <= key) break;
        this.#heap[i] = this.#heap[up]!;
        this.#heapKey[i] = this.#heapKey[up]!;
        i = up;
      }
      this.#heap[i] = node;
      this.#heapKey[i] = key;
    };
    const pop = () => {
      if (heapSize === 0) return -1;
      const top = this.#heap[0]!;
      const node = this.#heap[--heapSize]!;
      const key = this.#heapKey[heapSize]!;
      let i = 0;
      for (;;) {
        let child = i * 2 + 1;
        if (child >= heapSize) break;
        if (child + 1 < heapSize && this.#heapKey[child + 1]! < this.#heapKey[child]!) child++;
        if (this.#heapKey[child]! >= key) break;
        this.#heap[i] = this.#heap[child]!;
        this.#heapKey[i] = this.#heapKey[child]!;
        i = child;
      }
      this.#heap[i] = node;
      this.#heapKey[i] = key;
      return top;
    };

    const s = local(sc, sr);
    cost[s] = 0;
    parent[s] = -1;
    state[s] = 1;
    push(s, guess(sc, sr));
    const g = local(gc, gr);
    for (let node = pop(); node !== -1; node = pop()) {
      if (state[node] === 2) continue;
      state[node] = 2;
      if (node === g) break;
      const c = (node % w) + c0;
      const r = Math.floor(node / w) + r0;
      for (const [dc, dr, step] of NEIGHBOURS) {
        const [nc, nr] = [c + dc, r + dr];
        if (nc < c0 || nc > c1 || nr < r0 || nr > r1 || !open(nc, nr)) continue;
        // No cutting corners between two closed cells.
        if (dc && dr && (!open(c + dc, r) || !open(c, r + dr))) continue;
        const next = local(nc, nr);
        if (state[next] === 2) continue;
        const total = cost[node]! + step * (nearEdge(nc, nr) ? 1 + EDGE_COST : 1);
        if (state[next] === 1 && total >= cost[next]!) continue;
        cost[next] = total;
        parent[next] = node;
        state[next] = 1;
        push(next, total + guess(nc, nr));
      }
    }
    if (state[g] !== 2) return null;

    const cells: number[] = [];
    for (let node = g; node !== -1; node = parent[node]!) {
      cells.push((Math.floor(node / w) + r0) * grid.cols + (node % w) + c0);
    }
    cells.reverse();
    const points = cells.map((cell) => grid.centre(cell));
    points[0] = [fromX, fromZ];
    points[points.length - 1] = [toX, toZ];
    return Float32Array.from(taut(grid, points).flat());
  }
}

/** Whether a straight walk from a to b stays on open cells, with room on both sides. */
export function clearLine(grid: WalkGrid, ax: number, az: number, bx: number, bz: number): boolean {
  const length = Math.hypot(bx - ax, bz - az);
  if (length === 0) return grid.walkable(ax, az);
  const [ux, uz] = [(bx - ax) / length, (bz - az) / length];
  const [px, pz] = [-uz * CLEARANCE, ux * CLEARANCE];
  const steps = Math.ceil(length / (WALK_CELL / 4));
  for (let i = 0; i <= steps; i++) {
    const [x, z] = [ax + ((bx - ax) * i) / steps, az + ((bz - az) * i) / steps];
    if (!grid.walkable(x, z) || !grid.walkable(x + px, z + pz) || !grid.walkable(x - px, z - pz))
      return false;
  }
  return true;
}

/** Keeps only the corners a straight line can't skip: string-pulling over the cell path. */
function taut(grid: WalkGrid, points: [number, number][]): [number, number][] {
  const kept = [points[0]!];
  let anchor = 0;
  while (anchor < points.length - 1) {
    // Neighbouring cells always connect, even in passages too narrow for the clearance.
    let next = anchor + 1;
    const [ax, az] = points[anchor]!;
    while (next + 1 < points.length) {
      const [bx, bz] = points[next + 1]!;
      if (!clearLine(grid, ax, az, bx, bz)) break;
      next++;
    }
    kept.push(points[next]!);
    anchor = next;
  }
  return kept;
}
