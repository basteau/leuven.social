/**
 * Where a person can walk on one floor of a room: its slab, less its holes and furnishings, plus
 * the stairs that reach it and, on the ground floor, the threshold of its door. The same raster
 * as the street's walk grid (cell-grid.ts) at half a metre, and the same rules for bodies: walls
 * met as drawn (the room's walls, split at their gaps, the stairs' rails, the furnishings'
 * outlines), closed ground as a blended edge. Collide and slide and routes take it as they take
 * the street's.
 */

import { CellGrid, ringBox, wallPush } from './cell-grid.ts';
import type { Wall } from './cell-grid.ts';
import { floorAt, propFootprint, stairCorners, stairsOf } from './rooms.ts';
import type { Room } from './rooms.ts';

/** Cells half a metre across: aisles between pews are a metre and a half. */
export const ROOM_CELL = 0.5;
/** Half a wall's thickness (m), and a stair rail's. */
const WALL_HALF = 0.15;
const RAIL_HALF = 0.05;
/** The threshold: open this far round the door (m), as the street's grid opens it. */
export const DOOR_HALF = 1.2;

const CLOSED = 0;
const OPEN = 1;

export class RoomGrid {
  readonly #grid: CellGrid;
  readonly #walls: Wall[] = [];
  #query = 0;

  constructor(room: Room, level: number) {
    const floor = floorAt(room, level);
    if (!floor) throw new Error(`${room.name} has no floor ${level}`);
    const box = ringBox(room.floors.flatMap((f) => f.slab).concat(room.door.x, room.door.z), 3);
    const stairs = stairsOf(room, level);
    const ground = level === 0;
    const solids = floor.props.map(propFootprint);
    this.#grid = new CellGrid(
      box,
      (tile, x0, z0) => {
        const grid = this.#grid;
        grid.fillRing(tile, floor.slab, OPEN, x0, z0);
        for (const hole of floor.holes) grid.fillRing(tile, hole, CLOSED, x0, z0);
        for (const { stair } of stairs) grid.fillRing(tile, stairCorners(stair), OPEN, x0, z0);
        for (const ring of solids) grid.fillRing(tile, ring, CLOSED, x0, z0);
        if (ground) {
          const { x, z } = room.door;
          grid.fillRibbon(tile, [x, z, x, z], DOOR_HALF, OPEN, x0, z0);
        }
      },
      ROOM_CELL,
    );
    const wall = (line: number[], half: number, ring = false) =>
      this.#walls.push({ line, ring, half, box: ringBox(line, half), seen: 0 });
    for (const w of floor.walls) {
      const length = Math.hypot(w.x1 - w.x0, w.z1 - w.z0);
      const [ux, uz] = [(w.x1 - w.x0) / (length || 1), (w.z1 - w.z0) / (length || 1)];
      // The wall between its gaps, in pieces.
      let from = 0;
      for (const [a, b] of [...w.gaps].toSorted((p, q) => p[0] - q[0]).concat([[length, length]])) {
        if (a > from)
          wall([w.x0 + ux * from, w.z0 + uz * from, w.x0 + ux * a, w.z0 + uz * a], WALL_HALF);
        from = Math.max(from, b);
      }
    }
    for (const ring of solids) wall(ring, 0, true);
    // A stair is a corridor between its rails: on the floor below, closed at its top end, so
    // nobody walks onto it from under the floor it climbs to; above, closed at its foot.
    for (const { stair, from } of stairs) {
      const [a, b, c, d, e, f, g, h] = stairCorners(stair);
      wall([a!, b!, g!, h!], RAIL_HALF);
      wall([c!, d!, e!, f!], RAIL_HALF);
      wall(from.level === level ? [e!, f!, g!, h!] : [a!, b!, c!, d!], RAIL_HALF);
    }
  }

  get cols(): number {
    return this.#grid.cols;
  }

  get rows(): number {
    return this.#grid.rows;
  }

  cellAt(x: number, z: number): number {
    return this.#grid.cellAt(x, z);
  }

  centre(cell: number): [number, number] {
    return this.#grid.centre(cell);
  }

  open(cell: number): boolean {
    return this.#grid.value(cell, CLOSED) === OPEN;
  }

  walkable(x: number, z: number): boolean {
    return this.open(this.cellAt(x, z));
  }

  /** How closed the floor is at (x, z), 0 to 1, its edge at a half (as `WalkGrid.closed`). */
  closed(x: number, z: number): number {
    return this.#grid.blend(x, z, (v) => v === CLOSED);
  }

  /** How far a circle reaches into the room's walls, rails and furnishings (as `WalkGrid`). */
  wallOverlap(x: number, z: number, radius: number, out: [number, number]): number {
    const sum: [number, number, number] = [0, 0, 0];
    wallPush(this.#walls, x, z, radius, ++this.#query, sum);
    const length = Math.hypot(sum[0], sum[1]);
    if (length < 1e-9) return 0;
    [out[0], out[1]] = [sum[0] / length, sum[1] / length];
    return sum[2];
  }

  /** The open cell centre nearest (x, z) within `radius` metres, or null. */
  nearest(x: number, z: number, radius: number): [number, number] | null {
    return this.#grid.nearest(x, z, radius, (cell) => this.open(cell));
  }
}
