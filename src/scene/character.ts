import {
  Bone,
  BufferAttribute,
  BufferGeometry,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
} from 'three';
import type { InterleavedBufferAttribute, Material } from 'three';

import { MeshBuilder, padded } from './mesh-builder.ts';
import type { V3 } from './mesh-builder.ts';
import { OUTLINE, WALKER } from './palette.ts';
import { IDLE_SECONDS, STRIDE_RUN, STRIDE_WALK, runBlend } from './walker.ts';

/**
 * The walker: a Leuven student of chunky, bevelled blocks on a fifteen-bone skeleton (knees,
 * elbows and ankles, so they can run and keep their soles flat, and a bone for the scarf's
 * tail), readable from the chase camera. Its ink outline is an inverted hull in the same
 * geometry (each part again, a little larger and facing inward, so only its far side shows round
 * the silhouette), which keeps the whole figure, shadow included, to one draw call.
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
  'scarf',
] as const;
export type BoneName = (typeof BONES)[number];

/** Hip to knee, knee to ankle, and ankle to sole (model metres). */
export const THIGH = 0.37;
export const SHIN = 0.36;
const ANKLE = 0.09;
/** The hips' height standing straight. */
const REST_HIPS = THIGH + SHIN + ANKLE;
/** The ball of the foot, where it rolls onto its toes, ahead of the ankle (model metres). */
const BALL = 0.12;
/** The hip joints either side of the middle (model metres). */
const HIP_X = 0.1;
/** Shoulder to elbow, and elbow to the middle of the hand (model metres). */
export const UPPER_ARM = 0.24;
export const FOREARM = 0.27;

