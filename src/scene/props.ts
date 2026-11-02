import { isMonument } from '../data/city.ts';
import type { MonumentKind, Prop, PropKind } from '../data/city.ts';
import {
  BIKE_SHIFT,
  HANDLEBAR,
  ROW_GAP,
  STAND_SPACING,
  propScale,
  rackRows,
} from '../data/props.ts';
import { BIKES, PROPS, pick } from './palette.ts';
import type { MeshBuilder } from './mesh-builder.ts';
import { addMonument } from './monuments.ts';
import { at, away, box, panel } from './prop-shapes.ts';
import type { Frame } from './prop-shapes.ts';

/**
 * Low-poly street furniture, a few boxes and panels each, written into a cell's props mesh, and
 * the monuments of src/scene/monuments.ts. Furniture is true to life, then drawn a third larger
 * (`propScale`), as a diorama does: at life size a lamp post or a bike is a pixel or two even
 * zoomed in. Each prop stands in its own frame (`Frame`): v along its facing (see `placeProps`),
 * u across it, within the footprint the bake keeps clear.
 */

export { isLarge } from './monuments.ts';
/** Share of a rack's stands that hold a bike. Leuven's racks are rarely empty. */
const OCCUPANCY = 0.75;
/** Half a bike tube's width: chunky, so a frame still shows its colour zoomed out (m). */
const TUBE = 0.045;
/** A wheel's pale hub (corner to middle), and half a saddle's width (m). */
const HUB = 0.25;
const SADDLE = 0.07;

/** Small integer hash, so a rack's gaps and colours stay put across reloads. */
const hash = (a: number, b: number) => {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b, 0xc2b2ae35);
  h ^= h >>> 15;
  return (Math.imul(h, 0x27d4eb2d) >>> 0) / 2 ** 32;
};

/** A tube in a bike's plane (u fixed), from (v, y) to (v, y), as a thin two-sided strip. */
function tube(
  mesh: MeshBuilder,
  f: Frame,
  u: number,
  [va, ya]: readonly [number, number],
  [vb, yb]: readonly [number, number],
  color: number,
): void {
  const length = Math.hypot(vb - va, yb - ya);
  const [nv, ny] = [((ya - yb) / length) * TUBE, ((vb - va) / length) * TUBE];
  panel(
    mesh,
    [
      at(f, u, va - nv, ya - ny),
      at(f, u, vb - nv, yb - ny),
      at(f, u, vb + nv, yb + ny),
      at(f, u, va + nv, ya + ny),
    ],
    color,
  );
}

/**
 * A diamond in a bike's plane, a hair to one side of the tyre and facing out that way: the
 * wheel's pale rim and spokes, two triangles.
 */
function hub(
  mesh: MeshBuilder,
  f: Frame,
  side: number,
  u: number,
  [v, y]: readonly [number, number],
): void {
  const w = u + side * 0.012;
  mesh.quad(
    at(f, w, v, y + HUB),
    at(f, w, v + HUB, y),
    at(f, w, v, y - HUB),
    at(f, w, v - HUB, y),
    PROPS.spokes,
    away(f, side, 0),
  );
}

/**
 * A city bike, seen side on: hexagonal wheels, dark tyres round a pale hub on either face, a
 * filled rear triangle that carries its colour on the map, top and down tubes, a fork, a saddle
 * and a handlebar across. 41 triangles.
 */
function addBike(mesh: MeshBuilder, f: Frame, u: number, v: number, color: number): void {
  const r = 0.33;
  const [rear, front] = [v - 0.55, v + 0.55];
  for (const c of [rear, front]) {
    const rim = Array.from({ length: 6 }, (_, i) => {
      const t = Math.PI / 2 + (i * Math.PI) / 3;
      return at(f, u, c + Math.cos(t) * r, r + Math.sin(t) * r);
    });
    panel(mesh, rim, PROPS.wheel);
    // On each face, so it reads as a tyre round a rim, not a black disc.
    for (const side of [-1, 1]) hub(mesh, f, side, u, [c, r]);
  }
  const bracket = [v - 0.1, 0.3] as const;
  const seat = [v - 0.28, 0.9] as const;
  const head = [v + 0.38, 0.82] as const;
  panel(mesh, [at(f, u, rear, r), at(f, u, ...bracket), at(f, u, ...seat)], color);
  tube(mesh, f, u, seat, head, color);
  tube(mesh, f, u, bracket, head, color);
  tube(mesh, f, u, [front, r], [v + 0.34, 1], color);
  // The saddle: one dark triangle on the seat, its nose forward.
  mesh.triangle(
    at(f, u - SADDLE, v - 0.4, 0.915),
    at(f, u + SADDLE, v - 0.4, 0.915),
    at(f, u, v - 0.14, 0.915),
    PROPS.wheel,
    [0, 1, 0],
  );
  // The handlebar, across the bike: a flat bar on top, which every view is from above.
  mesh.quad(
    at(f, u - HANDLEBAR, v + 0.31, 1),
    at(f, u + HANDLEBAR, v + 0.31, 1),
    at(f, u + HANDLEBAR, v + 0.37, 1),
    at(f, u - HANDLEBAR, v + 0.37, 1),
    PROPS.wheel,
    [0, 1, 0],
  );
}

