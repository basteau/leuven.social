import type { Bounds, Building, Carriageway, City, Path, Prop, Rail, Tank } from '../data/city.ts';
import { clipLine, clipRing } from '../data/geometry.ts';
import { addBuilding } from './buildings.ts';
import type { PartyWalls } from './buildings.ts';
import { addGround, addSlabInk } from './ground.ts';
import { GROUND_RINGS } from './ground.ts';
import { LineBuilder, MeshBuilder } from './mesh-builder.ts';
import { addFinePaint } from './paint.ts';
import type { Marking } from './paint.ts';
import { LARGE_PROPS, addProp } from './props.ts';
import {
  addCanopyBay,
  addMasts,
  addPlatform,
  addRailLines,
  addRailParapet,
  addTracks,
  canopyBays,
  planRailway,
} from './rails.ts';
import type { CanopyBay, Mast, RailParapet } from './rails.ts';
import { addParapet, addTank } from './structures.ts';
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
  ground: { [K in (typeof GROUND_RINGS)[number]]: Float32Array[] } & {
    carriageways: Carriageway[];
    markings: Marking[];
    paths: Path[];
  };
  /** Flat [x, z, seed, height, …]: the seed keeps a tree's look when the cell changes. */
  trees: number[];
  parasols: Parasol[];
  /** Street furniture, drawn in a mesh of its own that hides when zoomed out; tall ones aren't. */
  props: Prop[];
  tanks: Tank[];
  parapets: Float32Array[];
  /** Track pieces clipped to the cell, and what stands along them. */
  rails: Rail[];
  masts: Mast[];
  railParapets: RailParapet[];
  platforms: Float32Array[];
  /** Bays of platform roofs, each in the cell of its centre. */
  canopies: CanopyBay[];
}

const cellOf = (v: number) => Math.floor(v / CELL_SIZE);

/** How far along `line` the point (x, z), which lies on it, is. */
export function along(line: ArrayLike<number>, x: number, z: number): number {
  let run = 0;
  let best = 0;
  let nearest = Infinity;
  for (let i = 0; i + 3 < line.length; i += 2) {
    const [ax, az, bx, bz] = [line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!];
    const len = Math.hypot(bx - ax, bz - az);
    const t =
      len > 0 ? Math.min(len, Math.max(0, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / len)) : 0;
    const off =
      len > 0
        ? Math.hypot(ax + ((bx - ax) * t) / len - x, az + ((bz - az) * t) / len - z)
        : Math.hypot(ax - x, az - z);
    if (off < nearest - 1e-6) [nearest, best] = [off, run + t];
    run += len;
  }
  return best;
}

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
            woods: [],
            pitches: [],
            parking: [],
            roads: [],
            carriageways: [],
            markings: [],
            plazas: [],
            railLand: [],
            paths: [],
          },
          trees: [],
          parasols: [],
          props: [],
          tanks: [],
          parapets: [],
          rails: [],
          masts: [],
          railParapets: [],
          platforms: [],
          canopies: [],
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
  for (const p of city.props) at(p.x, p.z)?.props.push(p);
  // Like buildings, tanks and parapets go whole to the cell of their first point.
  for (const t of city.tanks) at(t.ring[0]!, t.ring[1]!)?.tanks.push(t);
  for (const line of city.parapets) at(line[0]!, line[1]!)?.parapets.push(line);
  const railway = planRailway(city.rails);
  for (const m of railway.masts) at(m.x, m.z)?.masts.push(m);
  for (const p of railway.parapets) at(p.ax, p.az)?.railParapets.push(p);
  for (const b of city.canopies.flatMap(canopyBays)) at(b.cx, b.cz)?.canopies.push(b);

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
  for (const layer of GROUND_RINGS) {
    for (const ring of city[layer]) cut(ring, (cell, piece) => cell.ground[layer].push(piece));
  }
  // Platforms too: their walls and edges are left out along a cut (see `addPlatform`).
  for (const ring of city.platforms) cut(ring, (cell, piece) => cell.platforms.push(piece));
  for (const { kind, ring } of city.carriageways) {
    cut(ring, (cell, piece) => cell.ground.carriageways.push({ kind, ring: piece }));
  }
  // Paths, tracks and lane lines are cut the same way, piece by piece along the cells they cross.
  const cutLine = (line: Float32Array, add: (cell: Cell, piece: Float32Array) => void) => {
    for (const cell of span(line)) {
      for (const piece of clipLine(line, cell.bounds)) add(cell, Float32Array.from(piece));
    }
  };
  for (const { width, paved, line } of city.paths) {
    cutLine(line, (cell, piece) => cell.ground.paths.push({ width, paved, line: piece }));
  }
  for (const rail of city.rails) {
    cutLine(rail.line, (cell, piece) => cell.rails.push({ ...rail, line: piece }));
  }
  for (const { kind, line } of city.markings) {
    // A crossing stays whole, in the cell of its start, so its bars keep their rhythm; a lane
    // line's pieces remember where along it they start, so its dashes do.
    if (kind === 'zebra' || kind === 'bike-crossing') {
      at(line[0]!, line[1]!)?.ground.markings.push({ kind, line });
    } else {
      cutLine(line, (cell, piece) =>
        cell.ground.markings.push({ kind, line: piece, from: along(line, piece[0]!, piece[1]!) }),
      );
    }
  }
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

