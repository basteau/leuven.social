import type { Material, MonumentKind, Prop } from '../data/city.ts';
import { NEEDLE_HEIGHT } from '../data/monuments.ts';
import type { MeshBuilder } from './mesh-builder.ts';
import { GROUND, MATERIAL, PROPS } from './palette.ts';
import { prism } from './prop-shapes.ts';
import type { Frame } from './prop-shapes.ts';

/**
 * Monuments as a handful of archetypes, each a few prisms sized by its data alone
 * (src/data/monuments.ts): its height, its plinth or basin, its material. Cartoony on purpose,
 * like the walker: a figure is legs, a torso, arms and a big head, an arm raised or held out by
 * its pose, never a likeness. A few dozen triangles each.
 */

/** Monuments tall enough to stay in view at every zoom, in the cell's main mesh (the Totem). */
export const isLarge = (p: Prop): boolean =>
  p.kind === 'needle' || (p.kind === 'column' && p.size >= NEEDLE_HEIGHT);

/**
 * A prism in the monument's frame (see `prism`): half sizes, from y0 to y1, its colour, taper and
 * sides, and where it stands off the middle.
 */
type Part = (
  ru: number,
  rv: number,
  y0: number,
  y1: number,
  color: number,
  taper?: number,
  sides?: number,
  u?: number,
  v?: number,
  cap?: boolean,
) => void;

/**
 * A standing figure h tall on y, at u across: legs (or a robe), a torso wider at the shoulders,
 * a big head, and its arms at its sides, the right one raised (pose 1) or held out (pose 2).
 */
function figure(P: Part, u: number, y: number, h: number, color: number, pose: number): void {
  const part = (du: number, dv: number, ru: number, rv: number, y0: number, y1: number, t = 1) =>
    P(ru * h, rv * h, y + y0 * h, y + y1 * h, color, t, 4, u + du * h, dv * h);
  part(0, 0, 0.09, 0.06, 0, 0.45, 1.2);
  part(0, 0, 0.12, 0.08, 0.45, 0.74, 1.25);
  part(0, 0, 0.085, 0.085, 0.72, 1, 0.85);
  part(-0.19, 0, 0.04, 0.04, 0.42, 0.72);
  if (pose === 1) part(0.19, 0, 0.04, 0.04, 0.6, 1.12);
  else if (pose === 2) part(0.19, 0.14, 0.04, 0.14, 0.62, 0.7);
  else part(0.19, 0, 0.04, 0.04, 0.42, 0.72);
}

/** A plinth w by d and h tall: a base course, a block narrowed to `waist` and a cornice. */
function plinth(P: Part, w: number, d: number, h: number, m: Material, waist = 0.85): void {
  // A pale figure stands on dark bluestone, a dark one on pale stone.
  const pale = m === 'stone' || m === 'marble' || m === 'concrete';
  for (const [y0, y1, s] of [
    [0, 0.15, 1],
    [0.15, 0.85, waist],
    [0.85, 1, 1],
  ] as const)
    P((w / 2) * s, (d / 2) * s, y0 * h, y1 * h, pale ? MATERIAL.bluestone : MATERIAL.stone);
}

type Draw = (P: Part, h: number, w: number, d: number, m: Material, seed: number) => void;

