import { Bone, BufferAttribute, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three';
import type { BufferGeometry, Material } from 'three';

import { FOREARM, SHIN, THIGH, UPPER_ARM, limbIK } from './limb.ts';
import type { Limb } from './limb.ts';
import { MeshBuilder } from './mesh-builder.ts';
import type { V3 } from './mesh-builder.ts';
import { OUTLINE, PLATE, PROPS, WALKER } from './palette.ts';
import { IDLE_SECONDS, STRIDE_RUN, STRIDE_WALK, WALK_SPEED, runBlend } from './walker.ts';

/**
 * The walker: a Leuven student in a shirt and shorts, a few chunky blocks on a fourteen-bone
 * skeleton (knees, elbows and ankles, so they can run and keep their soles flat), readable from
 * the chase camera. Its ink outline is an inverted hull in the same
 * geometry (each part again, a little larger and facing inward, so only its far side shows round
 * the silhouette), which keeps the whole figure, shadow included, to one draw call.
 */

export { FOREARM, SHIN, THIGH, UPPER_ARM, limbIK };
export type { Limb };

/** How much larger than life the figure is drawn: the same as the street furniture. */
export const CHARACTER_SCALE = 1.3;
/** Outline thickness, in model metres. */
export const OUTLINE_WIDTH = 0.035;

export const BONES = [
  'root',
  'hips',
  'torso',
  'head',
  'armL',
  'armR',
  'foreL',
  'foreR',
  'legL',
  'legR',
  'shinL',
  'shinR',
  'footL',
  'footR',
] as const;
export type BoneName = (typeof BONES)[number];

/** Ankle to sole (model metres); hip to knee and knee to ankle are in limb.ts. */
const ANKLE = 0.09;
/** The hips' height standing straight. */
const REST_HIPS = THIGH + SHIN + ANKLE;
/** The ball of the foot, where it rolls onto its toes, ahead of the ankle (model metres). */
const BALL = 0.12;
/** The hip joints either side of the middle (model metres). */
const HIP_X = 0.1;

/**
 * Each bone's parent (none for the root) and its pivot relative to that parent, in model metres
 * (y up, facing +z).
 */
const JOINTS: Record<BoneName, readonly [BoneName | '', number, number, number]> = {
  root: ['', 0, 0, 0],
  hips: ['root', 0, REST_HIPS, 0],
  torso: ['hips', 0, 0, 0],
  head: ['torso', 0, 0.56, 0],
  armL: ['torso', 0.27, 0.5, 0],
  armR: ['torso', -0.27, 0.5, 0],
  foreL: ['armL', 0, -0.24, 0],
  foreR: ['armR', 0, -0.24, 0],
  legL: ['hips', HIP_X, 0, 0],
  legR: ['hips', -HIP_X, 0, 0],
  shinL: ['legL', 0, -THIGH, 0],
  shinR: ['legR', 0, -THIGH, 0],
  footL: ['shinL', 0, -SHIN, 0],
  footR: ['shinR', 0, -SHIN, 0],
};

/** A closed loop of corners, all in one plane: a cross-section of a part. */
type Ring = readonly V3[];

/**
 * A convex part of the figure, lofted through cross-sections (`rings`, each with the same number
 * of corners) and capped at both ends, on one bone. Faces take `color`, or what `paint` gives a
 * side face (`band` counts the gaps between rings from the first, `side` the corners round them)
 * or a cap (band -1 for the first, `rings.length - 1` for the last). Its ink hull follows `hull`
 * if given (fewer or larger rings), its own rings if not, or none for small parts (`false`).
 * An end always hidden inside another part is left open (`open`: first, last).
 */
interface Solid {
  bone: BoneName;
  rings: readonly Ring[];
  color: number;
  paint?: (band: number, side: number) => number;
  hull?: readonly Ring[] | false;
  open?: readonly [boolean, boolean];
}

/** The walker's clothes and hair. */
export interface Outfit {
  shirt: number;
  shorts: number;
  hair: number;
}

/**
 * A level cross-section at `y`: the rectangle `x0`–`x1` by `z0`–`z1`, its corners cut by `bevel`
 * (eight corners, front-right first and round by the back), or square (four).
 */
function level(y: number, x0: number, x1: number, z0: number, z1: number, bevel = 0): Ring {
  if (!bevel) {
    return [
      [x1, y, z1],
      [x1, y, z0],
      [x0, y, z0],
      [x0, y, z1],
    ];
  }
  return [
    [x1 - bevel, y, z1],
    [x1, y, z1 - bevel],
    [x1, y, z0 + bevel],
    [x1 - bevel, y, z0],
    [x0 + bevel, y, z0],
    [x0, y, z0 + bevel],
    [x0, y, z1 - bevel],
    [x0 + bevel, y, z1],
  ];
}

/** A box from `min` to `max`: two square levels. */
const box = (min: V3, max: V3): Ring[] => [
  level(min[1], min[0], max[0], min[2], max[2]),
  level(max[1], min[0], max[0], min[2], max[2]),
];

/** A side profile (z, y) swept across from `x0` to `x1`: a shoe. */
const profile = (points: readonly (readonly [number, number])[], x0: number, x1: number): Ring[] =>
  [x0, x1].map((x) => points.map(([z, y]): V3 => [x, y, z]));

/** Sides of the octagonal levels: the middle of the front, and the back three. */
const FRONT = 7;
const BACK = new Set([2, 3, 4]);

/** The middle of some points. */
const centroid = (points: readonly V3[]): V3 =>
  [0, 1, 2].map((k) => points.reduce((sum, p) => sum + p[k]!, 0) / points.length) as unknown as V3;

/**
 * The rings of a part's ink hull: each ring offset outward in its own plane by `width`, mitred
 * at the corners so every side moves out the same, and the end rings pushed out along the part.
 * A ring is level (offset in x and z, the part running up y) or a profile (offset in z and y,
 * the part running across x).
 */
export function grown(rings: readonly Ring[], width: number): Ring[] {
  return rings.map((ring, r) => {
    const [u, v, along] = ring.every((p) => p[1] === ring[0]![1]) ? [0, 2, 1] : [2, 1, 0];
    const c = centroid(ring);
    const n = ring.length;
    const end = r === 0 ? -width : r === rings.length - 1 ? width : 0;
    const ahead = Math.sign(centroid(rings.at(-1)!)[along]! - centroid(rings[0]!)[along]!);
    // Each side's outward normal in the ring's plane: across the side, away from the middle.
    const normals = ring.map((p, i) => {
      const q = ring[(i + 1) % n]!;
      const [du, dv] = [q[u]! - p[u]!, q[v]! - p[v]!];
      const flip = Math.sign(dv * (p[u]! - c[u]!) - du * (p[v]! - c[v]!)) / Math.hypot(du, dv);
      return [dv * flip, -du * flip];
    });
    return ring.map((p, i) => {
      const [a, b] = [normals[(i + n - 1) % n]!, normals[i]!];
      // The mitre: as far along the sum of the two normals as moves both sides out by `width`.
      const k = width / (1 + a[0]! * b[0]! + a[1]! * b[1]!);
      const out = [...p];
      out[u] = p[u]! + (a[0]! + b[0]!) * k;
      out[v] = p[v]! + (a[1]! + b[1]!) * k;
      out[along] = p[along]! + end * ahead;
      return out as unknown as V3;
    });
  });
}

/** A part's faces, facing out, or in for its hull, which is all ink, marked with its bone. */
function addSolid(mesh: MeshBuilder, solid: Solid, rings: readonly Ring[], hull: boolean): void {
  const middle = centroid(rings.flat());
  const bone = BONES.indexOf(solid.bone);
  const colour = (band: number, side: number) =>
    hull ? OUTLINE : (solid.paint?.(band, side) ?? solid.color);
  const facing = (points: readonly V3[]) =>
    centroid(points).map((x, k) => (hull ? middle[k]! - x : x - middle[k]!)) as unknown as V3;
  for (let band = 0; band + 1 < rings.length; band++) {
    const [a, b] = [rings[band]!, rings[band + 1]!];
    for (let i = 0; i < a.length; i++) {
      const j = (i + 1) % a.length;
      const quad = [a[i]!, a[j]!, b[j]!, b[i]!] as const;
      mesh.quad(...quad, colour(band, i), facing(quad), bone);
    }
  }
  for (const [band, ring, open] of [
    [-1, rings[0]!, solid.open?.[0]],
    [rings.length - 1, rings.at(-1)!, solid.open?.[1]],
  ] as const) {
    if (open) continue;
    const hint = facing(ring);
    for (let i = 1; i + 1 < ring.length; i++) {
      mesh.triangle(ring[0]!, ring[i]!, ring[i + 1]!, colour(band, -1), hint, bone);
    }
  }
}

const mirrorRing = (ring: Ring): Ring => ring.map(([x, y, z]): V3 => [-x, y, z]);
const mirror = (s: Solid): Solid => ({
  ...s,
  bone: s.bone.replace('L', 'R') as BoneName,
  rings: s.rings.map(mirrorRing),
  hull: s.hull ? s.hull.map(mirrorRing) : s.hull,
});

/**
 * The figure, in model metres in the bind pose (bones unrotated, pivots as in JOINTS), dressed
 * in an outfit. Each part hangs from the bone whose pivot is above it: thigh and upper arm from
 * hip and shoulder, shin and forearm from knee and elbow, shoe from the ankle.
 */
/** A part on a bone: its colour and cross-sections, then anything else about it. */
const part = (
  bone: BoneName,
  color: number,
  rings: readonly Ring[],
  more?: Partial<Solid>,
): Solid => ({
  bone,
  color,
  rings,
  ...more,
});
/** A level cross-section centred on the body, `w` either side of the middle. */
const across = (y: number, w: number, z0: number, z1: number, bevel: number) =>
  level(y, -w, w, z0, z1, bevel);
const NO_HULL = { hull: false } as const;

/** A colour darkened by `k` (0 to 1): seams, hems and the shadowed side of folds. */
const shade = (hex: number, k: number) =>
  [16, 8, 0].reduce((sum, at) => sum + (Math.round(((hex >> at) & 255) * k) << at), 0);
/**
 * The sneakers' sole, a few shades lighter than the upper. The figure's details take their
 * colours from the palette's own (the belt from wood, the buckle from the signs' brass, the
 * buttons from the plates' paper), so walking adds nothing to the palette the map loads.
 */
export const SOLE_COLOR = shade(WALKER.sneakers, 2.4);

/**
 * The forearm and hand, from the fingertips up to the elbow inside the sleeve: a mitten, thin
 * across and broad front to back, its middle where the rider's grip is (limb.ts's FOREARM).
 */
const HAND = [
  level(0.735, 0.258, 0.292, -0.042, 0.05),
  level(0.86, 0.25, 0.302, -0.056, 0.062),
  level(0.9, 0.248, 0.302, -0.042, 0.042),
  level(1.13, 0.24, 0.31, -0.05, 0.05),
];

/** The shirt's cross-sections from the belt up, and the one tucked into it. */
const SHIRT = [
  across(0.93, 0.2, -0.128, 0.13, 0.05),
  across(1.08, 0.232, -0.145, 0.148, 0.07),
  across(1.36, 0.245, -0.14, 0.145, 0.08),
  across(1.43, 0.17, -0.115, 0.14, 0.06),
];
const SHIRT_TUCK = across(0.84, 0.19, -0.12, 0.12, 0.05);
/** How far forward the front of the shirt is at height `y`, between its cross-sections. */
function shirtFront(y: number): number {
  const i = Math.max(0, SHIRT.findIndex((ring) => ring[0]![1] > y) - 1);
  const [a, b] = [SHIRT[i]![0]!, SHIRT[i + 1]![0]!];
  return a[2] + ((b[2] - a[2]) * (y - a[1])) / (b[1] - a[1]);
}

/**
 * A detail too small to outline (an eye, a button, a seam): a flat triangle or quad on a bone,
 * facing `normal`, a few millimetres proud of the part under it.
 */
interface Flat {
  bone: BoneName;
  color: number;
  points: readonly V3[];
  normal: V3;
}

/** A flat rectangle facing forward, from `x0` to `x1` and `y0` to `y1`, at `z0` below, `z1` above. */
const front = (
  bone: BoneName,
  color: number,
  [x0, x1, y0, y1]: readonly number[],
  z0: number,
  z1 = z0,
): Flat => ({
  bone,
  color,
  points: [
    [x0!, y0!, z0],
    [x1!, y0!, z0],
    [x1!, y1!, z1],
    [x0!, y1!, z1],
  ],
  normal: [0, 0, 1],
});
/** A rectangle on the front of the shirt, following its slope. */
const onShirt = (color: number, x0: number, x1: number, y0: number, y1: number, proud = 0.004) =>
  front('torso', color, [x0, x1, y0, y1], shirtFront(y0) + proud, shirtFront(y1) + proud);
const mirrorFlat = (f: Flat): Flat => ({
  bone: f.bone.replace('L', 'R') as BoneName,
  color: f.color,
  points: f.points.map(([x, y, z]): V3 => [-x, y, z]),
  normal: [-f.normal[0], f.normal[1], f.normal[2]],
});

/** The figure's flat details: the shirt's front, the belt's buckle, the seams, the face. */
export function details(outfit: Outfit): Flat[] {
  const placket = shade(outfit.shirt, 0.82);
  // The nose: a little wedge out of the face, its three faces shaded apart by the light.
  const [top, left, right, tip]: V3[] = [
    [0, 1.64, 0.181],
    [-0.022, 1.585, 0.173],
    [0.022, 1.585, 0.173],
    [0, 1.594, 0.212],
  ];
  const nose = (
    [
      [top, left, tip, [-1, 0.2, 0.6]],
      [top, tip, right, [1, 0.2, 0.6]],
      [left, right, tip, [0, -1, 0.3]],
    ] as V3[][]
  ).map(([a, b, c, normal]): Flat => ({
    bone: 'head',
    color: WALKER.skin,
    points: [a!, b!, c!],
    normal: normal!,
  }));
  // A seam down the outside of each leg of the shorts.
  const seam: Flat = {
    bone: 'legL',
    color: shade(outfit.shorts, 0.78),
    points: [
      [0.191, 0.55, -0.007],
      [0.191, 0.55, 0.007],
      [0.183, 0.86, 0.007],
      [0.183, 0.86, -0.007],
    ],
    normal: [1, 0, 0],
  };
  const lapel: Flat = {
    bone: 'torso',
    color: shade(outfit.shirt, 0.92),
    points: [
      [0.07, 1.43, shirtFront(1.43) + 0.005],
      [0.035, 1.35, shirtFront(1.35) + 0.005],
      [0.13, 1.395, shirtFront(1.395) + 0.005],
    ],
    normal: [0, 0.3, 1],
  };
  return [
    seam,
    mirrorFlat(seam),
    lapel,
    mirrorFlat(lapel),
    // The open collar: a V of skin down the front of the shirt, to the top button.
    {
      bone: 'torso',
      color: WALKER.skin,
      points: [
        [-0.07, 1.43, 0.144],
        [0, 1.27, 0.15],
        [0.07, 1.43, 0.144],
      ],
      normal: [0, 0, 1],
    },
    // The button placket and its buttons, and a pocket over the heart.
    onShirt(placket, -0.016, 0.016, 0.93, 1.08),
    onShirt(placket, -0.016, 0.016, 1.08, 1.27),
    ...[1.0, 1.12, 1.22].map((y) =>
      onShirt(PLATE.paper, -0.012, 0.012, y - 0.012, y + 0.012, 0.007),
    ),
    onShirt(shade(outfit.shirt, 0.9), 0.06, 0.16, 1.08, 1.19),
    onShirt(placket, 0.06, 0.16, 1.19, 1.205),
    front('hips', PROPS.sign, [-0.026, 0.026, 0.874, 0.921], 0.142),
    // The face: eyes with a glint, brows, a nose and a small mouth.
    ...[0.055, -0.11].flatMap((x) => [
      front('head', OUTLINE, [x, x + 0.055, 1.6, 1.67], 0.186, 0.192),
      front('head', PLATE.paper, [x + 0.03, x + 0.046, 1.645, 1.661], 0.193),
      front('head', outfit.hair, [x - 0.008, x + 0.063, 1.692, 1.712], 0.196),
    ]),
    ...nose,
    front('head', shade(WALKER.skin, 0.62), [-0.032, 0.032, 1.545, 1.558], 0.172),
    // A fringe of three locks over the forehead, from the front of the hair.
    ...[-0.1, -0.02, 0.06].map((x): Flat => ({
      bone: 'head',
      color: outfit.hair,
      points: [
        [x - 0.045, 1.758, 0.202],
        [x + 0.045, 1.758, 0.202],
        [x + 0.012, 1.712, 0.199],
      ],
      normal: [0, 0, 1],
    })),
  ];
}

export function figure(outfit: Outfit): Solid[] {
  const leg = [
    // Shorts to the knee, a little loose, with a turned-up cuff at the hem.
    part(
      'legL',
      outfit.shorts,
      [
        level(0.5, 0.008, 0.192, -0.093, 0.093),
        level(0.55, 0.012, 0.188, -0.09, 0.09),
        level(0.86, 0.02, 0.18, -0.085, 0.085),
      ],
      { paint: (band) => (band ? outfit.shorts : shade(outfit.shorts, 0.9)) },
    ),
    // A bare shin, its top round the knee inside the shorts, so a bent leg stays one piece.
    part('shinL', WALKER.skin, [
      level(0.13, 0.05, 0.15, -0.055, 0.055),
      level(0.53, 0.03, 0.17, -0.072, 0.072),
    ]),
    // A sneaker that slopes down to the toe, springing up from the ball of the foot: a dark upper
    // with a padded collar at the ankle, on a paler sole a little wider all round, so its edge
    // shows on dark cobbles. One ink hull goes round both.
    part(
      'footL',
      SOLE_COLOR,
      profile(
        [
          [-0.1, 0],
          [0.12, 0],
          [0.175, 0.035],
          [0.172, 0.05],
          [-0.1, 0.045],
        ],
        0.022,
        0.178,
      ),
      {
        hull: profile(
          [
            [-0.105, 0],
            [0.125, 0],
            [0.2, 0.04],
            [0.2, 0.095],
            [0.05, 0.14],
            [-0.097, 0.162],
          ],
          0.02,
          0.18,
        ),
      },
    ),
    part(
      'footL',
      WALKER.sneakers,
      profile(
        [
          [-0.092, 0.04],
          [0.165, 0.045],
          [0.162, 0.095],
          [0.05, 0.135],
          [-0.02, 0.158],
          [-0.092, 0.158],
        ],
        0.03,
        0.17,
      ),
      NO_HULL,
    ),
  ];
  const arm = [
    // A short, loose sleeve with a hem, then a bare forearm and hand.
    part(
      'armL',
      outfit.shirt,
      [
        level(1.1, 0.198, 0.352, -0.092, 0.092),
        level(1.15, 0.2, 0.35, -0.09, 0.09),
        level(1.38, 0.21, 0.335, -0.08, 0.08),
      ],
      { paint: (band) => (band ? outfit.shirt : shade(outfit.shirt, 0.85)) },
    ),
    // The forearm narrows to the wrist; the hand is a mitten, flat to the thigh, and a thumb.
    part('foreL', WALKER.skin, HAND, { hull: [HAND[0]!, HAND[1]!, HAND[3]!], open: [false, true] }),
    part('foreL', WALKER.skin, box([0.243, 0.8, 0.045], [0.266, 0.865, 0.08]), {
      ...NO_HULL,
      open: [false, true],
    }),
  ];
  const ear = part('head', WALKER.skin, box([0.196, 1.6, -0.02], [0.232, 1.7, 0.035]), {
    ...NO_HULL,
    open: [true, false],
  });
  return [
    ...leg,
    ...leg.map(mirror),
    // The seat of the shorts, belted, the shirt tucked in. It narrows between the thighs, so the
    // bottom of its ink hull, seen edge on from the side, stays inside them as they swing.
    part(
      'hips',
      outfit.shorts,
      [level(0.7, -0.15, 0.15, -0.1, 0.1), across(0.92, 0.2, -0.125, 0.125, 0)],
      {
        open: [false, true],
      },
    ),
    part(
      'hips',
      shade(PROPS.wood, 0.6),
      [0.87, 0.925].map((y) => across(y, 0.212, -0.137, 0.137, 0.03)),
      { ...NO_HULL, open: [true, true] },
    ),
    // The shirt, worn loose: bloused over the belt, broad at the shoulders and sloping to the
    // neck. Its lowest ring is hidden in the belt, so its outline starts above it.
    part('torso', outfit.shirt, [SHIRT_TUCK, ...SHIRT], { hull: SHIRT, open: [true, false] }),
    part('torso', WALKER.skin, box([-0.07, 1.34, -0.065], [0.07, 1.53, 0.065]), {
      ...NO_HULL,
      open: [true, true],
    }),
    // The collar stands round the neck, open at the front.
    part(
      'torso',
      outfit.shirt,
      [across(1.41, 0.115, -0.105, 0.135, 0.04), across(1.475, 0.09, -0.085, 0.105, 0.035)],
      {
        ...NO_HULL,
        open: [true, true],
        paint: (_band, side) => (side === FRONT ? WALKER.skin : shade(outfit.shirt, 0.92)),
      },
    ),
    ...arm,
    ...arm.map(mirror),
    // The head: an octagon, broader at the cheeks, bevelled to the crown, with ears; hair at the
    // back down to the nape.
    part(
      'head',
      WALKER.skin,
      [
        across(1.5, 0.16, -0.15, 0.16, 0.06),
        across(1.7, 0.2, -0.19, 0.19, 0.07),
        across(1.79, 0.205, -0.195, 0.195, 0.075),
        across(1.86, 0.15, -0.145, 0.145, 0.07),
      ],
      {
        paint: (band: number, side: number) =>
          band >= 2 || (band === 1 && side !== FRONT) || (band === 0 && BACK.has(side))
            ? outfit.hair
            : WALKER.skin,
      },
    ),
    ear,
    mirror(ear),
    // A mop of hair over the crown, swept forward into a quiff above the fringe.
    part(
      'head',
      outfit.hair,
      [
        across(1.755, 0.213, -0.203, 0.2, 0.08),
        across(1.88, 0.19, -0.185, 0.19, 0.085),
        across(1.96, 0.12, -0.11, 0.17, 0.06),
      ],
      { open: [true, false] },
    ),
  ];
}

/** A flat octagon under the feet, in model metres: the blob shadow. */
function addBlob(mesh: MeshBuilder, radius = 0.42): void {
  const at = (i: number): V3 => [
    Math.cos((i * Math.PI) / 4) * radius,
    0.02,
    Math.sin((i * Math.PI) / 4) * radius * 0.8,
  ];
  for (let i = 1; i < 7; i++) mesh.triangle(at(0), at(i), at(i + 1), OUTLINE, [0, 1, 0], -1);
}

/**
 * The figure's geometry with one bone per vertex: its parts, their outline hulls, and the
 * blob shadow on the root. The builder's spare `facade` value carries each vertex's bone, -1
 * for the shadow, which a `dither` attribute marks for the material to draw as a checkerboard
 * of pixels: see-through without blending, so it costs no extra draw call.
 */
export function characterGeometry(outfit: Outfit = WALKER): BufferGeometry {
  const mesh = new MeshBuilder();
  for (const solid of figure(outfit)) {
    addSolid(mesh, solid, solid.rings, false);
    if (solid.hull !== false) {
      addSolid(mesh, solid, grown(solid.hull ?? solid.rings, OUTLINE_WIDTH), true);
    }
  }
  for (const { bone, color, points, normal } of details(outfit)) {
    const [a, b, c, d] = points as [V3, V3, V3, V3?];
    if (d) mesh.quad(a, b, c, d, color, normal, BONES.indexOf(bone));
    else mesh.triangle(a, b, c, color, normal, BONES.indexOf(bone));
  }
  addBlob(mesh);
  const geometry = mesh.build({ facade: true });
  const bones = geometry.getAttribute('facade');
  const n = bones.count;
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  const dither = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const bone = bones.getX(i);
    skinIndex[i * 4] = Math.max(0, bone);
    skinWeight[i * 4] = 1;
    dither[i] = bone < 0 ? 1 : 0;
  }
  geometry.deleteAttribute('facade');
  // The figure keeps its arrays once on the GPU, unlike the city: a skinned mesh reads them for
  // its bounds, and a lost context needs them again.
  for (const a of [geometry.index!, ...Object.values(geometry.attributes)]) {
    ('data' in a ? a.data : a).onUploadCallback = () => {};
  }
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new BufferAttribute(skinWeight, 4));
  geometry.setAttribute('dither', new BufferAttribute(dither, 1));
  return geometry;
}