/**
 * Everything in one cell as one mesh and one set of outlines (two draw calls), plus its small
 * street furniture as a third mesh, so it can hide when zoomed out. In the main mesh the flat
 * ground comes first, then the tree trunks (from `trunksFrom`), and the rest from `shadowFrom`, so
 * the shadow pass can skip them: the ground can't shade anything, and seen from above a trunk's
 * shadow hides in its crown's. The fine road paint comes last (from `fineVertices`), so a
 * zoomed-out view can skip that.
 */
export function buildCell(
  cell: Cell,
  area: readonly Bounds[],
  walls: PartyWalls,
): {
  mesh: MeshBuilder;
  lines: LineBuilder;
  props: MeshBuilder;
  trunksFrom: number;
  shadowFrom: number;
  fineVertices: number;
  detail: DetailMarks;
} {
  const mesh = new MeshBuilder();
  const lines = new LineBuilder();
  const props = new MeshBuilder();
  const { trees } = cell;
  addGround(mesh, area, cell.bounds, cell.ground);
  // Track beds are flat ground too, so they join it before the shadow pass's start.
  addTracks(mesh, cell.rails);
  const trunksFrom = mesh.vertices;
  for (let i = 0; i < trees.length; i += 4) {
    addTree(mesh, trees[i]!, trees[i + 1]!, trees[i + 2]!, trees[i + 3]!, ['trunk']);
  }
  const shadowFrom = mesh.vertices;
  addRailLines(lines, cell.rails);
  const rails = lines.segments;
  addMasts(lines, cell.masts);
  const detail = { rails, masts: lines.segments };
  // Every other outline follows the rails and masts, which the view leaves out from afar.
  addSlabInk(lines, area, cell.bounds);
  for (const p of cell.railParapets) addRailParapet(mesh, lines, p);
  for (const ring of cell.platforms) addPlatform(mesh, lines, ring, cell.bounds);
  for (const bay of cell.canopies) addCanopyBay(mesh, lines, bay);
  for (const b of cell.buildings) addBuilding(mesh, lines, b, walls);
  for (let i = 0; i < trees.length; i += 4) {
    addTree(mesh, trees[i]!, trees[i + 1]!, trees[i + 2]!, trees[i + 3]!, ['crown']);
  }
  for (const p of cell.parasols) addParasol(mesh, lines, p);
  for (const t of cell.tanks) addTank(mesh, lines, t);
  for (const line of cell.parapets) addParapet(mesh, lines, line);
  for (const p of cell.props) addProp(LARGE_PROPS.has(p.kind) ? mesh : props, p);
  const fineVertices = mesh.vertices;
  addFinePaint(mesh, cell.ground.markings);
  return { mesh, lines, props, trunksFrom, shadowFrom, fineVertices, detail };
}
