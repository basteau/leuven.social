/**
 * Routes across the walk grid. When the straight line to the spot is clear, that is the route.
 * Otherwise an any-angle search (Lazy Theta*, kept to a window around both ends so even the
 * furthest click costs tens of milliseconds): a step of the grid can only go eight ways, so a
 * plain search bends where nothing makes it, and pulling such a path straight afterwards leaves
 * those bends in. Here each cell keeps as its parent the furthest one it can see, so a route only
 * turns where something is in the way.
 */

import { WALK_CELL } from './walkable.ts';
import type { LevelGrid, WalkGrid } from './walkable.ts';

/** What a route needs of a grid: the street's (WalkGrid) or a room's floor (RoomGrid). */
export type RouteGrid = Pick<
  WalkGrid,
  'cols' | 'rows' | 'cellAt' | 'centre' | 'open' | 'walkable' | 'nearest' | 'around'
> & {
  /** The level of decks and tunnels, and where it meets the ground, if the map has one. */
  upper?: LevelGrid | null;
  link?(cell: number): boolean;
};

/** The furthest one route goes (m), drawn whole; further off, the walk goes in legs. */
export const ROUTE_REACH = 625;
/** How far the open ground a tap means may lie from where it lands (m). */
export const TAP_REACH = 8;
/** How far past the box around both ends a route may wander (m). */
const MARGIN = 60;
/** Largest window side, in cells: the longest route, either end a little off, and the margins. */
const MAX_WINDOW = Math.ceil((ROUTE_REACH + 2 * TAP_REACH + 2 * MARGIN) / WALK_CELL);
/** Extra cost of a step next to a wall or kerb, so a way round keeps off the facades. */
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

/** Ground round a spot with no way out in this many cells is a pocket, told at once (4096 m²). */
const POCKET = 4096;
/** A window smaller than this (cells) is searched faster than it is checked for pockets. */
const POCKET_WORTH = 40_000;
/** How far a stretch of a route is checked in one go (cells, along and across). */
const LONGEST_SIGHT = 48;

const NO_CELLS: ReadonlySet<number> = new Set();
/** What moving from the ground to the level over it adds to a walk (m): nothing but a step. */
const LINK_COST = 0.5;

/** Reuses its buffers across searches: a route is asked for on every click. */
export class Router {
  readonly #grid: RouteGrid;
  #cost = new Float64Array(0); // whole doubles: a cost compared with itself must come out equal
  #parent = new Int32Array(0);
  #state = new Uint8Array(0); // 0 unseen, 1 open, 2 closed
  #edge = new Uint8Array(0); // 0 not asked yet, 1 clear of walls, 2 beside one, 3 closed
  #pocket = new Int32Array(POCKET);
  /** Grows as needed: most searches touch a small part of their window. */
  #heap = new Int32Array(1024);
  #heapKey = new Float32Array(1024);

  constructor(grid: RouteGrid) {
    this.#grid = grid;
  }

