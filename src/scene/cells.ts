import type { Bounds, Building, City, Path } from '../data/city.ts';
import { clipLine, clipRing } from '../data/geometry.ts';
import { addBuilding } from './buildings.ts';
import type { PartyWalls } from './buildings.ts';
import { addGround } from './ground.ts';
import type { GroundLayers } from './ground.ts';
import { LineBuilder, MeshBuilder } from './mesh-builder.ts';
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

  // Ground polygons are flat, so they can be cut along cell edges without a visible seam.
  for (const layer of ['green', 'water', 'roads', 'plazas'] as const) {
    for (const ring of city[layer]) {
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
          if (piece.length >= 6) cell.ground[layer].push(Float32Array.from(piece));
        }
      }
    }
  }
  // Paths are cut the same way, piece by piece along the cells they cross.
  for (const path of city.paths) {
    let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let k = 0; k < path.line.length; k += 2) {
      [minX, maxX] = [Math.min(minX, path.line[k]!), Math.max(maxX, path.line[k]!)];
      [minZ, maxZ] = [Math.min(minZ, path.line[k + 1]!), Math.max(maxZ, path.line[k + 1]!)];
    }
    for (let i = cellOf(minX); i <= cellOf(maxX); i++) {
      for (let j = cellOf(minZ); j <= cellOf(maxZ); j++) {
        const cell = cells.get(`${i},${j}`);
        for (const piece of cell ? clipLine(path.line, cell.bounds) : []) {
          cell!.ground.paths.push({
            width: path.width,
            paved: path.paved,
            line: Float32Array.from(piece),
          });
        }
      }
    }
  }
  return [...cells.values()];
}

/**
 * Everything in one cell as one mesh and one set of outlines: two draw calls. The flat ground
 * and the tree trunks come first (up to `shadowFrom`), so the shadow pass can skip them: the
 * ground can't shade anything, and a trunk's shadow hides in its crown's.
 */
export function buildCell(
  cell: Cell,
  area: readonly Bounds[],
  walls: PartyWalls,
): { mesh: MeshBuilder; lines: LineBuilder; shadowFrom: number } {
  const mesh = new MeshBuilder();
  const lines = new LineBuilder();
  const { trees } = cell;
  addGround(mesh, area, cell.bounds, cell.ground);
  for (let i = 0; i < trees.length; i += 4) {
    addTree(mesh, trees[i]!, trees[i + 1]!, trees[i + 2]!, trees[i + 3]!, ['trunk']);
  }
  const shadowFrom = mesh.vertices;
  for (const b of cell.buildings) addBuilding(mesh, lines, b, walls);
  for (let i = 0; i < trees.length; i += 4) {
    addTree(mesh, trees[i]!, trees[i + 1]!, trees[i + 2]!, trees[i + 3]!, ['crown']);
  }
  for (const p of cell.parasols) addParasol(mesh, lines, p);
  return { mesh, lines, shadowFrom };
}
