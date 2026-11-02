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
import { IDLE_SECONDS, WALK_SPEED, runBlend } from './walker.ts';

/**
 * The walker: a few boxes on a twelve-bone skeleton (knees and elbows included, so it can run),
 * chunky enough to read from the chase camera. Its ink outline is an inverted hull in the same geometry (slightly larger
 * boxes facing inward, so only their far sides show around the silhouette), which keeps the
 * whole figure, shadow included, to one draw call.
 */

/** How much larger than life the figure is drawn: the same as the street furniture. */
export const CHARACTER_SCALE = 1.3;
/** Outline thickness, in model metres. */
const OUTLINE_WIDTH = 0.035;

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
] as const;
export type BoneName = (typeof BONES)[number];

/** Hip to knee, and knee to sole (model metres). */
const THIGH = 0.37;
const SHIN = 0.45;

/** Each bone's pivot relative to its parent, in model metres (y up, facing +z). */
const JOINTS: Record<BoneName, { parent: BoneName | null; at: V3 }> = {
  root: { parent: null, at: [0, 0, 0] },
  hips: { parent: 'root', at: [0, 0.82, 0] },
  torso: { parent: 'hips', at: [0, 0, 0] },
  head: { parent: 'torso', at: [0, 0.56, 0] },
  armL: { parent: 'torso', at: [0.27, 0.5, 0] },
  armR: { parent: 'torso', at: [-0.27, 0.5, 0] },
  foreL: { parent: 'armL', at: [0, -0.24, 0] },
  foreR: { parent: 'armR', at: [0, -0.24, 0] },
  legL: { parent: 'hips', at: [0.1, 0, 0] },
  legR: { parent: 'hips', at: [-0.1, 0, 0] },
  shinL: { parent: 'legL', at: [0, -THIGH, 0] },
  shinR: { parent: 'legR', at: [0, -THIGH, 0] },
};

interface Part {
  bone: BoneName;
  min: V3;
  max: V3;
  color: number;
  outline?: false;
}

const mirror = (p: Part, bone: BoneName): Part => ({
  ...p,
  bone,
  min: [-p.max[0], p.min[1], p.min[2]],
  max: [-p.min[0], p.max[1], p.max[2]],
});

// Each limb part hangs from the bone whose pivot is above it: thigh and upper arm from the
// hip and shoulder, shin and forearm from the knee and elbow.
const LEG: Part[] = [
  { bone: 'legL', min: [0.02, 0.47, -0.08], max: [0.18, 0.84, 0.08], color: WALKER.trousers },
  // The knee: a block round the joint that turns with the shin, so a bent leg stays one piece
  // instead of two boxes opening a notch.
  { bone: 'shinL', min: [0.025, 0.39, -0.085], max: [0.175, 0.51, 0.085], color: WALKER.trousers },
  { bone: 'shinL', min: [0.03, 0.1, -0.075], max: [0.17, 0.42, 0.075], color: WALKER.trousers },
  { bone: 'shinL', min: [0.02, 0, -0.09], max: [0.19, 0.12, 0.14], color: WALKER.shoes },
];
const ARM: Part[] = [
  { bone: 'armL', min: [0.22, 1.07, -0.07], max: [0.34, 1.36, 0.07], color: WALKER.coat },
  { bone: 'foreL', min: [0.225, 0.86, -0.065], max: [0.335, 1.1, 0.065], color: WALKER.coat },
  { bone: 'foreL', min: [0.235, 0.76, -0.055], max: [0.325, 0.87, 0.055], color: WALKER.skin },
];

