import { InstancedBufferAttribute, InstancedMesh } from 'three';
import type { BufferGeometry, Material, Scene } from 'three';

import { CHARACTER_SCALE, OUTLINE_WIDTH, addSolid, grown } from './figure.ts';
import type { Outfit, Ring, Solid } from './figure.ts';
import { MeshBuilder } from './mesh-builder.ts';
import type { V3 } from './mesh-builder.ts';
import { OUTLINE, WALKER } from './palette.ts';

/**
 * The crowd: people beyond the few who wear a full figure, an instance each of one small figure
 * of its own in one draw call, with their x-ray in one more. Its shape is the walker's made
 * plain: a body, a head, two legs and two arms in about 150 triangles with their ink, its legs
 * and arms swung in the vertex shader. What varies per person (where, which way, how far their
 * limbs swing, their shirt and the rest of how they look, how much of them is there) is in a few
 * numbers an instance, so it costs a draw call whether a dozen or six hundred stand in the street.
 * Pure but for the mesh: the numbers it writes are tested.
 */

/**
 * What the shader tints a face with, in eighths on top of its bone in the `facade` attribute;
 * `ink` is the hull, whatever its colour, for the shader to widen at a distance.
 */
export const TINT_ROLE = { none: 0, shirt: 1, shorts: 2, skin: 3, hair: 4, ink: 7 } as const;

const WHITE = 0xffffff;
/** Sentinel colours for the figure's parts: what each face is painted, before it's tinted. */
const PART = { shirt: 0xff0000, shorts: 0x00ff00, skin: 0x0000ff, hair: 0xffff00 } as const;
const SHOES = WALKER.sneakers;

/** A level ring of `sides` corners, `wx` and `wz` either side, its first corner toward +x. */
function ring(y: number, wx: number, wz: number, sides: number, turn = Math.PI / sides): Ring {
  return Array.from({ length: sides }, (_, i): V3 => {
    const a = turn + (i * Math.PI * 2) / sides;
    return [Math.cos(a) * wx, y, Math.sin(a) * wz];
  });
}

/** The same ring with its corners moved by (dx, dz): a limb off the body's middle. */
const offset = (r: Ring, dx: number, dz = 0): Ring => r.map(([x, y, z]): V3 => [x + dx, y, z + dz]);

const leg = (side: 1 | -1): Solid => {
  const x = 0.1 * side;
  return {
    bone: side === 1 ? 'legL' : 'legR',
    color: PART.shorts,
    paint: (band) => (band === 0 ? SHOES : PART.shorts),
    rings: [
      // A shoe longer ahead than behind, then a leg to the hip, hidden in the shirt's hem above.
      offset(ring(0, 0.11, 0.15, 4), x, 0.04),
      offset(ring(0.16, 0.08, 0.09, 4), x),
      offset(ring(0.86, 0.11, 0.11, 4), x),
    ],
    open: [true, true],
    hull: [offset(ring(0, 0.11, 0.15, 4), x, 0.04), offset(ring(0.86, 0.11, 0.11, 4), x)],
  };
};

const arm = (side: 1 | -1): Solid => {
  const x = 0.29 * side;
  return {
    bone: side === 1 ? 'armL' : 'armR',
    color: PART.shirt,
    rings: [offset(ring(0.78, 0.05, 0.05, 4), x), offset(ring(1.42, 0.075, 0.09, 4), x)],
    open: [false, true],
  };
};

const TORSO: Solid = {
  bone: 'torso',
  color: PART.shirt,
  rings: [ring(0.84, 0.2, 0.13, 6), ring(1.46, 0.25, 0.14, 6)],
  open: [true, false],
};

const HEAD: Solid = {
  bone: 'head',
  color: PART.skin,
  // The top cap is the hair; hair comes down over the top of the head, seen from above.
  paint: (band) => (band === 0 ? PART.skin : PART.hair),
  rings: [ring(1.5, 0.19, 0.18, 6), ring(1.88, 0.21, 0.2, 6)],
  open: [true, false],
};

/** A corner of the blob under the feet: a flat octagon on the root, as the walker's. */
const blobAt = (i: number): V3 => [
  Math.cos((i * Math.PI) / 4) * 0.42,
  0.02,
  Math.sin((i * Math.PI) / 4) * 0.42 * 0.8,
];

const PARTS: readonly Solid[] = [leg(1), leg(-1), TORSO, arm(1), arm(-1), HEAD];

/** The role a sentinel-painted face takes; anything else keeps its own colour. */
function roleOf(colour: number): number {
  if (colour === PART.shirt) return TINT_ROLE.shirt;
  if (colour === PART.shorts) return TINT_ROLE.shorts;
  if (colour === PART.skin) return TINT_ROLE.skin;
  if (colour === PART.hair) return TINT_ROLE.hair;
  if (colour === OUTLINE) return TINT_ROLE.ink;
  return TINT_ROLE.none;
}
const isTinted = (colour: number) => roleOf(colour) !== TINT_ROLE.none && colour !== OUTLINE;

/**
 * The figure and its hull, one geometry: its parts by bone index and tint role in `facade`, and
 * the blob under its feet on the root, as the walker's geometry has them.
 */