export interface Character {
  mesh: SkinnedMesh;
  /** The same figure drawn only where the city hides it, as a see-through silhouette. */
  xray: SkinnedMesh;
  bones: Record<BoneName, Bone>;
}

/**
 * The figure, bound to its skeleton, and its x-ray twin sharing that skeleton. The twin draws
 * after the city but before the figure, wherever something stands in front: two draw calls.
 */
export function createCharacter(
  body: Material,
  xray: Material,
  outfit: Outfit = WALKER,
): Character {
  const bones = Object.fromEntries(BONES.map((name) => [name, new Bone()])) as Record<
    BoneName,
    Bone
  >;
  for (const name of BONES) {
    const [parent, x, y, z] = JOINTS[name];
    bones[name].name = name;
    // Undoing the body's roll before their own swing keeps the legs plumb (see applyPose).
    if (name === 'legL' || name === 'legR') bones[name].rotation.order = 'ZYX';
    bones[name].position.set(x, y, z);
    if (parent) bones[parent].add(bones[name]);
  }
  const geometry = characterGeometry(outfit);
  const mesh = new SkinnedMesh(geometry, body);
  mesh.add(bones.root);
  mesh.bind(new Skeleton(BONES.map((name) => bones[name])));
  const twin = new SkinnedMesh(geometry, xray);
  mesh.add(twin);
  twin.bind(mesh.skeleton, mesh.bindMatrix);
  twin.renderOrder = 1;
  mesh.renderOrder = 2;
  // It moves every frame and is always on screen while walking: skip the bounds checks.
  mesh.traverse((object) => (object.frustumCulled = false));
  // It darkens in the static shade of the houses it passes, though it casts none itself.
  mesh.receiveShadow = true;
  return { mesh, xray: twin, bones };
}