/** Model-space boxes, in the bind pose: all bones unrotated, pivots as in JOINTS. */
export const PARTS: readonly Part[] = [
  ...LEG,
  ...LEG.map((p) => mirror(p, 'legR')),
  { bone: 'torso', min: [-0.22, 0.74, -0.13], max: [0.22, 1.36, 0.13], color: WALKER.coat },
  { bone: 'torso', min: [-0.2, 1.26, -0.15], max: [0.2, 1.39, 0.15], color: WALKER.scarf },
  { bone: 'torso', min: [0.05, 1.0, 0.12], max: [0.14, 1.28, 0.17], color: WALKER.scarf },
  { bone: 'torso', min: [-0.17, 0.88, -0.27], max: [0.17, 1.3, -0.12], color: WALKER.bag },
  ...ARM,
  ...ARM.map((p) => mirror(p, 'armR')),
  { bone: 'head', min: [-0.2, 1.38, -0.19], max: [0.2, 1.78, 0.19], color: WALKER.skin },
  { bone: 'head', min: [-0.22, 1.72, -0.21], max: [0.22, 1.85, 0.21], color: WALKER.hair },
  { bone: 'head', min: [-0.22, 1.46, -0.21], max: [0.22, 1.76, -0.06], color: WALKER.hair },
  // Eyes: dots on the face, too small for an outline.
  { bone: 'head', min: [0.06, 1.55, 0.18], max: [0.12, 1.63, 0.2], color: OUTLINE, outline: false },
  {
    bone: 'head',
    min: [-0.12, 1.55, 0.18],
    max: [-0.06, 1.63, 0.2],
    color: OUTLINE,
    outline: false,
  },
];

const FACES: readonly { axis: 0 | 1 | 2; side: 0 | 1 }[] = [0, 1, 2].flatMap((axis) =>
  [0, 1].map((side) => ({ axis: axis as 0 | 1 | 2, side: side as 0 | 1 })),
);

/** A box's six faces, facing out, or in for the outline hull. */
function addBox(mesh: MeshBuilder, min: V3, max: V3, color: number, inward: boolean): void {
  const at = (x: 0 | 1, y: 0 | 1, z: 0 | 1): V3 => [
    (x ? max : min)[0],
    (y ? max : min)[1],
    (z ? max : min)[2],
  ];
  for (const { axis, side } of FACES) {
    const corners = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ].map(([u, v]) => {
      const c = [0, 0, 0] as [0 | 1, 0 | 1, 0 | 1];
      c[axis] = side;
      c[(axis + 1) % 3] = u as 0 | 1;
      c[(axis + 2) % 3] = v as 0 | 1;
      return at(...c);
    }) as [V3, V3, V3, V3];
    const out = (side ? 1 : -1) * (inward ? -1 : 1);
    const hint: V3 = [axis === 0 ? out : 0, axis === 1 ? out : 0, axis === 2 ? out : 0];
    mesh.quad(...corners, color, hint);
  }
}

const grow = (v: V3, by: number): V3 => [v[0] + by, v[1] + by, v[2] + by];

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
 * The figure's geometry with one bone per vertex: body boxes, their outline hulls, and the
 * blob shadow on the root. A `dither` attribute marks the shadow, which the material draws as
 * a checkerboard of pixels: see-through without blending, so it costs no extra draw call.
 */