  /**
   * Waypoints [x0, z0, x1, z1, …] from one walkable point to another, starting and ending at
   * them exactly, or null when there is no way within reach. It goes round `avoid`, circles
   * [x, z, radius, …] that come and go (the bikes left about the city), closing the cells whose
   * centres they cover as solids do, unless a route starts or ends there.
   */
  route(
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
    avoid: ArrayLike<number> = [],
    fromLevel = 0,
    toLevel = 0,
  ): Float32Array | null {
    const grid = this.#grid;
    const upper = grid.upper ?? null;
    const on = (level: number, cell: number) =>
      level ? upper?.open(cell) === true : grid.open(cell);
    const start = grid.cellAt(fromX, fromZ);
    const goal = grid.cellAt(toX, toZ);
    if (!on(fromLevel, start) || !on(toLevel, goal)) return null;
    if (start === goal && fromLevel === toLevel) return Float32Array.of(fromX, fromZ, toX, toZ);
    const blocked = coveredCells(grid, avoid);
    blocked.delete(start);
    blocked.delete(goal);

    const pad = Math.ceil(MARGIN / WALK_CELL);
    const [sc, sr] = [start % grid.cols, Math.floor(start / grid.cols)];
    const [gc, gr] = [goal % grid.cols, Math.floor(goal / grid.cols)];
    const c0 = Math.max(0, Math.min(sc, gc) - pad);
    const r0 = Math.max(0, Math.min(sr, gr) - pad);
    const c1 = Math.min(grid.cols - 1, Math.max(sc, gc) + pad);
    const r1 = Math.min(grid.rows - 1, Math.max(sr, gr) + pad);
    const [w, h] = [c1 - c0 + 1, r1 - r0 + 1];
    if (w > MAX_WINDOW || h > MAX_WINDOW) return null;
    // Nothing in the way: no search can do better, and none should be asked to.
    if (fromLevel === toLevel) {
      const lane = fromLevel ? upper! : grid;
      if (clearLine(lane, fromX, fromZ, toX, toZ, fromLevel ? NO_CELLS : blocked)) {
        return Float32Array.of(fromX, fromZ, toX, toZ);
      }
    }

    const layer = w * h;
    const size = upper ? layer * 2 : layer;
    if (this.#cost.length < size) {
      this.#cost = new Float64Array(size);
      this.#parent = new Int32Array(size);
      this.#state = new Uint8Array(size);
      this.#edge = new Uint8Array(size);
    }
    const cost = this.#cost;
    const parent = this.#parent;
    const state = this.#state;
    const edge = this.#edge;
    state.fill(0, 0, size);
    edge.fill(0, 0, size);

    const local = (c: number, r: number) => (r - r0) * w + (c - c0);
    const guess = (c: number, r: number) => Math.sqrt((c - gc) ** 2 + (r - gr) ** 2);
    const open = (c: number, r: number, level: number) => {
      if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return false;
      const cell = r * grid.cols + c;
      return level ? upper?.open(cell) === true : grid.open(cell) && !blocked.has(cell);
    };
    /** What a cell is (`#edge`), looked at once: a search asks of the same cells again and again. */
    const kindOf = (c: number, r: number, level: number) => {
      const at = local(c, r) + level * layer;
      edge[at] ||= !open(c, r, level)
        ? 3
        : !open(c + 1, r, level) ||
            !open(c - 1, r, level) ||
            !open(c, r + 1, level) ||
            !open(c, r - 1, level)
          ? 2
          : 1;
      return edge[at]!;
    };

    /** Whether the ground round `from` is a small pocket, all of it searched, with `to` not in it. */
    const shutIn = (from: number, to: number) => {
      const stack = this.#pocket;
      let [top, seen] = [1, 1];
      stack[0] = from;
      state[from] = 1;
      const reach = (c: number, r: number, level: number) => {
        if (c < c0 || c > c1 || r < r0 || r > r1 || !open(c, r, level)) return;
        const next = local(c, r) + level * layer;
        if (state[next] === 1) return;
        state[next] = 1;
        seen++;
        if (top < POCKET) stack[top++] = next;
      };
      while (top > 0) {
        const node = stack[--top]!;
        if (node === to || seen >= POCKET) return false;
        const level = node >= layer ? 1 : 0;
        const here = node - level * layer;
        const [c, r] = [(here % w) + c0, Math.floor(here / w) + r0];
        reach(c + 1, r, level);
        reach(c - 1, r, level);
        reach(c, r + 1, level);
        reach(c, r - 1, level);
        if (upper && grid.link?.(r * grid.cols + c)) reach(c, r, level ? 0 : 1);
      }
      return state[to] !== 1;
    };

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

    const s = local(sc, sr) + fromLevel * layer;
    const g = local(gc, gr) + toLevel * layer;
    // A walled-in garden: looking all over the window for a way in would take the longest of all.
    if (layer > POCKET_WORTH && shutIn(g, s)) return null;
    state.fill(0, 0, size);
    cost[s] = 0;
    parent[s] = -1;
    state[s] = 1;
    push(s, guess(sc, sr));
    const levelOf = (node: number) => (node >= layer ? 1 : 0);
    const columnOf = (node: number) => ((node - levelOf(node) * layer) % w) + c0;
    const rowOf = (node: number) => Math.floor((node - levelOf(node) * layer) / w) + r0;
    /** Whether a cell, by its index in the window, is open and clear of walls. */
    const isClear = (at: number, c: number, r: number, level: number) =>
      (edge[at] || kindOf(c, r, level)) === 1;
    /** Whether a straight stretch between two cells crosses only clear ones. */
    const sees = (from: number, to: number) => {
      const level = levelOf(from);
      let [c, r] = [columnOf(from), rowOf(from)];
      const [tc, tr] = [columnOf(to), rowOf(to)];
      const [dc, dr] = [Math.abs(tc - c), Math.abs(tr - r)];
      const [stepC, stepR] = [tc > c ? 1 : -1, tr > r ? 1 : -1];
      const stepAcross = stepR * w;
      let at = from;
      // Which side of the line the next step is on, doubled to stay in whole numbers.
      let side = dc - dr;
      for (let left = dc + dr; left > 0; left--) {
        if (side > 0) {
          c += stepC;
          at += stepC;
          side -= 2 * dr;
        } else if (side < 0) {
          r += stepR;
          at += stepAcross;
          side += 2 * dc;
        } else {
          // Through a corner exactly: both cells beside it have to be clear.
          if (!isClear(at + stepC, c + stepC, r, level)) return false;
          if (!isClear(at + stepAcross, c, r + stepR, level)) return false;
          c += stepC;
          r += stepR;
          at += stepC + stepAcross;
          side += 2 * dc - 2 * dr;
          left--;
        }
        if (!isClear(at, c, r, level)) return false;
      }
      return true;
    };
    /** A step of the grid from (c, r) to a neighbour in the window, or Infinity if there's none. */
    const stepCost = (
      c: number,
      r: number,
      dc: number,
      dr: number,
      step: number,
      level: number,
    ) => {
      const kind = kindOf(c + dc, r + dr, level);
      if (kind === 3) return Infinity;
      // No cutting corners between two closed cells.
      if (dc && dr && (kindOf(c + dc, r, level) === 3 || kindOf(c, r + dr, level) === 3)) {
        return Infinity;
      }
      return kind === 2 ? step * (1 + EDGE_COST) : step;
    };
    const visit = (next: number, total: number, by: number, nc: number, nr: number) => {
      if (state[next] === 2) return;
      if (state[next] === 1 && total >= cost[next]!) return;
      cost[next] = total;
      parent[next] = by;
      state[next] = 1;
      push(next, total + guess(nc, nr));
    };
    for (let node = pop(); node !== -1; node = pop()) {
      if (state[node] === 2) continue;
      const level = levelOf(node);
      const c = columnOf(node);
      const r = rowOf(node);
      // Lazy: the parent was only assumed to be in sight. If it isn't, the best neighbour already
      // settled takes over, by plain steps of the grid.
      const assumed = parent[node]!;
      if (assumed !== -1 && levelOf(assumed) === level && !sees(assumed, node)) {
        let best = Infinity;
        for (const [dc, dr, step] of NEIGHBOURS) {
          const [nc, nr] = [c + dc, r + dr];
          if (nc < c0 || nc > c1 || nr < r0 || nr > r1) continue;
          const near = local(nc, nr) + level * layer;
          if (state[near] !== 2) continue;
          const total = cost[near]! + stepCost(nc, nr, -dc, -dr, step, level);
          if (total < best) {
            best = total;
            parent[node] = near;
          }
        }
        // Dearer than it was assumed to be: it waits its turn again, or a walk the long way round
        // could beat one that really is shorter.
        const dearer = best > cost[node]! + 1e-3;
        cost[node] = best;
        if (dearer) {
          push(node, best + guess(c, r));
          continue;
        }
      }
      state[node] = 2;
      if (node === g) break;
      const here = node - level * layer;
      // A stretch can't start on another level, or the stair between them would be skipped.
      const seen = parent[node]!;
      let from = seen !== -1 && levelOf(seen) === level ? seen : node;
      let [fc, fr] = [columnOf(from), rowOf(from)];
      // Too far to be worth checking: a new stretch starts here, and the pull joins them up.
      if (Math.abs(fc - c) + Math.abs(fr - r) > LONGEST_SIGHT) [from, fc, fr] = [node, c, r];
      // Between the ground and the level over it, where they meet: no way along it but this.
      if (upper && open(c, r, level ? 0 : 1) && grid.link?.(r * grid.cols + c)) {
        visit(here + (level ? 0 : layer), cost[node]! + LINK_COST, node, c, r);
      }
      for (const [dc, dr, step] of NEIGHBOURS) {
        const [nc, nr] = [c + dc, r + dr];
        if (nc < c0 || nc > c1 || nr < r0 || nr > r1) continue;
        if (stepCost(c, r, dc, dr, step, level) === Infinity) continue;
        visit(
          local(nc, nr) + level * layer,
          cost[from]! + Math.sqrt((nc - fc) ** 2 + (nr - fr) ** 2),
          from,
          nc,
          nr,
        );
      }
    }
    if (state[g] !== 2) return null;

    const steps: { cell: number; level: number }[] = [];
    for (let node = g; node !== -1; node = parent[node]!) {
      const level = node >= layer ? 1 : 0;
      const here = node - level * layer;
      steps.push({ cell: (Math.floor(here / w) + r0) * grid.cols + (here % w) + c0, level });
    }
    steps.reverse();
    // Pulled taut level by level: the only way between two is where they meet.
    const out: [number, number][] = [];
    for (let from = 0; from < steps.length;) {
      const level = steps[from]!.level;
      let to = from;
      while (to + 1 < steps.length && steps[to + 1]!.level === level) to++;
      const points = steps.slice(from, to + 1).map(({ cell }) => grid.centre(cell));
      // The search saw these from the middles of their cells: kept, in case the exact ends can't.
      const lone = points.length === 1;
      if (from === 0) points.splice(0, lone ? 1 : 0, [fromX, fromZ]);
      if (to === steps.length - 1)
        points.splice(points.length - (lone ? 1 : 0), lone ? 1 : 0, [toX, toZ]);
      const lane = level ? upper! : grid;
      const pulled = points.length > 1 ? taut(lane, points, level ? NO_CELLS : blocked) : points;
      // Each run starts on the cell the last one ended on, its one step between levels.
      const last = out.at(-1);
      out.push(
        ...(last && pulled[0]![0] === last[0] && pulled[0]![1] === last[1]
          ? pulled.slice(1)
          : pulled),
      );
      from = to + 1;
    }
    return Float32Array.from(out.flat());
  }
}