export interface Pose {
  /** Hip height above the ground, and how far forward of the root they sit (model metres). */
  hips: number;
  hipsZ: number;
  /**
   * Roll of the body about its forward axis (radians, positive lifts the left hip). The legs
   * hang plumb whatever the roll, so feet stay put on pedals or the ground.
   */
  roll: number;
  /** Forward lean of the torso, its twist with each stride, and its bank into a turn (radians). */
  lean: number;
  twist: number;
  bank: number;
  /** Swing of each thigh (negative is forward) and bend of each knee (positive folds the shin back). */
  legL: number;
  legR: number;
  kneeL: number;
  kneeR: number;
  /** Each foot's turn at the ankle (positive points the toes down). */
  footL: number;
  footR: number;
  /** Swing of each arm (positive is back), and the bend of each elbow (negative folds forward). */
  armL: number;
  armR: number;
  elbowL: number;
  elbowR: number;
  /** Head nod and turn. */
  nod: number;
  look: number;
}

/** How far out from the body the arms hang (radians). */
const ARM_SPREAD = 0.07;
/** Elbows hang a little bent, as arms do. */
const REST_ELBOW = -0.12;
/** The furthest the head turns toward where the camera looks (radians). */
const LOOK_LIMIT = 1.1;
/** The longest a leg stretches, hip to ankle: never quite straight, so the knee never snaps. */
const REACH = THIGH + SHIN - 0.004;
/**
 * How the gait changes from a walk (first) to a run (second), in model metres and radians: the
 * share of a cycle each foot is down (under a half is a run, with both feet off the ground in
 * between), how high a foot lifts, the hips' height and their bounce, where under the hips the
 * steps centre, how far the heel lifts before the toes push off, and the lean.
 */
