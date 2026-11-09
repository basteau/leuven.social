/**
 * Who hears about whom: the city's 350 m cells, as the server files the players by them. A client
 * is told in full about the players in the cell it looks at and the eight around it, which is at
 * least a cell's width of street on every side, further than the map draws a figure. Past that, or
 * zoomed out beyond `FINE_REACH`, it hears only the coarse frames (server/broadcast.ts).
 *
 * A cell is one integer, so it can key a Map and compare with ===.
 */

import { CELL_SIZE } from '../data/grid.ts';

/** How far a view can reach (m) and still be told about people in full, by name. */
export const FINE_REACH = CELL_SIZE;

/** How far along each axis a cell index can go from the origin (the map is a few cells across). */
const OFFSET = 1 << 11;
const SIZE = 1 << 12;

/** The cell a point lies in. */
export const cellAt = (x: number, z: number): number =>
  (Math.floor(x / CELL_SIZE) + OFFSET) * SIZE + (Math.floor(z / CELL_SIZE) + OFFSET);
