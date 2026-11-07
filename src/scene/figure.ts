import { SHIN, THIGH } from './limb.ts';
import type { MeshBuilder, V3 } from './mesh-builder.ts';
import { OUTLINE, PLATE, PROPS, WALKER } from './palette.ts';

/**
 * The figure's shape: a Leuven student in a shirt and shorts, a few chunky blocks on a
 * fourteen-bone skeleton (knees, elbows and ankles, so they can run and keep their soles
 * flat), as parts lofted through cross-sections, each on a bone, with the flat details on
 * them and the ink hull round each. Pure data and geometry, no three.js: the walker builds
 * its skinned mesh from it (character.ts) and the bikes their instanced riders (rider.ts), so
 * the one figure is everyone on the streets, on foot and on a bike.
 */

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
export const ANKLE = 0.09;
/** The hips' height standing straight. */
export const REST_HIPS = THIGH + SHIN + ANKLE;
/** The ball of the foot, where it rolls onto its toes, ahead of the ankle (model metres). */
export const BALL = 0.12;
/** The hip joints either side of the middle (model metres). */
export const HIP_X = 0.1;

/**
 * Each bone's parent (none for the root) and its pivot relative to that parent, in model metres
 * (y up, facing +z).
 */
export const JOINTS: Record<BoneName, readonly [BoneName | '', number, number, number]> = {
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
export type Ring = readonly V3[];

/**
 * A convex part of the figure, lofted through cross-sections (`rings`, each with the same number
 * of corners) and capped at both ends, on one bone. Faces take `color`, or what `paint` gives a
 * side face (`band` counts the gaps between rings from the first, `side` the corners round them)
 * or a cap (band -1 for the first, `rings.length - 1` for the last). Its ink hull follows `hull`
 * if given (fewer or larger rings), its own rings if not, or none for small parts (`false`).
 * An end always hidden inside another part is left open (`open`: first, last).
 */
export interface Solid {
  bone: BoneName;
  rings: readonly Ring[];
  color: number;
  paint?: (band: number, side: number) => number;
  hull?: readonly Ring[] | false;
  open?: readonly [boolean, boolean];
}

/** The walker's clothes, skin and hair: each player picks their own. */
export interface Outfit {
  shirt: number;
  shorts: number;
  hair: number;
  skin: number;
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

/** Where a figure drawn elsewhere than the walker puts its points and what its faces carry. */
export interface SolidFrame {
  /** Where a model point goes (as it is, by default). */
  place?: (p: V3) => V3;
  /** The facade value a face writes, from its bone and its colour (the bone, by default). */
  facade?: (bone: number, color: number) => number;
  /** The colour a face is written in, from its own (its own, by default). */
  paint?: (color: number) => number;
}

type Builder = Pick<MeshBuilder, 'quad' | 'triangle'>;

/**
 * A part's faces, facing out, or in for its hull, which is all ink, marked with its bone, or
 * with what `frame` makes of its bone and colour, placed where it says.
 */
export function addSolid(
  mesh: Builder,
  solid: Solid,
  rings: readonly Ring[],
  hull: boolean,
  frame: SolidFrame = {},
): void {
  const place = frame.place ?? ((p: V3) => p);
  const middle = place(centroid(rings.flat()));
  const bone = BONES.indexOf(solid.bone);
  const code = (band: number, side: number) => {
    const color = hull ? OUTLINE : (solid.paint?.(band, side) ?? solid.color);
    const facade = frame.facade ? frame.facade(bone, color) : bone;
    return [frame.paint ? frame.paint(color) : color, facade] as const;
  };
  const facing = (points: readonly V3[]) =>
    centroid(points).map((x, k) => (hull ? middle[k]! - x : x - middle[k]!)) as unknown as V3;
  for (let band = 0; band + 1 < rings.length; band++) {
    const [a, b] = [rings[band]!, rings[band + 1]!];
    for (let i = 0; i < a.length; i++) {
      const j = (i + 1) % a.length;
      const quad = [a[i]!, a[j]!, b[j]!, b[i]!].map(place) as [V3, V3, V3, V3];
      const [color, facade] = code(band, i);
      mesh.quad(...quad, color, facing(quad), facade);
    }
  }
  for (const [band, ring, open] of [
    [-1, rings[0]!, solid.open?.[0]],
    [rings.length - 1, rings.at(-1)!, solid.open?.[1]],
  ] as const) {
    if (open) continue;
    const placed = ring.map(place);
    const hint = facing(placed);
    for (let i = 1; i + 1 < placed.length; i++) {
      const [color, facade] = code(band, -1);
      mesh.triangle(placed[0]!, placed[i]!, placed[i + 1]!, color, hint, facade);
    }
  }
}

/** How far out from the body the arms hang (radians), so the hands clear the shirt's hem. */
export const ARM_SPREAD = 0.07;

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
export const shade = (hex: number, k: number) =>
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
export interface Flat {
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
    color: outfit.skin,
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
      color: outfit.skin,
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
    front('head', shade(outfit.skin, 0.62), [-0.032, 0.032, 1.545, 1.558], 0.172),
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
    part('shinL', outfit.skin, [
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
    part('foreL', outfit.skin, HAND, { hull: [HAND[0]!, HAND[1]!, HAND[3]!], open: [false, true] }),
    part('foreL', outfit.skin, box([0.243, 0.8, 0.045], [0.266, 0.865, 0.08]), {
      ...NO_HULL,
      open: [false, true],
    }),
  ];
  const ear = part('head', outfit.skin, box([0.196, 1.6, -0.02], [0.232, 1.7, 0.035]), {
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
    part('torso', outfit.skin, box([-0.07, 1.34, -0.065], [0.07, 1.53, 0.065]), {
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
        paint: (_band, side) => (side === FRONT ? outfit.skin : shade(outfit.shirt, 0.92)),
      },
    ),
    ...arm,
    ...arm.map(mirror),
    // The head: an octagon, broader at the cheeks, bevelled to the crown, with ears; hair at the
    // back down to the nape.
    part(
      'head',
      outfit.skin,
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
            : outfit.skin,
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