const DUTY = [0.52, 0.2] as const;
const LIFT = [0.09, 0.3] as const;
const HIPS = [0.73, 0.62] as const;
const CENTRE = [0.07, 0] as const;
const TOES = [0.45, 0.45] as const;
/** How much of its swing a foot takes to let go of the hips: slowly walking, at once running. */
const RELEASE = [0.5, 0.1] as const;
const LEAN = [0.07, 0.24] as const;
/** How far the arms swing either way, and the shoulders twist with them, walking and running. */
const ARMS = [0.55, 0.8] as const;
const TWIST = [0.2, 0.12] as const;
/** The hips turn against the shoulders by this share of the torso's twist (see applyPose). */
const PELVIS = 0.5;
/** A walk's hips dip on the side of the foot in the air (radians of roll). */
const SWAY = 0.05;
/** The most the legs' reach pulls the hips below where they ride (model metres). */
const DIP = 0.12;
/** Below this speed (m/s) steps shorten toward standing still. */
const STEPPING = 1.5;
/** Turning on the spot: a full cycle of two steps for each quarter turn. */
const TURN_STEPS = 4;
/** Starting and stopping: the acceleration (m/s²) that leans the body most of its furthest. */
const SURGE = 20;
const SURGE_LEAN = 0.2;
const SURGE_HIPS = 0.06;

