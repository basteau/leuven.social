import type { MeshBuilder, V3 } from './mesh-builder.ts';
import { fromOklab, toOklab } from '../data/colour.ts';
import { MAX_TRUNK, treeScale } from '../data/trees.ts';
import { CROWN as CROWN_CODE } from './facade-codes.ts';
import { TREE, pick } from './palette.ts';
import type { TreeKind } from '../data/city.ts';

// A four-sided open trunk is all a pixel can show: its caps hide in the crown and the ground.
const TRUNK_BASE = 0.4;
const CROWN_RADIUS = 2.6;
const CROWN_Y = 4.6;

/**
 * An open, tapering trunk as triangle soup, each side written (a, b, d), (b, c, d) from its top
 * and bottom corners, as three's open CylinderGeometry would. Written out here, so the engine
 * doesn't carry three's cylinder and polyhedron for two small shapes.
 */
function trunk(top: number, bottom: number, height: number, sides: number): V3[] {
  const at = (r: number, y: number, k: number): V3 => {
    const turn = (k / sides) * Math.PI * 2;
    return [r * Math.sin(turn), y, r * Math.cos(turn)];
  };
  return Array.from({ length: sides }, (_, k) => {
    const [a, b, c, d] = [
      at(top, height, k),
      at(bottom, 0, k),
      at(bottom, 0, k + 1),
      at(top, height, k + 1),
    ];
    return [a, b, d, b, c, d];
  }).flat();
}

/** An icosahedron of `radius` round (0, y, 0) as triangle soup: three's, without its code. */
function icosahedron(radius: number, y: number): V3[] {
  const t = (1 + Math.sqrt(5)) / 2;
  const s = radius / Math.hypot(1, t);
  const corners = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ].map(([cx, cy, cz]): V3 => [cx! * s, cy! * s + y, cz! * s]);
  const faces = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1,
    8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ];
  return faces.map((i) => corners[i]!);
}

const TRUNK = trunk(0.3, TRUNK_BASE, 3, 4);
const CROWN = icosahedron(CROWN_RADIUS, CROWN_Y);
/** Height of the model at scale 1, from the ground to the crown's top vertex (m). */
export const MODEL_HEIGHT = 6.8;
/** Triangles per tree, for budgets and tests. */
export const TREE_TRIANGLES = (TRUNK.length + CROWN.length) / 3;

const CROWN_LAB = toOklab(TREE.crown);

/** A tree's own green: lightness and hue strayed by its seed, darker the older (taller) it is. */
export function crownColor(seed: number, height: number): number {
  const unit = (salt: number) => (pick(UNITS, seed * 7 + salt) / (UNITS.length - 1)) * 2 - 1;
  const [l, a, b] = CROWN_LAB;
  const turn = unit(1) * TREE.jitter.hue;
  const [c, s] = [Math.cos(turn), Math.sin(turn)];
  const old = Math.min(Math.max((height - 7) / 18, 0), 1) * TREE.age;
  return fromOklab([l + unit(2) * TREE.jitter.l - old, a * c - b * s, a * s + b * c]);
}
const UNITS = Array.from({ length: 64 }, (_, i) => i);

/**
 * How much a tree is scaled up and spread out from its model: to its surveyed height (LiDAR), a
 * little narrower than tall; without one, the seed picks a size. Crowns spread a fifth wider
 * than the model: the LiDAR trees are spaced by crown size, so a canopy closes with as few trees
 * as possible. Some are slimmer, some broader.
 */
export function treeSize(seed: number, height = 0): { scale: number; wide: number } {
  const scale = height > 0 ? treeScale(height) : 0.8 + pick([0, 0.15, 0.3, 0.45], seed);
  return { scale, wide: 1.2 * scale ** 0.8 * pick([0.86, 0.94, 1, 1.06, 1.14], seed * 3) };
}

/** How far a tree's trunk reaches at its foot (m): its crown's spread, up to `MAX_TRUNK`. */
export function trunkFoot(seed: number, height = 0): number {
  return Math.min(TRUNK_BASE * treeSize(seed, height).wide, MAX_TRUNK);
}

export type TreePart = 'trunk' | 'crown';

/** A side of the trunk as the cylinder writes it: triangles a, b, d and b, c, d. */
const SIDE = [
  [0, 1, 3],
  [1, 2, 3],
];

/**
 * One low-poly tree at (x, z), written straight into a cell's mesh: no instancing, so trees are
 * culled with their cell and cost no draw call of their own. It grows to its surveyed height
 * (LiDAR), a little narrower than tall; without one, the seed picks a size. Turn and tint vary
 * by seed. `parts` lets a cell write all its trunks apart from the crowns (see `buildCell`).
 */