function addBikes(mesh: MeshBuilder, f: Frame, stands: number, seed: number): void {
  const { rows, perRow } = rackRows(stands);
  for (let row = 0; row < rows; row++) {
    // A second row stands behind the first, away from the kerb.
    const v = rows === 1 ? 0 : row === 0 ? ROW_GAP : -ROW_GAP;
    for (let i = 0; i < perRow; i++) {
      const slot = row * perRow + i;
      if (hash(seed, slot) > OCCUPANCY) continue;
      const u = (i - (perRow - 1) / 2) * STAND_SPACING;
      // Bikes are never parked quite straight.
      const shift = (hash(seed + 1, slot) - 0.5) * 2 * BIKE_SHIFT;
      addBike(mesh, f, u, v + shift, pick(BIKES, seed * 31 + slot));
    }
  }
}

type Furniture = Exclude<PropKind, MonumentKind>;
const MODELS: Record<Furniture, (mesh: MeshBuilder, f: Frame, p: Prop, seed: number) => void> = {
  lamp(mesh, f) {
    box(mesh, f, [-0.12, 0.12], [-0.12, 0.12], [0, 4.5], PROPS.iron, false);
    box(mesh, f, [-0.3, 0.3], [-0.05, 0.55], [4.15, 4.6], PROPS.lantern);
  },
  bench(mesh, f) {
    box(mesh, f, [-0.9, 0.9], [-0.25, 0.25], [0.4, 0.5], PROPS.wood);
    box(mesh, f, [-0.9, 0.9], [-0.25, -0.17], [0.5, 0.9], PROPS.wood);
    for (const u of [-0.75, 0.75]) {
      panel(
        mesh,
        [at(f, u, -0.22, 0), at(f, u, 0.22, 0), at(f, u, 0.22, 0.4), at(f, u, -0.22, 0.4)],
        PROPS.iron,
      );
    }
  },
  bikes(mesh, f, p, seed) {
    addBikes(mesh, f, p.size, seed);
  },
  shelter(mesh, f) {
    box(mesh, f, [-1.6, 1.6], [-0.75, 0.75], [2.4, 2.55], PROPS.roof);
    panel(
      mesh,
      [
        at(f, -1.5, -0.65, 0.15),
        at(f, 1.5, -0.65, 0.15),
        at(f, 1.5, -0.65, 2.4),
        at(f, -1.5, -0.65, 2.4),
      ],
      PROPS.glass,
    );
    panel(
      mesh,
      [
        at(f, -1.5, -0.65, 0.15),
        at(f, -1.5, 0.4, 0.15),
        at(f, -1.5, 0.4, 2.4),
        at(f, -1.5, -0.65, 2.4),
      ],
      PROPS.glass,
    );
    for (const u of [-1.5, 1.5])
      box(mesh, f, [u - 0.06, u + 0.06], [0.54, 0.66], [0, 2.4], PROPS.iron, false);
  },
  busstop(mesh, f) {
    box(mesh, f, [-0.07, 0.07], [-0.07, 0.07], [0, 2.6], PROPS.iron, false);
    // The sign stands across the kerb, so a bus coming either way sees it.
    box(mesh, f, [-0.05, 0.05], [-0.28, 0.28], [2.15, 2.75], PROPS.sign);
  },
};

/** One prop, in its own frame, written into `mesh`. */
export function addProp(mesh: MeshBuilder, p: Prop): void {
  const f = {
    x: p.x,
    z: p.z,
    fx: Math.cos(p.angle),
    fz: Math.sin(p.angle),
    scale: propScale(p.kind),
  };
  const seed = Math.round(p.x * 7) ^ Math.round(p.z * 13);
  if (isMonument(p.kind)) addMonument(mesh, f, p.kind, p, seed);
  else MODELS[p.kind as Furniture](mesh, f, p, seed);
}