const lerp = (pair: readonly [number, number], t: number) => pair[0] + (pair[1] - pair[0]) * t;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smoothstep = (x: number) => clamp01(x) ** 2 * (3 - 2 * clamp01(x));
/** A minimum that rounds the corner where `a` and `b` cross, within `k` of each other. */
const softMin = (a: number, b: number, k: number) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * k) / 4;
};
/** Up from 0 to 1 and back between `from` and `to`, easing in and out at both ends. */
const bump = (t: number, from: number, to: number) =>
  Math.sin(Math.PI * clamp01((t - from) / (to - from))) ** 2;
/** The fraction of the way through a cycle of length `n`, from `start`. */
const cycle = (p: number, start: number, n = 1) => (((p - start) % n) + n) % n;

/** The gait at this speed: a walk's and a run's, blended (see DUTY and below). */
const gait = { sweep: 0, duty: 0, centre: 0, lift: 0, toes: 0, release: 0 };

/** Where a foot is: its ankle forward of the root and above the ground, and its pitch. */
interface Foot {
  z: number;
  y: number;
  pitch: number;
  /** How far it lets go of the hips (0 to 1): not at all while down, wholly mid-swing. */
  free: number;
}

/**
 * How high the ankle is above the ground with the foot on the ball of its foot, pitched toes down
 * (or flat): as high as it must be for no part of the sole to dip below the ground, since the
 * toe springs up from the ball further than the toes ever point down.
 */
