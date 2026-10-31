import type { Bounds, Building, Carriageway, City, Marking, Path } from '../data/city.ts';
import { clipLine, clipRing } from '../data/geometry.ts';
import { addBuilding } from './buildings.ts';
import type { PartyWalls } from './buildings.ts';
import { addGround } from './ground.ts';
import { LineBuilder, MeshBuilder } from './mesh-builder.ts';
import { addFinePaint } from './paint.ts';
import { addParasol } from './terraces.ts';
import type { Parasol } from './terraces.ts';
import { addTree } from './trees.ts';

/**
 * The city is cut into square cells so the renderer can skip what's off screen. Big enough
 * that a view at the default zoom touches only a handful (a draw call or two each), small
 * enough that zoomed in most of the city is culled.
 */
export const CELL_SIZE = 350;

export interface Cell {
  bounds: Bounds;
  buildings: Building[];
  ground: { [K in 'green' | 'water' | 'roads' | 'plazas']: Float32Array[] } & {
    carriageways: Carriageway[];
    markings: Marking[];
    paths: Path[];
  };
  /** Flat [x, z, seed, height, …]: the seed keeps a tree's look when the cell changes. */
  trees: number[];
  parasols: Parasol[];
}

const cellOf = (v: number) => Math.floor(v / CELL_SIZE);

/** Sorts the city into cells. A building goes whole to the cell holding its first corner. */
export function partition(city: City, parasols: readonly Parasol[] = []): Cell[] {
  const cells = new Map<string, Cell>();
  for (const a of city.area) {
    for (let i = cellOf(a.minX); i * CELL_SIZE < a.maxX; i++) {
      for (let j = cellOf(a.minZ); j * CELL_SIZE < a.maxZ; j++) {
        const key = `${i},${j}`;
        if (cells.has(key)) continue;
        cells.set(key, {
          bounds: {
            minX: i * CELL_SIZE,
            minZ: j * CELL_SIZE,
            maxX: (i + 1) * CELL_SIZE,
            maxZ: (j + 1) * CELL_SIZE,
          },
          buildings: [],
          ground: {
            green: [],
            water: [],
            roads: [],
            carriageways: [],
            markings: [],
            plazas: [],
            paths: [],
          },
          trees: [],
          parasols: [],
        });
      }
    }
  }
  const at = (x: number, z: number) => cells.get(`${cellOf(x)},${cellOf(z)}`);

  for (const b of city.buildings) at(b.ring[0]!, b.ring[1]!)?.buildings.push(b);
  for (let i = 0; i < city.trees.length; i += 2) {
    const [x, z] = [city.trees[i]!, city.trees[i + 1]!];
    at(x, z)?.trees.push(x, z, i / 2, city.treeHeights[i / 2] ?? 0);
  }
  for (const p of parasols) at(p.x, p.z)?.parasols.push(p);

  const span = (flat: ArrayLike<number>) => {
    let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let k = 0; k < flat.length; k += 2) {
      [minX, maxX] = [Math.min(minX, flat[k]!), Math.max(maxX, flat[k]!)];
      [minZ, maxZ] = [Math.min(minZ, flat[k + 1]!), Math.max(maxZ, flat[k + 1]!)];
    }
    const touched: Cell[] = [];
    for (let i = cellOf(minX); i <= cellOf(maxX); i++) {
      for (let j = cellOf(minZ); j <= cellOf(maxZ); j++) {
        const cell = cells.get(`${i},${j}`);
        if (cell) touched.push(cell);
      }
    }
    return touched;
  };
  // Ground polygons are flat, so they can be cut along cell edges without a visible seam.
  const cut = (ring: Float32Array, add: (cell: Cell, piece: Float32Array) => void) => {
    const touched = span(ring);
    for (const cell of touched) {
      const piece = touched.length === 1 ? ring : clipRing(Array.from(ring), cell.bounds);
      if (piece.length >= 6) add(cell, Float32Array.from(piece));
    }
  };
  for (const layer of ['green', 'water', 'roads', 'plazas'] as const) {
    for (const ring of city[layer]) cut(ring, (cell, piece) => cell.ground[layer].push(piece));
  }
  for (const { kind, ring } of city.carriageways) {
    cut(ring, (cell, piece) => cell.ground.carriageways.push({ kind, ring: piece }));
  }
  // Paths and lane lines are cut the same way, piece by piece along the cells they cross.
  const cutLine = (line: Float32Array, add: (cell: Cell, piece: Float32Array) => void) => {
    for (const cell of span(line)) {
      for (const piece of clipLine(line, cell.bounds)) add(cell, Float32Array.from(piece));
    }
  };
  for (const { width, paved, line } of city.paths) {
    cutLine(line, (cell, piece) => cell.ground.paths.push({ width, paved, line: piece }));
  }
  for (const { kind, line } of city.markings) {
    // A crossing stays whole, in the cell of its start, so its bars keep their rhythm.
    if (kind === 'zebra' || kind === 'bike-crossing')
      at(line[0]!, line[1]!)?.ground.markings.push({ kind, line });
    else cutLine(line, (cell, piece) => cell.ground.markings.push({ kind, line: piece }));
  }
  return [...cells.values()];
}

/**
 * Everything in one cell as one mesh and one set of outlines: two draw calls. The fine road paint
 * comes last (from `fineVertices`), so a zoomed-out view can leave it out.
 */
export function buildCell(
  cell: Cell,
  area: readonly Bounds[],
  walls: PartyWalls,
): { mesh: MeshBuilder; lines: LineBuilder; fineVertices: number } {
  const mesh = new MeshBuilder();
  const lines = new LineBuilder();
  addGround(mesh, area, cell.bounds, cell.ground);
  for (const b of cell.buildings) addBuilding(mesh, lines, b, walls);
  for (let i = 0; i < cell.trees.length; i += 4) {
    addTree(mesh, cell.trees[i]!, cell.trees[i + 1]!, cell.trees[i + 2]!, cell.trees[i + 3]!);
  }
  for (const p of cell.parasols) addParasol(mesh, lines, p);
  const fineVertices = mesh.vertices;
  addFinePaint(mesh, cell.ground.markings);
  return { mesh, lines, fineVertices };
}