export function characterGeometry(): BufferGeometry {
  const pieces: { geometry: BufferGeometry; bone: number; dither: number }[] = [];
  for (const [bone, name] of BONES.entries()) {
    const mesh = new MeshBuilder();
    for (const p of PARTS.filter((part) => part.bone === name)) {
      addBox(mesh, p.min, p.max, p.color, false);
      if (p.outline === false) continue;
      addBox(mesh, grow(p.min, -OUTLINE_WIDTH), grow(p.max, OUTLINE_WIDTH), OUTLINE, true);
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
export function createCharacter(body: Material, xray: Material): Character {
  const bones = Object.fromEntries(BONES.map((name) => [name, new Bone()])) as Record<
    BoneName,
    Bone
  >;
  for (const name of BONES) {
    const { parent, at } = JOINTS[name];
    bones[name].name = name;
    bones[name].position.set(...at);
    if (parent) bones[parent].add(bones[name]);
  }
  const geometry = characterGeometry();
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
  /** Hip height above the feet, model metres. */
  hips: number;
  /** Forward lean of the torso, its twist with each stride, and its bank into a turn (radians). */
  lean: number;
  twist: number;
  bank: number;
  /** Swing of each thigh (negative is forward) and bend of each knee (positive folds the shin back). */
  legL: number;
  legR: number;
  kneeL: number;
  kneeR: number;
  /** Swing of the left arm (the right mirrors it), and the bend of both elbows (negative folds forward). */
  arm: number;
  elbow: number;
  /** Head nod and turn. */
  nod: number;
  look: number;
}

/** Elbows hang a little bent, as arms do. */
const REST_ELBOW = -0.12;

export const restPose = (): Pose => ({
  hips: JOINTS.hips.at[1],
  lean: 0,
  twist: 0,
  bank: 0,
  legL: 0,
  legR: 0,
  kneeL: 0,
  kneeR: 0,
  arm: 0,
  elbow: REST_ELBOW,
  nod: 0,
  look: 0,
});

/** How far below the hips a leg reaches, given its thigh swing and knee bend. */
export const legReach = (thigh: number, knee: number) =>
  THIGH * Math.cos(thigh) + SHIN * Math.cos(thigh + knee);

/**
 * The knee's give as its foot lands and takes the weight: a smooth bump over the first quarter
 * of the stride after the leg is furthest forward (`swing` and `through` of that leg's phase).
 */
const loading = (swing: number, through: number) =>
  (4 * Math.max(0, swing) * Math.max(0, -through)) ** 2 / 4;

/** The furthest the head turns toward where the camera looks (radians). */
const LOOK_LIMIT = 1.1;

/**
 * The pose for a moment of walking, running or standing, written into `out` (no allocation
 * per frame). The stride swings legs and arms against each other; each knee folds as its leg
 * swings through, and running adds a longer, higher stride, bent elbows and a forward lean. The
 * hips sit as high as the planted leg reaches, so the soles stay on the ground. The torso banks
 * into turns (`turning`, rad/s) and the head turns toward `look` (radians from straight ahead).
 * For a few seconds after stopping the walker breathes and glances about, then stands still.
 */
export function poseAt(
  out: Pose,
  speed: number,
  phase: number,
  still: number,
  idle: boolean,
  turning = 0,
  look = 0,
): Pose {
  const walk = Math.min(1, speed / WALK_SPEED);
  const run = runBlend(speed);
  const swing = Math.sin(phase);
  const through = Math.cos(phase);
  const reach = 0.42 * walk + 0.38 * run;
  // Running carries the thighs a little forward of straight down.
  out.legL = -reach * swing - 0.12 * run;
  out.legR = reach * swing - 0.12 * run;
  // A knee folds while its leg swings through (the left from phase -π/2 to π/2), easing in and
  // out of it rather than starting with a kink; it gives a little as the foot lands and takes
  // the weight (the left from π/2 to π), and running keeps both a little bent.
  const fold = 0.7 * walk + 1.15 * run;
  const land = 0.22 * walk + 0.15 * run;
  const give = 0.04 * walk + 0.2 * run;
  out.kneeL = fold * Math.max(0, through) ** 2 + land * loading(swing, through) + give;
  out.kneeR = fold * Math.max(0, -through) ** 2 + land * loading(-swing, -through) + give;
  out.arm = (0.55 * walk + 0.35 * run) * swing;
  out.elbow = REST_ELBOW - 0.15 * walk - 1.1 * run;
  out.hips =
    Math.max(legReach(out.legL, out.kneeL), legReach(out.legR, out.kneeR)) +
    0.03 * walk * Math.abs(through);
  out.lean = 0.08 * walk + 0.22 * run;
  out.twist = (0.16 * walk + 0.06 * run) * swing;
  out.bank = Math.max(-0.3, Math.min(0.3, -0.03 * turning * speed));
  out.nod = -0.6 * out.lean;
  out.look = Math.max(-LOOK_LIMIT, Math.min(LOOK_LIMIT, look));
  if (idle && walk === 0 && still < IDLE_SECONDS) {
    const u = still / IDLE_SECONDS;
    const fade = Math.sin(Math.PI * u);
    const breath = 0.5 - 0.5 * Math.cos(Math.PI * 6 * u);
    out.look += 0.5 * Math.sin(Math.PI * 2 * u) * fade;
    out.hips += 0.015 * breath * fade;
    out.arm = 0.05 * breath * fade;
  }
  return out;
}

export function applyPose({ bones }: Character, pose: Pose): void {
  bones.hips.position.y = pose.hips;
  bones.torso.rotation.set(pose.lean, pose.twist, pose.bank);
  bones.head.rotation.set(pose.nod, pose.look - pose.twist, 0);
  bones.legL.rotation.x = pose.legL;
  bones.legR.rotation.x = pose.legR;
  bones.shinL.rotation.x = pose.kneeL;
  bones.shinR.rotation.x = pose.kneeR;
  bones.armL.rotation.x = pose.arm;
  bones.armR.rotation.x = -pose.arm;
  bones.foreL.rotation.x = pose.elbow;
  bones.foreR.rotation.x = pose.elbow;
}
