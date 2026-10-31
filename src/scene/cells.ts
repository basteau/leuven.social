import type { Bounds, Building, City, Path, Rail } from '../data/city.ts';
import { clipLine, clipRing } from '../data/geometry.ts';
import { addBuilding } from './buildings.ts';
import type { PartyWalls } from './buildings.ts';
import { addGround } from './ground.ts';
import type { GroundLayers } from './ground.ts';
import { LineBuilder, MeshBuilder } from './mesh-builder.ts';
import {
  addMasts,
  addParapet,
  addPlatform,
  addRailLines,
  addTracks,
  planRailway,
} from './rails.ts';
import type { Mast, Parapet } from './rails.ts';
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
  ground: { [K in Exclude<keyof GroundLayers, 'paths'>]: Float32Array[] } & { paths: Path[] };
  /** Flat [x, z, seed, height, …]: the seed keeps a tree's look when the cell changes. */
  trees: number[];
  parasols: Parasol[];
  /** Track pieces clipped to the cell, and what stands along them. */
  rails: Rail[];
  masts: Mast[];
  parapets: Parapet[];
  platforms: Float32Array[];
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
          ground: { green: [], water: [], roads: [], plazas: [], paths: [] },
          trees: [],
          parasols: [],
          rails: [],
          masts: [],
          parapets: [],
          platforms: [],
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
  const { masts, parapets } = planRailway(city.rails);
  for (const m of masts) at(m.x, m.z)?.masts.push(m);
  for (const p of parapets) at(p.ax, p.az)?.parapets.push(p);

  // Ground polygons are flat, so they can be cut along cell edges without a visible seam.
  // Platforms too: their walls and edges are left out along a cut (see `addPlatform`).
  const layers = [
    ...(['green', 'water', 'roads', 'plazas'] as const).map(
      (layer) => [city[layer], (c: Cell) => c.ground[layer]] as const,
    ),
    [city.platforms, (c: Cell) => c.platforms] as const,
  ];
  for (const [rings, into] of layers) {
    for (const ring of rings) {
      let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity];
      for (let k = 0; k < ring.length; k += 2) {
        [minX, maxX] = [Math.min(minX, ring[k]!), Math.max(maxX, ring[k]!)];
        [minZ, maxZ] = [Math.min(minZ, ring[k + 1]!), Math.max(maxZ, ring[k + 1]!)];
      }
      const whole = cellOf(minX) === cellOf(maxX) && cellOf(minZ) === cellOf(maxZ);
      for (let i = cellOf(minX); i <= cellOf(maxX); i++) {
        for (let j = cellOf(minZ); j <= cellOf(maxZ); j++) {
          const cell = cells.get(`${i},${j}`);
          if (!cell) continue;
          const piece = whole ? ring : clipRing(Array.from(ring), cell.bounds);
          if (piece.length >= 6) into(cell).push(Float32Array.from(piece));
        }
      }
    }
  }
  // Paths and tracks are cut the same way, piece by piece along the cells they cross.
  const cut = <T extends { line: Float32Array }>(lines: readonly T[], into: (c: Cell) => T[]) => {
    for (const item of lines) {
      const { line } = item;
      let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity];
      for (let k = 0; k < line.length; k += 2) {
        [minX, maxX] = [Math.min(minX, line[k]!), Math.max(maxX, line[k]!)];
        [minZ, maxZ] = [Math.min(minZ, line[k + 1]!), Math.max(maxZ, line[k + 1]!)];
      }
      for (let i = cellOf(minX); i <= cellOf(maxX); i++) {
        for (let j = cellOf(minZ); j <= cellOf(maxZ); j++) {
          const cell = cells.get(`${i},${j}`);
          for (const piece of cell ? clipLine(line, cell.bounds) : []) {
            into(cell!).push({ ...item, line: Float32Array.from(piece) });
          }
        }
      }
    }
  };
  cut(city.paths, (c) => c.ground.paths);
  cut(city.rails, (c) => c.rails);
  return [...cells.values()];
}

/**
 * Where the zoom-dependent detail ends in a cell's outlines, in segments: the rails come first,
 * then the catenary masts, then everything that always shows. A zoomed-out view starts drawing
 * past them (see `setDrawRange`), so they cost no extra draw call.
 */
export interface DetailMarks {
  rails: number;
  masts: number;
}

/** Everything in one cell as one mesh and one set of outlines: two draw calls. */
export function buildCell(
  cell: Cell,
  area: readonly Bounds[],
  walls: PartyWalls,
): { mesh: MeshBuilder; lines: LineBuilder; detail: DetailMarks } {
  const mesh = new MeshBuilder();
  const lines = new LineBuilder();
  addGround(mesh, area, cell.bounds, cell.ground);
  addTracks(mesh, cell.rails);
  addRailLines(lines, cell.rails);
  const rails = lines.segments;
  addMasts(lines, cell.masts);
  const detail = { rails, masts: lines.segments };
  for (const p of cell.parapets) addParapet(mesh, lines, p);
  for (const ring of cell.platforms) addPlatform(mesh, lines, ring, cell.bounds);
  for (const b of cell.buildings) addBuilding(mesh, lines, b, walls);
  for (let i = 0; i < cell.trees.length; i += 4) {
    addTree(mesh, cell.trees[i]!, cell.trees[i + 1]!, cell.trees[i + 2]!, cell.trees[i + 3]!);
  }
  for (const p of cell.parasols) addParasol(mesh, lines, p);
  return { mesh, lines, detail };
}