/** The cells whose centres circles [x, z, radius, …] cover. */
function coveredCells(grid: RouteGrid, circles: ArrayLike<number>): Set<number> {
  const cells = new Set<number>();
  for (let i = 0; i + 2 < circles.length; i += 3) {
    const [x, z, radius] = [circles[i]!, circles[i + 1]!, circles[i + 2]!];
    for (let cz = z - radius; cz <= z + radius + WALK_CELL; cz += WALK_CELL) {
      for (let cx = x - radius; cx <= x + radius + WALK_CELL; cx += WALK_CELL) {
        const cell = grid.cellAt(cx, cz);
        if (cell < 0) continue;
        const [mx, mz] = grid.centre(cell);
        if (Math.hypot(mx - x, mz - z) <= radius) cells.add(cell);
      }
    }
  }
  return cells;
}

/**
 * Whether a straight walk from a to b stays on open cells, with room on both sides, and off the
 * `blocked` ones.
 */
export function clearLine(
  grid: Pick<RouteGrid, 'walkable' | 'cellAt'>,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  blocked = NO_CELLS,
): boolean {
  const walkable = (x: number, z: number) => grid.walkable(x, z) && !blocked.has(grid.cellAt(x, z));
  const length = Math.hypot(bx - ax, bz - az);
  if (length === 0) return walkable(ax, az);
  const [ux, uz] = [(bx - ax) / length, (bz - az) / length];
  const [px, pz] = [-uz * CLEARANCE, ux * CLEARANCE];
  const steps = Math.ceil(length / (WALK_CELL / 4));
  for (let i = 0; i <= steps; i++) {
    const [x, z] = [ax + ((bx - ax) * i) / steps, az + ((bz - az) * i) / steps];
    if (!walkable(x, z) || !walkable(x + px, z + pz) || !walkable(x - px, z - pz)) return false;
  }
  return true;
}