export function addTree(
  mesh: MeshBuilder,
  x: number,
  z: number,
  seed: number,
  height = 0,
  parts: readonly TreePart[] = ['trunk', 'crown'],
): void {
  const { scale, wide } = treeSize(seed, height);
  const turn = (seed * 2.399) % (Math.PI * 2);
  const [c, s] = [Math.cos(turn), Math.sin(turn)];
  for (const [part, shape, color, centreY, spread] of [
    ['trunk', TRUNK, TREE.trunk, 1.5, trunkFoot(seed, height) / TRUNK_BASE],
    ['crown', CROWN, crownColor(seed, height || scale * MODEL_HEIGHT), CROWN_Y, wide],
  ] as const) {
    if (!parts.includes(part)) continue;
    const place = ([px, py, pz]: V3): V3 => [
      x + (px * c + pz * s) * spread,
      py * scale,
      z + (-px * s + pz * c) * spread,
    ];
    // Each side of the trunk is a flat quad, (a, b, d) then (b, c, d): one vertex per corner.
    const step = part === 'trunk' ? 6 : 3;
    for (let i = 0; i < shape.length; i += step) {
      const [a, b, d] = [place(shape[i]!), place(shape[i + 1]!), place(shape[i + 2]!)];
      // Outward from the shape's axis, so the builder can orient every face.
      const hint: V3 = [
        (a[0] + b[0] + d[0]) / 3 - x,
        (a[1] + b[1] + d[1]) / 3 - centreY * scale,
        (a[2] + b[2] + d[2]) / 3 - z,
      ];
      if (step === 3) mesh.triangle(a, b, d, color, hint, CROWN_CODE);
      else mesh.polygon([a, b, place(shape[i + 4]!), d], SIDE, color, hint);
    }
  }
}

/** The puffs of leaves a tree is drawn with, at every zoom: how few and many, and numbers a puff. */
export const PUFF = { min: 8, max: 18, stride: 4 } as const;

/**
 * A colour a little lighter or darker, yellower or bluer by `tint` (from -0.5 to 0.5): each puff
 * its own shade, at the price of a few multiplications, as a city has a hundred thousand puffs.
 */
function shaded(color: number, light: number, tint: number): number {
  const channel = (shift: number, k: number) =>
    Math.min(255, Math.round(((color >> shift) & 255) * light * k));
  return (channel(16, 1 + tint * 0.05) << 16) | (channel(8, 1) << 8) | channel(0, 1 - tint * 0.08);
}

/**
 * A tree as drawn (`createPuffMaterial`): balls of leaves on a shell round its crown, more on top
 * than under it, in its own green, a dark ball inside so what shows between them is shade. Four
 * numbers a puff in `into`, x, y, z and its radius, and four bytes of colour in `colors`. The
 * faceted crown is only its shadow and what a tap hits (`CROWN`).
 */
export function addPuffs(
  into: number[],
  colors: number[],
  x: number,
  ground: number,
  z: number,
  seed: number,
  height = 0,
  shape: TreeKind = 'broad',
): void {
  const { scale, wide } = treeSize(seed, height);
  const grown = height || scale * MODEL_HEIGHT;
  const [h, across] = [
    CROWN_RADIUS * scale * (shape === 'column' ? 1.35 : shape === 'willow' ? 0.9 : 1),
    CROWN_RADIUS * wide * (shape === 'column' ? 0.55 : shape === 'willow' ? 1.1 : 1),
  ];
  const count = Math.round(Math.min(PUFF.max, Math.max(PUFF.min, 6 + across * 1.1)));
  const [cy, r] = [ground + CROWN_Y * scale, across * (shape === 'column' ? 0.62 : 0.5)];
  const unit = (salt: number) => pick(UNITS, seed * 7 + salt) / (UNITS.length - 1);
  // Its colour by what OSM says it is: a conifer dark and blue, a copper beech its purple, a
  // willow a yellow green.
  const own = toOklab(crownColor(seed, grown));
  const base: [number, number, number] =
    shape === 'conifer'
      ? [own[0] - 0.07, own[1] * 0.9 - 0.012, own[2] * 0.72]
      : shape === 'copper'
        ? [own[0] - 0.14, 0.06, 0.02]
        : shape === 'willow'
          ? [own[0] + 0.05, own[1] * 0.75, own[2] * 1.2]
          : own;
  const leaf = fromOklab(base);
  const push = (px: number, py: number, pz: number, radius: number, c: number) => {
    into.push(px, py, pz, radius);
    colors.push(c >> 16, (c >> 8) & 255, c & 255, 255);
  };
  // A dark ball inside, so what shows between the puffs is the shade under the leaves.
  push(x, cy, z, across * 0.72, fromOklab([base[0] - 0.13, base[1] * 0.85, base[2] * 0.85]));
  const turn = unit(11) * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    // Down a spiral from the top, to a little under the middle; a conifer in shrinking tiers.
    const t = (i + 0.5) / count;
    const up = 1 - 1.4 * t;
    const round = shape === 'conifer' ? 0.25 + t * 0.75 : Math.sqrt(Math.max(0, 1 - up * up));
    const angle = turn + i * 2.39996;
    const wobble = 0.86 + 0.28 * unit(i + 20);
    const spread = shape === 'conifer' ? 0.62 : 0.68;
    push(
      x + Math.cos(angle) * round * across * spread * wobble,
      cy + up * h * (shape === 'conifer' ? 1.05 : shape === 'willow' ? 0.95 : 0.74),
      z + Math.sin(angle) * round * across * spread * wobble,
      r * (0.76 + 0.3 * unit(i + 40)) * (shape === 'conifer' ? 0.5 + t * 0.55 : 1),
      shaded(leaf, 1 + (up - 0.2) * 0.1 + (unit(i + 60) - 0.5) * 0.1, unit(i + 80) - 0.5),
    );
  }
}