const clearance = (pitch: number) => BALL * Math.sin(pitch) + ANKLE * Math.cos(pitch);

/**
 * A foot through one gait cycle, `q` from 0 to 1 starting as it lands. While down it slides back
 * under the body exactly as fast as the body moves on, so it stays where it landed: flat, then
 * rolling up onto the ball of the foot. Then it lifts and swings forward to land again, leaving
 * and arriving at the speed it had on the ground, so it neither scuffs off nor skids in.
 */
function footAt(out: Foot, q: number): Foot {
  const { sweep, duty, centre, lift, toes } = gait;
  // Down, the ball of the foot slides back, and the heel lifts as it rolls over it.
  const u = Math.min(1, q / duty);
  const pitch = toes * smoothstep((u - 0.55) / 0.45);
  out.z = centre + sweep * (0.5 - u) - BALL * Math.cos(pitch) + ANKLE * Math.sin(pitch);
  out.y = clearance(pitch);
  out.pitch = pitch;
  out.free = 0;
  if (q < duty) return out;
  // Up, it swings from where it left the ground to where it lands next.
  const s = (q - duty) / (1 - duty);
  const [z0, y0] = [out.z, out.y];
  const z1 = centre + sweep / 2 - BALL;
  // A Hermite curve from lift-off to landing, leaving and arriving at most of the speed the foot
  // had on the ground: all of it would swing it far back first, out of reach.
  const m = (-0.6 * sweep * (1 - duty)) / duty;
  const s2 = s * s;
  const s3 = s2 * s;
  out.z = z0 + (z1 - z0) * (3 * s2 - 2 * s3) + m * (s - 3 * s2 + 2 * s3);
  out.pitch = toes * (1 - s) ** 2;
  // Highest early in the swing, the heel kicking up behind.
  const y = y0 + (ANKLE - y0) * s + lift * Math.sin(Math.PI * s ** 0.65);
  out.y = Math.max(y, clearance(out.pitch));
  // It lets go of the hips gradually after lifting off, and takes hold again before landing, so
  // the hips rise and sink rather than jump as feet come and go.
  out.free = smoothstep(s / gait.release) * smoothstep((1 - s) / 0.6);
  return out;
}