/** From each point on, the furthest later one in a clear straight line. */
function pull(
  grid: Pick<RouteGrid, 'walkable' | 'cellAt'>,
  points: [number, number][],
  blocked: ReadonlySet<number>,
): [number, number][] {
  const kept = [points[0]!];
  let anchor = 0;
  while (anchor < points.length - 1) {
    // From the far end back: a line blocked halfway can still be clear to a point further on.
    // Neighbouring points always connect, even in passages too narrow for the clearance.
    let next = points.length - 1;
    const [ax, az] = points[anchor]!;
    while (next > anchor + 1 && !clearLine(grid, ax, az, ...points[next]!, blocked)) next--;
    kept.push(points[next]!);
    anchor = next;
  }
  return kept;
}

/** Keeps only the corners a straight line can't skip, whichever end they are looked at from. */
function taut(
  grid: Pick<RouteGrid, 'walkable' | 'cellAt'>,
  points: [number, number][],
  blocked: ReadonlySet<number>,
): [number, number][] {
  return pull(grid, pull(grid, points, blocked).toReversed(), blocked).toReversed();
}

/** The longest stretch one route is asked for (m): both ends and the margin fit its window. */
export const LEG = 300;
/**
 * How much of a leg to walk before planning the next. Where a leg ends is only a point toward the
 * spot, often up a side street: walking to it and turning back is a detour nobody would take, so
 * the next route sets off before it gets there.
 */
