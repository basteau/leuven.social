/**
 * Who hears about whom: the city's 350 m cells, as the server files the players by them. A client
 * is told about the players in the cell it looks at and the eight around it, which is at least
 * a cell's width of street on every side, further than the map draws a figure.
 *
 * A cell is one integer, so it can key a Map and compare with ===.
 */

import { CELL_SIZE } from '../data/grid.ts';

/** How far along each axis a cell index can go from the origin (the map is a few cells across). */
const OFFSET = 1 << 11;
const SIZE = 1 << 12;

/** The cell a point lies in. */
export const cellAt = (x: number, z: number): number =>
  (Math.floor(x / CELL_SIZE) + OFFSET) * SIZE + (Math.floor(z / CELL_SIZE) + OFFSET);

/** A cell's index east and south of the origin. */
export const cellX = (cell: number): number => Math.floor(cell / SIZE) - OFFSET;
export const cellZ = (cell: number): number => (cell % SIZE) - OFFSET;

/** Whether `a` is `b` or one of the eight around it. */
export function watches(a: number, b: number): boolean {
  return Math.abs(cellX(a) - cellX(b)) <= 1 && Math.abs(cellZ(a) - cellZ(b)) <= 1;
}

/** `cell` and the eight around it. */
export function around(cell: number): number[] {
  const cells: number[] = [];
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) cells.push(cell + i * SIZE + j);
  return cells;
}