const footL: Foot = { z: 0, y: 0, pitch: 0, free: 0 };
const footR: Foot = { z: 0, y: 0, pitch: 0, free: 0 };
const limb: Limb = { root: 0, joint: 0 };

/**
 * The highest the hips can be with the ankle at `foot` still in reach. A foot well off the ground
 * doesn't hold them down: out of reach, it just stops short, higher up.
 */
function reachAbove(foot: Foot, hipZ: number): number {
  const off = 0.5 * foot.free ** 2;
  return foot.y + Math.sqrt(Math.max(0, REACH * REACH - (foot.z - hipZ) ** 2)) + off;
}

/** Seconds the idle plays (walker.ts); its breaths, its glance about and its weight shift. */
const BREATH = IDLE_SECONDS / 3;
const GLANCE = [1, 2.8] as const;
const SHIFT = [2.4, 6.2] as const;
/** How far the hips drop onto one leg as the weight shifts (radians of roll). */
const SHIFT_ROLL = 0.11;

/**
 * How far the knees give on landing (1 at the deepest), `settle` of the way from the feet
 * touching down (0) to standing settled (1): a quick dip and a small rebound, gone by the end.
 */
export function landing(settle: number): number {
  const s = clamp01(settle);
  return 1.8 * (1 - s) ** 3 * Math.sin(2.5 * Math.PI * s);
}

/**
 * The pose for a moment of walking, running or standing, written into `out` (no allocation per
 * frame). Feet first: each foot goes where the gait cycle puts it (`phase`, which the walker turns
 * at its stride's pace), and the legs reach for them by IK, so a foot on the ground stays where it
 * landed. The hips ride as high as both legs allow, which bobs a walk, and dip on the side of the
 * foot in the air; a run sinks onto each step and springs off it into a moment with both feet in
 * the air. Arms swing against the legs, the forward one bending at the elbow, and the shoulders
 * twist with them while the hips turn the other way. Speeding up (`accel`, m/s²) leans the body
 * in and carries the hips ahead of the feet; slowing down leans it back, and stopped it rocks
 * forward and back once, the head nodding after it. Standing, it steps on the spot as it turns
 * (`turning`, rad/s, the steps keeping time with its `heading`), its head leading the way. The
 * torso banks into turns and the head turns toward `look` (radians from straight ahead).
 * Stopped, for IDLE_SECONDS it breathes, glances about and shifts its weight onto one leg and
 * back, and then stands still. With `idle` false (reduced motion) none of that, only the steps.
 *
 * `settle` lands the figure, as when it is set down into walk mode: from 0, the moment its feet
 * touch the ground, to 1 (the default), settled. The knees give and the arms come forward, then
 * it straightens with a small rebound (`landing`). The feet stay planted throughout.
 */