export const LEG_WALKED = 0.75;

/** The first `share` of a route, by distance along it. */
export function routeStart(route: Float32Array, share: number): Float32Array {
  let total = 0;
  for (let i = 0; i + 3 < route.length; i += 2) {
    total += Math.hypot(route[i + 2]! - route[i]!, route[i + 3]! - route[i + 1]!);
  }
  let left = total * share;
  const kept = [route[0]!, route[1]!];
  for (let i = 0; i + 3 < route.length; i += 2) {
    const [ax, az, bx, bz] = [route[i]!, route[i + 1]!, route[i + 2]!, route[i + 3]!];
    const length = Math.hypot(bx - ax, bz - az);
    if (left <= length && length > 0) {
      kept.push(ax + ((bx - ax) * left) / length, az + ((bz - az) * left) / length);
      break;
    }
    left -= length;
    kept.push(bx, bz);
  }
  return Float32Array.from(kept);
}

/** Which way off the straight line, and how far of a leg, each try sets out (the straight line first). */
const LEG_TURNS = [0, 25, -25, 50, -50, 80, -80];
const LEG_SHARES = [1, 0.6];

/**
 * Where to head for a spot, best first. Within a leg, the spot itself. Further, a point a leg's
 * length toward it, then the same to either side and at shorter stretches, for when that point
 * is over a river or the tracks; but within one route's reach the spot itself comes first, so
 * the whole way shows. Each is `[x, z, last]`. Pure, so a walk across town is just routes, one
 * after another.
 */
export function legsToward(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
): [number, number, boolean][] {
  const [dx, dz] = [toX - fromX, toZ - fromZ];
  const far = Math.hypot(dx, dz);
  const whole: [number, number, boolean] = [toX, toZ, true];
  if (far <= LEG) return [whole];
  const towards = Math.atan2(dz, dx);
  const legs = LEG_SHARES.flatMap((share) =>
    LEG_TURNS.map((turn): [number, number, boolean] => {
      const angle = towards + (turn * Math.PI) / 180;
      const length = LEG * share;
      return [fromX + Math.cos(angle) * length, fromZ + Math.sin(angle) * length, false];
    }),
  );
  return far <= ROUTE_REACH ? [whole, ...legs] : legs;
}
