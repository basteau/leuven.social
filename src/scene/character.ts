import {
  Bone,
  BufferAttribute,
  BufferGeometry,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
} from 'three';
import type { Material } from 'three';

import { MeshBuilder } from './mesh-builder.ts';
import type { V3 } from './mesh-builder.ts';
import { OUTLINE, WALKER } from './palette.ts';
import { IDLE_SECONDS, WALK_SPEED } from './walker.ts';

/**
 * The walker: a few boxes on a seven-bone skeleton, chunky enough to read from the isometric
 * camera. Its ink outline is an inverted hull in the same geometry (slightly larger
 * boxes facing inward, so only their far sides show around the silhouette), which keeps the
 * whole figure, shadow included, to one draw call.
 */

/** How much larger than life the figure is drawn, so it reads from the isometric camera. */
export const CHARACTER_SCALE = 2.2;
/** Outline thickness, in model metres. */
const OUTLINE_WIDTH = 0.035;

export const BONES = ['root', 'hips', 'torso', 'head', 'armL', 'armR', 'legL', 'legR'] as const;
export type BoneName = (typeof BONES)[number];

/** Each bone's pivot relative to its parent, in model metres (y up, facing +z). */
const JOINTS: Record<BoneName, { parent: BoneName | null; at: V3 }> = {
  root: { parent: null, at: [0, 0, 0] },
  hips: { parent: 'root', at: [0, 0.82, 0] },
  torso: { parent: 'hips', at: [0, 0, 0] },
  head: { parent: 'torso', at: [0, 0.56, 0] },
  armL: { parent: 'torso', at: [0.27, 0.5, 0] },
  armR: { parent: 'torso', at: [-0.27, 0.5, 0] },
  legL: { parent: 'hips', at: [0.1, 0, 0] },
  legR: { parent: 'hips', at: [-0.1, 0, 0] },
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

const LEG: Part[] = [
  { bone: 'legL', min: [0.02, 0.1, -0.08], max: [0.18, 0.84, 0.08], color: WALKER.trousers },
  { bone: 'legL', min: [0.02, 0, -0.09], max: [0.19, 0.12, 0.14], color: WALKER.shoes },
];
const ARM: Part[] = [
  { bone: 'armL', min: [0.22, 0.86, -0.07], max: [0.34, 1.36, 0.07], color: WALKER.coat },
  { bone: 'armL', min: [0.235, 0.76, -0.055], max: [0.325, 0.87, 0.055], color: WALKER.skin },
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
  const normal = new Int8Array(count * 3);
  const color = new Float32Array(count * 3);
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const dither = new Uint8Array(count);
  let offset = 0;
  for (const piece of pieces) {
    const n = piece.geometry.getAttribute('position').count;
    position.set(piece.geometry.getAttribute('position').array, offset * 3);
    normal.set(piece.geometry.getAttribute('normal').array as Int8Array, offset * 3);
    color.set(piece.geometry.getAttribute('color').array, offset * 3);
    dither.fill(piece.dither, offset, offset + n);
    for (let i = offset; i < offset + n; i++) {
      skinIndex[i * 4] = piece.bone;
      skinWeight[i * 4] = 1;
    }
    offset += n;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('normal', new BufferAttribute(normal, 3, true));
  geometry.setAttribute('color', new BufferAttribute(color, 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new BufferAttribute(skinWeight, 4));
  geometry.setAttribute('dither', new BufferAttribute(dither, 1));
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
  return { mesh, xray: twin, bones };
}

export interface Pose {
  /** Hip height above the feet, model metres. */
  hips: number;
  /** Forward lean of the torso and its twist with each stride (radians). */
  lean: number;
  twist: number;
  /** Swing of the left leg and left arm (the right side mirrors them). */
  leg: number;
  arm: number;
  /** Head nod and turn. */
  nod: number;
  look: number;
}

export const restPose = (): Pose => ({
  hips: JOINTS.hips.at[1],
  lean: 0,
  twist: 0,
  leg: 0,
  arm: 0,
  nod: 0,
  look: 0,
});

/**
 * The pose for a moment of walking or standing, written into `out` (no allocation per frame).
 * Walking swings legs and arms against each other with a bob that peaks as the legs pass; for
 * a few seconds after stopping the walker breathes and glances about, then stands still.
 */
export function poseAt(
  out: Pose,
  speed: number,
  phase: number,
  still: number,
  idle: boolean,
): Pose {
  const walk = Math.min(1, speed / WALK_SPEED);
  const swing = Math.sin(phase);
  out.leg = -0.8 * swing * walk;
  out.arm = 0.7 * swing * walk;
  // The hips drop as the legs spread, so the soles stay on the ground, plus a little spring
  // in the step as the legs pass each other.
  out.hips = JOINTS.hips.at[1] * Math.cos(out.leg) + 0.05 * walk * Math.abs(Math.cos(phase));
  out.lean = 0.12 * walk;
  out.twist = 0.18 * swing * walk;
  out.nod = -0.6 * out.lean;
  out.look = 0;
  if (idle && walk === 0 && still < IDLE_SECONDS) {
    const u = still / IDLE_SECONDS;
    const fade = Math.sin(Math.PI * u);
    const breath = 0.5 - 0.5 * Math.cos(Math.PI * 6 * u);
    out.look = 0.5 * Math.sin(Math.PI * 2 * u) * fade;
    out.hips += 0.015 * breath * fade;
    out.arm = 0.05 * breath * fade;
  }
  return out;
}

export function applyPose({ bones }: Character, pose: Pose): void {
  bones.hips.position.y = pose.hips;
  bones.torso.rotation.set(pose.lean, pose.twist, 0);
  bones.head.rotation.set(pose.nod, pose.look - pose.twist, 0);
  bones.legL.rotation.x = pose.leg;
  bones.legR.rotation.x = -pose.leg;
  bones.armL.rotation.x = pose.arm;
  bones.armR.rotation.x = -pose.arm;
}