export function poseAt(
  out: Pose,
  speed: number,
  phase: number,
  still: number,
  idle: boolean,
  turning = 0,
  look = 0,
  accel = 0,
  heading = 0,
  settle = 1,
): Pose {
  const run = runBlend(speed);
  const step = smoothstep(speed / STEPPING);
  const duty = lerp(DUTY, run);
  const stride = (STRIDE_WALK + (STRIDE_RUN - STRIDE_WALK) * run) / CHARACTER_SCALE;
  gait.duty = duty;
  gait.sweep = duty * stride;
  gait.centre = lerp(CENTRE, run);
  gait.lift = lerp(LIFT, run);
  gait.toes = lerp(TOES, run);
  gait.release = lerp(RELEASE, run);
  const p = phase / (Math.PI * 2);
  // The left foot lands a quarter of the way through the cycle, the right at three quarters, as
  // the footsteps sound.
  footAt(footL, cycle(p, 0.25));
  footAt(footR, cycle(p, 0.75));
  // Standing, the feet come together under the hips, lifting in turn if it turns on the spot.
  const turn = idle ? (1 - step) * clamp01(Math.abs(turning) / 2.5) : 0;
  const pivot = heading * TURN_STEPS;
  for (const [foot, side] of [
    [footL, 0],
    [footR, Math.PI],
  ] as const) {
    foot.z *= step;
    foot.y = ANKLE + (foot.y - ANKLE) * step + 0.07 * turn * Math.max(0, Math.sin(pivot + side));
    foot.pitch *= step;
    foot.free *= step;
  }

  // Standing still: breathing, a glance and a weight shift, faded in and out over the idle, and
  // not while turning on the spot. Which way it glances and leans goes by where it faces.
  const idling = idle && speed === 0 && still < IDLE_SECONDS;
  const fade = idling
    ? smoothstep(still / 0.6) * smoothstep((IDLE_SECONDS - still) / 1.2) * (1 - turn)
    : 0;
  const breath = idling ? fade * (0.5 - 0.5 * Math.cos((2 * Math.PI * still) / BREATH)) : 0;
  const side = Math.cos(heading * 3) < 0 ? -1 : 1;
  const shift = idling ? side * bump(still, ...SHIFT) * (1 - turn) : 0;
  // Stopping (or set down), the body rocks on forward and back once, then is still.
  const rock = idling ? Math.exp(-6 * still) * Math.sin(11 * still) : 0;
  const land = landing(settle);

  // Eased by the walker (its `surge`), so it carries on a moment after stopping.
  const surge = idle ? Math.tanh(accel / SURGE) : 0;
  out.hipsZ = SURGE_HIPS * surge;
  // A walk's hips dip on the side of the swinging foot; standing, they drop onto one leg.
  out.roll = -SWAY * step * (1 - run) * Math.cos(phase) + SHIFT_ROLL * shift;
  const swing = Math.sin(phase);
  out.twist = lerp(TWIST, run) * step * swing;
  // The hips turn against the shoulders (see applyPose), which moves each hip joint a little.
  const pelvis = -PELVIS * out.twist;
  // A run sinks onto each step and springs off it, highest midway between steps; a walk's bob
  // comes from the legs' reach alone.
  const q = cycle(p, 0.25, 0.5);
  const bounce = 0.035 * run;
  const flight = 0.5 - duty;
  let hips = lerp(HIPS, run);
  if (q < duty) hips -= bounce * Math.sin((Math.PI * q) / duty);
  else if (flight > 0)
    hips += ((bounce * flight) / duty) * Math.sin((Math.PI * (q - duty)) / flight);
  hips = REST_HIPS + (hips - REST_HIPS) * step - 0.14 * land;
  const hipY = HIP_X * Math.sin(out.roll);
  const hipZ = HIP_X * Math.cos(out.roll) * Math.sin(pelvis);
  // Never more than DIP below where they ride: speeding up, the stride lengthens faster than a
  // swinging foot comes down, and reaching all the way for it would drop the hips in a step.
  const floor = hips - DIP;
  hips = softMin(hips, Math.max(floor, reachAbove(footL, out.hipsZ - hipZ) - hipY), 0.04);
  out.hips = softMin(hips, Math.max(floor, reachAbove(footR, out.hipsZ + hipZ) + hipY), 0.04);
  for (const [foot, x] of [
    [footL, 1],
    [footR, -1],
  ] as const) {
    limbIK(limb, foot.z - out.hipsZ + x * hipZ, foot.y - out.hips - x * hipY, THIGH, SHIN, 1);
    const ankle = foot.pitch - limb.root - limb.joint;
    if (x > 0) [out.legL, out.kneeL, out.footL] = [limb.root, limb.joint, ankle];
    else [out.legR, out.kneeR, out.footR] = [limb.root, limb.joint, ankle];
  }

  const arms = lerp(ARMS, run) * step * swing;
  // A run pumps the arms mostly behind the body; landing, they come forward for balance.
  out.armL = 0.3 * run + arms - 0.3 * land;
  out.armR = 0.3 * run - arms - 0.3 * land;
  // A run holds the elbows bent; walking, the arm swinging forward bends a little more.
  const elbow = REST_ELBOW - 0.2 * step - 1.05 * run - 0.06 * breath - 0.5 * land;
  const reach = 0.35 * step * (1 - run);
  out.elbowL = elbow - reach * Math.max(0, -swing);
  out.elbowR = elbow - reach * Math.max(0, swing);
  // Breathing in lifts the chest a little; landing folds the body over the knees.
  out.lean =
    lerp(LEAN, run) * step + SURGE_LEAN * surge - 0.025 * breath + 0.05 * rock + 0.3 * land;
  // The shoulders level against the hips' roll, standing or walking, and bank into turns.
  out.bank = Math.max(-0.3, Math.min(0.3, (-0.12 * turning * speed) / WALK_SPEED)) - 1.3 * out.roll;
  // The head stays level as the body leans and nods after it as it rocks to a stop.
  out.nod = -0.6 * out.lean + 0.02 * breath + 0.12 * rock - 0.15 * land;
  // It leads a turn on the spot, and glances aside a moment while standing.
  const lead = idle ? (1 - step) * Math.max(-0.4, Math.min(0.4, 0.15 * turning)) : 0;
  const glance = idling ? 0.55 * side * bump(still, ...GLANCE) * (1 - turn) : 0;
  out.look = Math.max(-LOOK_LIMIT, Math.min(LOOK_LIMIT, look + lead + glance));
  return out;
}

/** The figure standing at rest, as `poseAt` stands it. */
export function restPose(): Pose {
  const pose = {} as Pose;
  return poseAt(pose, 0, 0, Infinity, false);
}

/**
 * Puts the figure in a pose. The hips turn against the torso's twist by PELVIS of it, so the
 * shoulders turn by `twist` and the hips the other way, as a walk counter-rotates them; a pose
 * without twist (the rider's) keeps the hips square.
 */
export function applyPose({ bones }: Character, pose: Pose): void {
  const pelvis = -PELVIS * pose.twist;
  bones.hips.position.set(0, pose.hips, pose.hipsZ);
  bones.hips.rotation.set(0, pelvis, pose.roll);
  bones.torso.rotation.set(pose.lean, pose.twist - pelvis, pose.bank);
  bones.head.rotation.set(pose.nod, pose.look - pose.twist, 0);
  // The legs undo the hips' roll and turn first (they turn Z, then Y, then X), so they swing in
  // the root's plane.
  bones.legL.rotation.set(pose.legL, -pelvis, -pose.roll);
  bones.legR.rotation.set(pose.legR, -pelvis, -pose.roll);
  bones.shinL.rotation.x = pose.kneeL;
  bones.shinR.rotation.x = pose.kneeR;
  bones.footL.rotation.x = pose.footL;
  bones.footR.rotation.x = pose.footR;
  // The arms hang a little out from the body, so the hands clear the shirt's hem.
  bones.armL.rotation.set(pose.armL, 0, ARM_SPREAD);
  bones.armR.rotation.set(pose.armR, 0, -ARM_SPREAD);
  bones.foreL.rotation.x = pose.elbowL;
  bones.foreR.rotation.x = pose.elbowR;
}