export function crowdFigureGeometry(): BufferGeometry {
  const mesh = new MeshBuilder();
  const frame = {
    facade: (bone: number, color: number) => bone + roleOf(color) / 8,
    paint: (color: number) => (isTinted(color) ? WHITE : color),
  };
  for (const part of PARTS) {
    addSolid(mesh, part, part.rings, false, frame);
    if (part.hull !== false) {
      addSolid(mesh, part, grown(part.hull ?? part.rings, OUTLINE_WIDTH), true, frame);
    }
  }
  for (let i = 1; i < 7; i++)
    mesh.triangle(blobAt(0), blobAt(i), blobAt(i + 1), OUTLINE, [0, 1, 0], 0);
  return mesh.build({ facade: true, keep: true });
}

const srgb = (hex: number): [number, number, number] => [
  ((hex >> 16) & 255) / 255,
  ((hex >> 8) & 255) / 255,
  (hex & 255) / 255,
];

export interface CrowdMesh {
  /** Puts someone in instance `i`, as the frame places them. */
  place(
    i: number,
    x: number,
    y: number,
    z: number,
    heading: number,
    phase: number,
    swing: number,
    fade: number,
    colour: number,
    outfit: Outfit | null,
  ): void;
  /** The frame's over: `count` drawn; `inkExtra` widens the outline so it stays a pen's width. */
  finish(count: number, inkExtra: number): void;
  readonly count: number;
  dispose(): void;
}

/** A figure's feet are this far over the ground, as the avatar's (m). */
export const FEET_Y = 0.04;

export interface CrowdKit {
  scene: Scene;
  /** The body's material and the x-ray's, sharing one number: how much to widen the ink. */
  body: Material;
  xray: Material;
  ink: { value: number };
}

export function createCrowdMesh(kit: CrowdKit, cap: number): CrowdMesh {
  const geometry = crowdFigureGeometry();
  const motion = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  const shirt = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  const look = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  geometry.setAttribute('motion', motion);
  geometry.setAttribute('shirt', shirt);
  geometry.setAttribute('look', look);
  const mesh = new InstancedMesh(geometry, kit.body, cap);
  const xray = new InstancedMesh(geometry, kit.xray, cap);
  xray.instanceMatrix = mesh.instanceMatrix;
  for (const m of [mesh, xray]) {
    m.frustumCulled = false;
    m.count = 0;
    m.visible = false;
    kit.scene.add(m);
  }
  mesh.receiveShadow = true;
  xray.renderOrder = 1;
  mesh.renderOrder = 2;
  // What each instance is painted as, so a colour is written only when it changes: whoever is in
  // the instance, a person handed the slot or the same one changing clothes.
  const painted = new Int32Array(cap * 4).fill(-1);

  return {
    get count() {
      return mesh.count;
    },
    place(i, x, y, z, heading, phase, swing, fade, colour, outfit) {
      const m = mesh.instanceMatrix.array as Float32Array;
      const sin = Math.sin(heading) * CHARACTER_SCALE;
      const cos = Math.cos(heading) * CHARACTER_SCALE;
      const e = i * 16;
      m[e] = cos;
      m[e + 1] = 0;
      m[e + 2] = -sin;
      m[e + 3] = 0;
      m[e + 4] = 0;
      m[e + 5] = CHARACTER_SCALE;
      m[e + 6] = 0;
      m[e + 7] = 0;
      m[e + 8] = sin;
      m[e + 9] = 0;
      m[e + 10] = cos;
      m[e + 11] = 0;
      m[e + 12] = x;
      m[e + 13] = y + FEET_Y;
      m[e + 14] = z;
      m[e + 15] = 1;
      const a = motion.array as Float32Array;
      a[i * 3] = phase;
      a[i * 3 + 1] = swing;
      a[i * 3 + 2] = fade;
      const o = outfit ?? WALKER;
      const at = i * 4;
      if (painted[at] !== colour) {
        painted[at] = colour;
        shirt.array.set(srgb(colour), i * 3);
        shirt.needsUpdate = true;
      }
      if (
        painted[at + 1] !== o.shorts ||
        painted[at + 2] !== o.skin ||
        painted[at + 3] !== o.hair
      ) {
        painted[at + 1] = o.shorts;
        painted[at + 2] = o.skin;
        painted[at + 3] = o.hair;
        const l = look.array as Float32Array;
        l[i * 3] = o.shorts;
        l[i * 3 + 1] = o.skin;
        l[i * 3 + 2] = o.hair;
        look.needsUpdate = true;
      }
    },
    finish(count, inkExtra) {
      for (const m of [mesh, xray]) {
        m.count = count;
        m.visible = count > 0;
      }
      if (count === 0) return;
      kit.ink.value = inkExtra;
      mesh.instanceMatrix.needsUpdate = true;
      motion.needsUpdate = true;
    },
    dispose() {
      kit.scene.remove(mesh);
      kit.scene.remove(xray);
      geometry.dispose();
      mesh.dispose();
      xray.dispose();
      kit.body.dispose();
      kit.xray.dispose();
    },
  };
}