const MODELS: Record<MonumentKind, Draw> = {
  statue(P, h, w, d, m, seed) {
    const top = Math.min(0.4 * h, 3);
    plinth(P, w, d, top, m);
    figure(P, 0, top, h - top, MATERIAL[m], seed % 3);
  },
  group(P, h, w, d, m, seed) {
    const top = 0.3 * h;
    plinth(P, w, d, top, m);
    const n = w >= 3 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const tall = (h - top) * (1 - 0.12 * ((i + seed) % 2));
      figure(P, (i - (n - 1) / 2) * (w / n), top, tall, MATERIAL[m], (seed + i) % 3);
    }
  },
  bust(P, h, w, d, m) {
    const top = 0.62 * h;
    const b = h - top;
    plinth(P, w, d, top, m, 0.6);
    P(0.36 * b, 0.2 * b, top, top + 0.45 * b, MATERIAL[m], 0.75);
    P(0.17 * b, 0.19 * b, top + 0.42 * b, h, MATERIAL[m], 0.85);
  },
  sculpture(P, h, w, d, m, seed) {
    const [c, r, y] = [MATERIAL[m], Math.min(w, d) / 2, 0.12];
    P(w / 2, d / 2, 0, y, MATERIAL.stone);
    const form = seed % 3;
    if (form === 0) {
      // Blocks stacked off-centre, square and hexagonal in turn.
      for (let i = 0; i < 3; i++) {
        const [a, b] = [y + (i * (h - y)) / 3, y + ((i + 1) * (h - y)) / 3];
        P((0.55 - 0.1 * i) * r, 0.45 * r, a, b, c, 0.8, i % 2 ? 6 : 4, (i % 2 ? 0.25 : -0.2) * r);
      }
    } else if (form === 1) {
      // A gate: two posts and a lintel.
      for (const s of [-1, 1]) P(0.18 * r, 0.25 * r, y, 0.78 * h, c, 1, 4, s * 0.6 * r);
      P(0.8 * r, 0.25 * r, 0.78 * h, h, c);
    } else {
      // Two three-sided spires, one taller.
      P(0.5 * r, 0.5 * r, y, h, c, 0.1, 3, -0.25 * r);
      P(0.35 * r, 0.35 * r, y, 0.6 * h, c, 0.1, 3, 0.4 * r);
    }
  },
  column(P, h, w, d, m) {
    const c = MATERIAL[m];
    const step = Math.min(Math.max(0.05 * h, 0.15), 0.8);
    const r = Math.min(0.06 * h + 0.15, 0.3 * Math.min(w, d));
    P(w / 2, d / 2, 0, step, c);
    P(w * 0.35, d * 0.35, step, 2 * step, c);
    P(r, r, 2 * step, 0.88 * h, c, 0.75);
    P(0.85 * r, 0.85 * r, 0.88 * h, h, c, 0);
  },
  stone(P, h, w, d, m) {
    P(w / 2, d / 2, 0, 0.85 * h, MATERIAL[m]);
    P(w / 2, d / 2, 0.85 * h, h, MATERIAL[m], 0.5);
  },
  fountain(P, h, w, d, m) {
    P(w / 2, d / 2, 0, 0.5, MATERIAL.stone, 1, 8, 0, 0, false);
    P(w * 0.48, d * 0.48, 0.42, 0.42, GROUND.water, 1, 8);
    const c = MATERIAL[m];
    if (m === 'water') {
      // A jet that bursts into a crown of spray.
      P(0.12, 0.12, 0.42, 0.75 * h, c, 0.6, 6);
      for (const end of [0.5, 1]) P(0.6, 0.6, 0.7 * h, end * h, c, 0, 8);
    } else {
      // A figure on a pillar in the basin, its arm up: Fonske pours his glass over his head.
      const top = 0.38 * h;
      P(0.3, 0.3, 0.42, top, MATERIAL.stone);
      figure(P, 0, top, h - top, c, 1);
    }
  },
  pump(P, h, w, d, m) {
    const [c, r] = [MATERIAL[m], Math.min(w, d, 0.8) / 2];
    P(w / 2, d / 2, 0, 0.2, c);
    P(0.75 * r, 0.75 * r, 0.2, 0.72 * h, c, 0.9);
    P(r, r, 0.72 * h, 0.8 * h, c);
    P(0.7 * r, 0.7 * r, 0.8 * h, h, c, 0);
    // The spout, out front.
    P(0.05, 0.15, 0.42 * h, 0.48 * h, PROPS.iron, 1, 4, 0, 0.75 * r + 0.15);
  },
  needle(P, h) {
    P(0.8, 0.8, 0, h, PROPS.iron, 0);
    // The beetle, speared lengthwise near the top: drawn larger than life so it reads from afar.
    for (const end of [0.72, 0.84]) P(1.4, 2.4, 0.77 * h, end * h, PROPS.beetle, 0, 8);
  },
};

/** A monument, in its own frame, written into `mesh`. */
export function addMonument(
  mesh: MeshBuilder,
  f: Frame,
  kind: MonumentKind,
  p: Prop,
  seed: number,
): void {
  const P: Part = (ru, rv, y0, y1, color, taper, sides, u = 0, v = 0, cap) =>
    prism(mesh, f, [u, v], [ru, rv], [y0, y1], color, taper, sides, cap);
  MODELS[kind](P, p.size, p.width ?? 1, p.depth ?? 1, p.material ?? 'bronze', seed >>> 0);
}