/** Each bone's pivot relative to its parent, in model metres (y up, facing +z). */
const JOINTS: Record<BoneName, { parent: BoneName | null; at: V3 }> = {
  root: { parent: null, at: [0, 0, 0] },
  hips: { parent: 'root', at: [0, REST_HIPS, 0] },
  torso: { parent: 'hips', at: [0, 0, 0] },
  head: { parent: 'torso', at: [0, 0.56, 0] },
  armL: { parent: 'torso', at: [0.27, 0.5, 0] },
  armR: { parent: 'torso', at: [-0.27, 0.5, 0] },
  foreL: { parent: 'armL', at: [0, -0.24, 0] },
  foreR: { parent: 'armR', at: [0, -0.24, 0] },
  legL: { parent: 'hips', at: [HIP_X, 0, 0] },
  legR: { parent: 'hips', at: [-HIP_X, 0, 0] },
  shinL: { parent: 'legL', at: [0, -THIGH, 0] },
  shinR: { parent: 'legR', at: [0, -THIGH, 0] },
  footL: { parent: 'shinL', at: [0, -SHIN, 0] },
  footR: { parent: 'shinR', at: [0, -SHIN, 0] },
  // The scarf's tail hangs from behind the neck.
  scarf: { parent: 'torso', at: [0.075, 0.58, -0.165] },
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

/** The walker's colours that vary from one device to the next; the coat stays accent blue. */
export interface Outfit {
  scarf: number;
  bag: number;
  hair: number;
  trousers: number;
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

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: V3): V3 => {
  const length = Math.hypot(...a) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};
const centroid = (points: readonly V3[]): V3 =>
  points.reduce((sum, p) => add(sum, p, 1 / points.length), [0, 0, 0] as V3);

/**
 * The rings of a part's ink hull: each ring offset outward in its own plane by `width`, mitred
 * at the corners so every side moves out the same, and the end rings pushed out along the part.
 */
export function grown(rings: readonly Ring[], width: number): Ring[] {
  const along = sub(centroid(rings.at(-1)!), centroid(rings[0]!));
  return rings.map((ring, r) => {
    const c = centroid(ring);
    const n = ring.length;
    // The ring's plane (Newell's normal), facing along the part.
    let ends: V3 = [0, 0, 0];
    for (let i = 0; i < n; i++) ends = add(ends, cross(ring[i]!, ring[(i + 1) % n]!));
    ends = unit(ends);
    if (dot(ends, along) < 0) ends = [-ends[0], -ends[1], -ends[2]];
    // Each side's outward normal in the ring's plane: across the side, away from the middle.
    const normals = ring.map((p, i) => {
      const edge = sub(ring[(i + 1) % n]!, p);
      const across = unit(cross(edge, ends));
      return dot(across, sub(p, c)) < 0 ? ([-across[0], -across[1], -across[2]] as V3) : across;
    });
    const shift = r === 0 ? -width : r === rings.length - 1 ? width : 0;
    return ring.map((p, i) => {
      const [a, b] = [normals[(i + n - 1) % n]!, normals[i]!];
      const mitre = unit(add(a, b));
      return add(add(p, mitre, width / Math.max(0.3, dot(mitre, a))), ends, shift);
    });
  });
}

/** A part's faces, facing out, or in for its hull, which is all ink. */
function addSolid(mesh: MeshBuilder, solid: Solid, rings: readonly Ring[], hull: boolean): void {
  const middle = centroid(rings.flat());
  const colour = (band: number, side: number) =>
    hull ? OUTLINE : (solid.paint?.(band, side) ?? solid.color);
  const facing = (points: readonly V3[]): V3 => {
    const out = unit(sub(centroid(points), middle));
    return hull ? [-out[0], -out[1], -out[2]] : out;
  };
  for (let band = 0; band + 1 < rings.length; band++) {
    const [a, b] = [rings[band]!, rings[band + 1]!];
    for (let i = 0; i < a.length; i++) {
      const j = (i + 1) % a.length;
      const quad = [a[i]!, a[j]!, b[j]!, b[i]!] as const;
      mesh.quad(...quad, colour(band, i), facing(quad));
    }
  }
  for (const [band, ring, open] of [
    [-1, rings[0]!, solid.open?.[0]],
    [rings.length - 1, rings.at(-1)!, solid.open?.[1]],
  ] as const) {
    if (open) continue;
    const hint = facing(ring);
    for (let i = 1; i + 1 < ring.length; i++) {
      mesh.triangle(ring[0]!, ring[i]!, ring[i + 1]!, colour(band, -1), hint);
    }
  }
}

/** The face's flat decals: eyes, which need no outline. */
interface Decal {
  bone: BoneName;
  corners: readonly [V3, V3, V3, V3];
  color: number;
}

const mirrorRing = (ring: Ring): Ring => ring.map(([x, y, z]): V3 => [-x, y, z]);
const mirror = (s: Solid): Solid => ({
  ...s,
  bone: s.bone.replace('L', 'R') as BoneName,
  rings: s.rings.map(mirrorRing),
  hull: s.hull ? s.hull.map(mirrorRing) : s.hull,
});

/** An eye: a dot on the face, too small for an outline. */
const eye = (x0: number, x1: number): Decal => ({
  bone: 'head',
  corners: [
    [x0, 1.6, 0.186],
    [x1, 1.6, 0.186],
    [x1, 1.67, 0.192],
    [x0, 1.67, 0.192],
  ],
  color: OUTLINE,
});

/**
 * The figure, in model metres in the bind pose (bones unrotated, pivots as in JOINTS), dressed
 * in an outfit. Each part hangs from the bone whose pivot is above it: thigh and upper arm from
 * hip and shoulder, shin and forearm from knee and elbow, shoe from the ankle.
 */
export function figure(outfit: Outfit): { solids: Solid[]; decals: Decal[] } {
  const leg: Solid[] = [
    {
      bone: 'legL',
      rings: [level(0.47, 0.035, 0.165, -0.07, 0.07), level(0.84, 0.02, 0.18, -0.085, 0.085)],
      color: outfit.trousers,
    },
    // The knee: a block round the joint that turns with the shin, so a bent leg stays one
    // piece instead of two boxes opening a notch.
    {
      bone: 'shinL',
      rings: box([0.03, 0.39, -0.08], [0.17, 0.51, 0.08]),
      color: outfit.trousers,
    },
    {
      bone: 'shinL',
      rings: [level(0.12, 0.04, 0.16, -0.06, 0.065), level(0.42, 0.035, 0.165, -0.07, 0.07)],
      color: outfit.trousers,
    },
    // The shoe: an upper that slopes down to the toe, a pale toe cap and a sole, under one hull
    // that springs up at the toe as the sole does.
    {
      bone: 'footL',
      rings: profile(
        [
          [-0.1, 0.03],
          [0.17, 0.03],
          [0.15, 0.1],
          [-0.09, 0.155],
        ],
        0.025,
        0.175,
      ),
      color: WALKER.shoes,
      hull: profile(
        [
          [-0.105, 0],
          [0.125, 0],
          [0.2, 0.04],
          [0.2, 0.095],
          [-0.095, 0.155],
        ],
        0.02,
        0.18,
      ),
    },
    {
      bone: 'footL',
      rings: box([0.02, 0.04, 0.12], [0.18, 0.1, 0.2]),
      color: WALKER.sole,
      hull: false,
    },
    {
      bone: 'footL',
      rings: box([0.02, 0, -0.105], [0.18, 0.035, 0.12]),
      color: WALKER.sole,
      hull: false,
    },
  ];
  const arm: Solid[] = [
    {
      bone: 'armL',
      rings: [level(1.07, 0.22, 0.33, -0.065, 0.065), level(1.37, 0.215, 0.335, -0.075, 0.075)],
      color: WALKER.coat,
    },
    {
      bone: 'foreL',
      rings: [level(0.86, 0.23, 0.32, -0.058, 0.058), level(1.1, 0.222, 0.328, -0.065, 0.065)],
      color: WALKER.coat,
    },
    // A mitten, knitted to match the scarf, with its thumb forward.
    {
      bone: 'foreL',
      rings: [level(0.73, 0.232, 0.318, -0.06, 0.06), level(0.87, 0.225, 0.325, -0.066, 0.072)],
      color: outfit.scarf,
    },
    {
      bone: 'foreL',
      rings: box([0.245, 0.79, 0.06], [0.3, 0.85, 0.105]),
      color: outfit.scarf,
      hull: false,
    },
  ];
  const strap: Solid = {
    bone: 'torso',
    rings: [level(0.98, 0.075, 0.125, 0.115, 0.15), level(1.37, 0.075, 0.125, 0.12, 0.158)],
    color: outfit.bag,
    hull: false,
  };
  const solids: Solid[] = [
    ...leg,
    ...leg.map(mirror),
    // The coat: broad at the shoulders, in at the waist, its hem flaring out over the hips.
    {
      bone: 'torso',
      rings: [
        level(0.6, -0.25, 0.25, -0.17, 0.17, 0.07),
        level(0.88, -0.2, 0.2, -0.13, 0.13, 0.05),
        level(1.38, -0.24, 0.24, -0.14, 0.14, 0.08),
      ],
      color: WALKER.coat,
      open: [true, false],
    },
    strap,
    mirror(strap),
    {
      bone: 'torso',
      rings: box([-0.16, 0.9, -0.27], [0.16, 1.26, -0.13]),
      color: outfit.bag,
    },
    {
      bone: 'torso',
      rings: [
        level(1.3, -0.19, 0.19, -0.155, 0.15, 0.06),
        level(1.45, -0.18, 0.18, -0.145, 0.14, 0.06),
      ],
      color: outfit.scarf,
      open: [true, false],
    },
    // The scarf's tail, down the back to the top of the bag, on a bone of its own.
    {
      bone: 'scarf',
      rings: box([0.02, 1.15, -0.19], [0.13, 1.4, -0.14]),
      color: outfit.scarf,
    },
    {
      bone: 'torso',
      rings: box([-0.07, 1.42, -0.065], [0.07, 1.53, 0.065]),
      color: WALKER.skin,
      hull: false,
      open: [true, true],
    },
    ...arm,
    ...arm.map(mirror),
    // The head: an octagon, broader at the cheeks, bevelled to the crown; hair at the back and on
    // top, with a fringe above the forehead.
    {
      bone: 'head',
      rings: [
        level(1.5, -0.16, 0.16, -0.15, 0.16, 0.06),
        level(1.7, -0.2, 0.2, -0.19, 0.19, 0.07),
        level(1.79, -0.205, 0.205, -0.195, 0.195, 0.075),
        level(1.9, -0.17, 0.17, -0.165, 0.165, 0.08),
      ],
      color: WALKER.skin,
      paint: (band, side) =>
        band >= 2 || (band === 1 && side !== FRONT) || (band === 0 && BACK.has(side))
          ? outfit.hair
          : WALKER.skin,
      hull: [
        level(1.5, -0.16, 0.16, -0.15, 0.16, 0.06),
        level(1.74, -0.205, 0.205, -0.195, 0.195, 0.075),
        level(1.9, -0.17, 0.17, -0.165, 0.165, 0.08),
      ],
    },
  ];
  return { solids, decals: [eye(0.055, 0.11), eye(-0.11, -0.055)] };
}

/** A flat octagon under the feet, in model metres: the blob shadow. */
function addBlob(mesh: MeshBuilder, radius = 0.42): void {
  const at = (i: number): V3 => [
    Math.cos((i * Math.PI) / 4) * radius,
    0.02,
    Math.sin((i * Math.PI) / 4) * radius * 0.8,
  ];
  for (let i = 1; i < 7; i++) mesh.triangle(at(0), at(i), at(i + 1), OUTLINE, [0, 1, 0]);
}

/**
 * The figure's geometry with one bone per vertex: its parts, their outline hulls, and the
 * blob shadow on the root. A `dither` attribute marks the shadow, which the material draws as
 * a checkerboard of pixels: see-through without blending, so it costs no extra draw call.
 */
export function characterGeometry(outfit: Outfit = WALKER): BufferGeometry {
  const { solids, decals } = figure(outfit);
  const pieces: { geometry: BufferGeometry; bone: number; dither: number }[] = [];
  for (const [bone, name] of BONES.entries()) {
    const mesh = new MeshBuilder();
    for (const solid of solids.filter((s) => s.bone === name)) {
      addSolid(mesh, solid, solid.rings, false);
      if (solid.hull !== false)
        addSolid(mesh, solid, grown(solid.hull ?? solid.rings, OUTLINE_WIDTH), true);
    }
    for (const decal of decals.filter((d) => d.bone === name)) {
      mesh.quad(...decal.corners, decal.color, [0, 0, 1]);
    }
    const geometry = mesh.build();
    if (geometry.getAttribute('position').count) pieces.push({ geometry, bone, dither: 0 });
  }
  const blob = new MeshBuilder();
  addBlob(blob);
  pieces.push({ geometry: blob.build(), bone: BONES.indexOf('root'), dither: 1 });

  const count = pieces.reduce((n, p) => n + p.geometry.getAttribute('position').count, 0);
  const position = new Float32Array(count * 3);
  // Normals and colours as the builder writes them: bytes, padded to four.
  const normal = new Int8Array(count * 4);
  const color = new Uint8Array(count * 4);
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const dither = new Uint8Array(count);
  const index: number[] = [];
  let offset = 0;
  for (const piece of pieces) {
    const n = piece.geometry.getAttribute('position').count;
    for (const i of piece.geometry.index!.array) index.push(offset + i);
    position.set(piece.geometry.getAttribute('position').array, offset * 3);
    const bytes = (name: string) =>
      (piece.geometry.getAttribute(name) as InterleavedBufferAttribute).data.array;
    normal.set(bytes('normal'), offset * 4);
    color.set(bytes('color'), offset * 4);
    dither.fill(piece.dither, offset, offset + n);
    for (let i = offset; i < offset + n; i++) {
      skinIndex[i * 4] = piece.bone;
      skinWeight[i * 4] = 1;
    }
    offset += n;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('normal', padded(normal));
  geometry.setAttribute('color', padded(color));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new BufferAttribute(skinWeight, 4));
  geometry.setAttribute('dither', new BufferAttribute(dither, 1));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
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
    const { parent, at } = JOINTS[name];
    bones[name].name = name;
    // Undoing the body's roll before their own swing keeps the legs plumb (see applyPose).
    if (name === 'legL' || name === 'legR') bones[name].rotation.order = 'ZYX';
    bones[name].position.set(...at);
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
  /** The scarf's tail, swung back from hanging straight down (radians). */
  scarf: number;
}

/** How far out from the body the arms hang (radians). */
const ARM_SPREAD = 0.07;
/** The scarf's tail lies back over the top of the bag at rest (radians). */
const SCARF_REST = 0.25;
/** Elbows hang a little bent, as arms do. */
const REST_ELBOW = -0.12;
/** The furthest the head turns toward where the camera looks (radians). */
const LOOK_LIMIT = 1.1;
/** The longest a leg stretches, hip to ankle: never quite straight, so the knee never snaps. */
const REACH = THIGH + SHIN - 0.004;
/** The sole's heel, ball and toe tip, from the ankle (z forward, y up; model metres). */
export const SOLE = [
  [-0.105, -ANKLE],
  [BALL, -ANKLE],
  [0.2, -0.05],
] as const;
/**
 * How the gait changes from a walk (first) to a run (second), in model metres and radians: the
 * share of a cycle each foot is down (under a half is a run, with both feet off the ground in
 * between), how high a foot lifts, the hips' height and their bounce, where under the hips the
 * steps centre, how far the heel lifts before the toes push off, the arms' swing and the lean.
 */
const DUTY = [0.52, 0.27] as const;
const LIFT = [0.09, 0.26] as const;
/** How early in its swing a foot is highest: a run kicks the heel up behind first. */
const KICK = [0.8, 0.5] as const;
const HIPS = [0.77, 0.7] as const;
const BOUNCE = [0, 0.035] as const;
const CENTRE = [0.03, -0.04] as const;
const TOES = [0.38, 0.45] as const;
const ARMS = [0.55, 0.55] as const;
/** Where the arms swing about: a run pumps them mostly behind the body. */
const ARMS_BACK = [0, 0.3] as const;
const LEAN = [0.07, 0.24] as const;
/** Below this speed (m/s) steps shorten toward standing still. */
const STEPPING = 1.5;
/** Turning on the spot: a full cycle of two steps for each quarter turn. */
const TURN_STEPS = 4;
/** Starting and stopping: the acceleration (m/s²) that leans the body most of its furthest. */
const SURGE = 15;
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
/** The fraction of the way through a cycle of length `n`, from `start`. */
const cycle = (p: number, start: number, n = 1) => (((p - start) % n) + n) % n;

/** The gait at this speed: a walk's and a run's, blended (see DUTY and below). */
const gait = { sweep: 0, duty: 0, centre: 0, lift: 0, kick: 0, toes: 0 };

/** Where a foot is: its ankle forward of the root and above the ground, and its pitch. */
interface Foot {
  z: number;
  y: number;
  pitch: number;
}

/** How high the ankle must be for no part of the sole to dip below the ground at a pitch. */
export function clearance(pitch: number): number {
  let need = 0;
  for (const [z, y] of SOLE) need = Math.max(need, z * Math.sin(pitch) - y * Math.cos(pitch));
  return need;
}

/**
 * A foot through one gait cycle, `q` from 0 to 1 starting as it lands. While down it slides back
 * under the body exactly as fast as the body moves on, so it stays where it landed: flat, then
 * rolling up onto the ball of the foot. Then it lifts and swings forward to land again, leaving
 * and arriving at the speed it had on the ground, so it neither scuffs off nor skids in.
 */
function footAt(out: Foot, q: number): Foot {
  const { sweep, duty, centre, lift, kick, toes } = gait;
  if (q < duty) {
    const u = q / duty;
    const ball = centre + sweep * (0.5 - u);
    const pitch = toes * smoothstep((u - 0.55) / 0.45);
    out.z = ball - BALL * Math.cos(pitch) + ANKLE * Math.sin(pitch);
    out.y = BALL * Math.sin(pitch) + ANKLE * Math.cos(pitch);
    out.pitch = pitch;
    return out;
  }
  const s = (q - duty) / (1 - duty);
  const z0 = centre - sweep / 2 - BALL * Math.cos(toes) + ANKLE * Math.sin(toes);
  const z1 = centre + sweep / 2 - BALL;
  const y0 = BALL * Math.sin(toes) + ANKLE * Math.cos(toes);
  // A Hermite curve from lift-off to landing, leaving and arriving at most of the speed the foot
  // had on the ground: all of it would swing it far back first, out of reach.
  const m = (-0.6 * sweep * (1 - duty)) / duty;
  const s2 = s * s;
  const s3 = s2 * s;
  out.z = z0 + (z1 - z0) * (3 * s2 - 2 * s3) + m * (s - 3 * s2 + 2 * s3);
  out.pitch = toes * (1 - s) ** 2 - 0.6 * s2 * (1 - s);
  const y = y0 + (ANKLE - y0) * s + lift * Math.sin(Math.PI * s ** kick);
  out.y = Math.max(y, clearance(out.pitch));
  return out;
}

const footL: Foot = { z: 0, y: 0, pitch: 0 };
const footR: Foot = { z: 0, y: 0, pitch: 0 };
const limb: Limb = { root: 0, joint: 0 };

/**
 * The highest the hips can be with the ankle at `foot` still in reach. A foot well off the ground
 * doesn't hold them down: out of reach, it just stops short, higher up.
 */
function reachAbove(foot: Foot, hipsZ: number): number {
  const off = smoothstep((foot.y - clearance(foot.pitch)) / 0.06);
  return foot.y + Math.sqrt(Math.max(0, REACH * REACH - (foot.z - hipsZ) ** 2)) + off;
}

/**
 * The pose for a moment of walking, running or standing, written into `out` (no allocation per
 * frame). Feet first: each foot goes where the gait cycle puts it (`phase`, which the walker turns
 * at its stride's pace), and the legs reach for them by IK, so a foot on the ground stays where it
 * landed. The hips ride as high as both legs allow, which bobs a walk; a run sinks onto each step
 * and springs off it into a moment with both feet in the air. Arms swing against the legs.
 * Speeding up (`accel`, m/s²) leans the body in and carries the hips ahead of the feet; slowing
 * down leans it back. Standing, it steps on the spot as it turns (`turning`, rad/s, the steps
 * keeping time with its `heading`). The torso banks into turns and the head turns toward `look`
 * (radians from straight ahead). Just stopped, it rocks on over its feet and settles; then for a
 * few seconds it breathes and glances about, and then stands still.
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
): Pose {
  const run = runBlend(speed);
  const step = smoothstep(speed / STEPPING);
  const duty = lerp(DUTY, run);
  const stride = (STRIDE_WALK + (STRIDE_RUN - STRIDE_WALK) * run) / CHARACTER_SCALE;
  gait.duty = duty;
  gait.sweep = duty * stride;
  gait.centre = lerp(CENTRE, run);
  gait.lift = lerp(LIFT, run);
  gait.kick = lerp(KICK, run);
  gait.toes = lerp(TOES, run);
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
  }

  const surge = idle && speed > 0 ? Math.tanh(accel / SURGE) : 0;
  out.hipsZ = SURGE_HIPS * surge;
  out.roll = 0;
  // A run sinks onto each step and springs off it, highest midway between steps; a walk's bob
  // comes from the legs' reach alone.
  const q = cycle(p, 0.25, 0.5);
  const bounce = lerp(BOUNCE, run);
  const flight = 0.5 - duty;
  let hips = lerp(HIPS, run);
  if (q < duty) hips -= bounce * Math.sin((Math.PI * q) / duty);
  else if (flight > 0)
    hips += ((bounce * flight) / duty) * Math.sin((Math.PI * (q - duty)) / flight);
  hips = REST_HIPS + (hips - REST_HIPS) * step;
  hips = softMin(hips, reachAbove(footL, out.hipsZ), 0.04);
  out.hips = softMin(hips, reachAbove(footR, out.hipsZ), 0.04);
  for (const [foot, x] of [
    [footL, HIP_X],
    [footR, -HIP_X],
  ] as const) {
    limbIK(limb, foot.z - out.hipsZ, foot.y - out.hips - x * Math.sin(out.roll), THIGH, SHIN, 1);
    const ankle = foot.pitch - limb.root - limb.joint;
    if (x > 0) [out.legL, out.kneeL, out.footL] = [limb.root, limb.joint, ankle];
    else [out.legR, out.kneeR, out.footR] = [limb.root, limb.joint, ankle];
  }

  const swing = Math.sin(phase);
  const arms = lerp(ARMS, run) * step * swing;
  out.armL = lerp(ARMS_BACK, run) + arms;
  out.armR = lerp(ARMS_BACK, run) - arms;
  // The arm swinging forward bends a little more at a walk; a run holds both bent.
  const elbow = REST_ELBOW - 0.15 * step - 1.05 * run;
  const reach = 0.3 * step * (1 - run);
  out.elbowL = elbow - reach * Math.max(0, -swing);
  out.elbowR = elbow - reach * Math.max(0, swing);
  // Just stopped, the body rocks on over its feet and back before it settles.
  const settle = idle && still < 1 ? 0.09 * Math.sin(11 * still) * Math.exp(-still / 0.16) : 0;
  out.lean = lerp(LEAN, run) * step + SURGE_LEAN * surge + settle;
  out.twist = (0.16 - 0.1 * run) * step * swing;
  out.bank = Math.max(-0.3, Math.min(0.3, -0.03 * turning * speed));
  out.nod = -0.6 * out.lean;
  // The scarf's tail hangs plumb, streams back with speed, kicks back as the walker sets off
  // and forward as it stops, and flutters with the stride.
  const trail = 1.1 * (1 - Math.exp(-speed / 8));
  const flutter = (0.06 + 0.1 * run) * step * Math.sin(2 * phase);
  out.scarf = SCARF_REST + trail + 0.35 * surge + flutter - out.lean;
  out.look = Math.max(-LOOK_LIMIT, Math.min(LOOK_LIMIT, look));
  if (idle && speed === 0 && still < IDLE_SECONDS) {
    const u = still / IDLE_SECONDS;
    const fade = Math.sin(Math.PI * u);
    const breath = 0.5 - 0.5 * Math.cos(Math.PI * 6 * u);
    out.look += 0.5 * Math.sin(Math.PI * 2 * u) * fade;
    out.armL = 0.05 * breath * fade;
    out.armR = -out.armL;
  }
  return out;
}

/** The figure standing at rest, as `poseAt` stands it. */
export function restPose(): Pose {
  const pose = {} as Pose;
  return poseAt(pose, 0, 0, Infinity, false);
}

export function applyPose({ bones }: Character, pose: Pose): void {
  bones.hips.position.set(0, pose.hips, pose.hipsZ);
  bones.hips.rotation.z = pose.roll;
  bones.torso.rotation.set(pose.lean, pose.twist, pose.bank);
  bones.head.rotation.set(pose.nod, pose.look - pose.twist, 0);
  // The legs undo the roll first (they turn Z, then X), so they swing in the root's plane.
  bones.legL.rotation.set(pose.legL, 0, -pose.roll);
  bones.legR.rotation.set(pose.legR, 0, -pose.roll);
  bones.shinL.rotation.x = pose.kneeL;
  bones.shinR.rotation.x = pose.kneeR;
  bones.footL.rotation.x = pose.footL;
  bones.footR.rotation.x = pose.footR;
  // The arms hang a little out from the body, so the mittens clear the coat's hem.
  bones.armL.rotation.set(pose.armL, 0, ARM_SPREAD);
  bones.armR.rotation.set(pose.armR, 0, -ARM_SPREAD);
  bones.scarf.rotation.x = pose.scarf;
  bones.foreL.rotation.x = pose.elbowL;
  bones.foreR.rotation.x = pose.elbowR;
}

/** Angles for a two-bone limb: its root's swing and its middle joint's bend (radians). */
export interface Limb {
  root: number;
  joint: number;
}

/**
 * Two-bone inverse kinematics in a limb's plane: the swing of its root and the bend of its middle
 * joint that put the end of a limb (`upper` then `lower` long, hanging straight down at rest) at
 * `z` forward and `y` up from its root, written into `out`. Angles turn about x as the bones do:
 * a positive swing carries the end back. `bend` 1 bends the joint forward, as a knee does (a
 * positive bend); -1 back, as an elbow does. Out of reach, the limb points at the target as far
 * as it goes; too close, it folds as far as it can.
 */
export function limbIK(
  out: Limb,
  z: number,
  y: number,
  upper: number,
  lower: number,
  bend: 1 | -1,
): Limb {
  const d = Math.min(
    upper + lower - 1e-6,
    Math.max(Math.abs(upper - lower) + 1e-6, Math.hypot(z, y)),
  );
  const aim = Math.atan2(-z, -y);
  const atRoot = Math.acos((upper * upper + d * d - lower * lower) / (2 * upper * d));
  const atJoint = Math.acos((upper * upper + lower * lower - d * d) / (2 * upper * lower));
  out.root = aim - bend * atRoot;
  out.joint = bend * (Math.PI - atJoint);
  return out;
}
