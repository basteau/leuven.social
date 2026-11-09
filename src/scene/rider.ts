import type {
  BackSide,
  BufferGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshBasicMaterialParameters,
  MeshToonMaterial,
  Scene,
  Texture,
  WebGLProgramParametersWithUniforms,
} from 'three';

import { AXLE, BRACKET, CRANK, LOOK, PARTS, WHEEL, bikeArrays } from './bike-rig.ts';
import { BIKES } from './palette.ts';
import {
  ANKLE,
  ARM_SPREAD,
  BONES,
  CHARACTER_SCALE,
  OUTLINE_WIDTH,
  REST_HIPS,
  addSolid,
  details,
  figure,
  grown,
  shade,
} from './figure.ts';
import type { BoneName, Outfit } from './figure.ts';
import { THIGH, UPPER_ARM } from './limb.ts';
import type { MeshBuilder, V3 } from './mesh-builder.ts';
import { BIKE_LAMPS, WALKER } from './palette.ts';

/**
 * Someone on a bike, drawn: the walker's figure riding the rideable bike of bike-rig.ts, its
 * legs pedalling and the wheels and crank turning in the vertex shader, as instances of one
 * mesh with an ink hull and an x-ray twin sharing its matrices, three draw calls however many
 * ride. The avatar's own bike (bikes.ts) draws one; the other players' riders draw the rest.
 *
 * Shapes are in their own frame: x ahead, y up, z to the right. Vertex colours carry what never
 * changes; the `facade` attribute says what does, as a part code: HEAD and TAIL glow at night
 * (the tail with the brakes), the BEAM is the lamp's pool on the street at night, the halos the
 * glow round the lamps; from RIDER up, the figure's bones, from BIKE up the bike's.
 */
export const PART = {
  plain: 0,
  head: 1,
  tail: 2,
  beam: 6,
  /** The glow round a lamp at night, dithered out by the fraction: the lamp's, the reflector's. */
  halo: 11,
  haloTail: 12,
} as const;

type Builder = Pick<MeshBuilder, 'quad' | 'triangle'>;

/**
 * Part codes from RIDER up are the walker's figure (figure.ts), a bone each in BONES' order;
 * from BIKE up the bike's own bones (bike-rig.ts). The fraction of such a code says which of
 * the instance's colours a face takes (TINT), the face's own colour saying how much of it (its
 * shade).
 */
export const RIDER = 32;
export const BIKE = 48;
export const TINT = { shirt: 0.5, shorts: 0.25, hair: 0.75, skin: 0.125, frame: 0.375 } as const;

/** The figure's size: the walker's, a third over life. */
const S = CHARACTER_SCALE;
/** A figure point (model metres, y up, facing +z) in the rider's frame (x ahead, z right). */
const toRider = ([x, y, z]: V3): V3 => [z * S, y * S, -x * S];
/** Where the figure's joints are, up from its feet (model metres): the shader turns about them. */
const SHOULDER_Y = REST_HIPS + 0.5;
const ELBOW_Y = SHOULDER_Y - UPPER_ARM;
const KNEE_Y = REST_HIPS - THIGH;
const NECK_Y = REST_HIPS + 0.56;
/** The figure dressed so each face says which of the instance's colours it takes: one channel each. */
const SENTINEL: Outfit = { shirt: 0xff0000, shorts: 0x00ff00, hair: 0x0000ff, skin: WALKER.skin };
const MOUTH = shade(WALKER.skin, 0.62);

/**
 * What a face of the figure in the sentinel outfit carries: the tint it takes from the
 * instance (its shirt, its shorts or its hair, by the channel its colour is in, or its skin) and
 * the colour it is written in, white times the shade for the shader to multiply, or its own
 * colour and no tint.
 */
export function tintOf(color: number): [tint: number, color: number] {
  const [r, g, b] = [(color >> 16) & 255, (color >> 8) & 255, color & 255];
  if (r && !g && !b) return [TINT.shirt, color];
  if (g && !r && !b) return [TINT.shorts, color];
  if (b && !r && !g) return [TINT.hair, color];
  if (color === WALKER.skin) return [TINT.skin, 0xffffff];
  if (color === MOUTH) return [TINT.skin, 0x9e9e9e];
  return [0, color];
}

/** The arms hang a little out from the body, turned about the shoulder as the walker's are. */
function spread(p: V3, bone: BoneName): V3 {
  const side =
    bone === 'armL' || bone === 'foreL' ? 1 : bone === 'armR' || bone === 'foreR' ? -1 : 0;
  if (!side) return p;
  const [sx, sy] = [side * 0.27, SHOULDER_Y];
  const [c, sn] = [Math.cos(side * ARM_SPREAD), Math.sin(side * ARM_SPREAD)];
  const [dx, dy] = [p[0] - sx, p[1] - sy];
  return [sx + dx * c - dy * sn, sy + dx * sn + dy * c, p[2]];
}

/**
 * The walker's figure at its size, facing ahead, each face marked with its bone from RIDER and
 * the tint it takes. The hull mesh gets the figure's ink hulls, grown, facing out (the hull
 * material draws their backs).
 */
export function addRiderFigure(mesh: Builder, hull: boolean): void {
  for (const solid of figure(SENTINEL)) {
    if (hull && solid.hull === false) continue;
    const rings = hull ? grown(solid.hull || solid.rings, OUTLINE_WIDTH) : solid.rings;
    addSolid(mesh, solid, rings, false, {
      place: (p) => toRider(spread(p, solid.bone)),
      facade: (bone, color) => RIDER + bone + (hull ? 0 : tintOf(color)[0]),
      paint: (color) => tintOf(color)[1],
    });
  }
  if (hull) return;
  for (const { bone, color, points, normal } of details(SENTINEL)) {
    const [tint, c] = tintOf(color);
    const facade = RIDER + BONES.indexOf(bone) + tint;
    const [a, b, d, e] = points.map((p) => toRider(spread(p, bone))) as [V3, V3, V3, V3?];
    const hint = toRider(normal);
    if (e) mesh.quad(a, b, d, e, c, hint, facade);
    else mesh.triangle(a, b, d, c, hint, facade);
  }
}

/** The i-th point or normal of a bike's arrays, in the rider's frame. */
const v3 = (a: Float32Array, i: number): V3 => toRider([a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!]);

/** The ridden bike: the rideable one of bike-rig.ts, a diamond frame with a carrier. */
const RIDDEN_LOOK = LOOK.carrier;
/** The colour that bike's frame is built in, which the instance's frame colour replaces. */
const RIDDEN_FRAME = BIKES[Math.floor(RIDDEN_LOOK / LOOK.colour) % BIKES.length]!;

/**
 * The bike of bike-rig.ts at the figure's size, facing ahead, each face marked with its bone
 * from BIKE: its body in the body mesh with the frame taking the instance's frame colour and
 * the lamp and reflector lit, its ink hulls turned outward in the hull mesh, its blob shadow in
 * neither.
 */
export function addRiddenBike(mesh: Builder, hull: boolean): void {
  const bike = bikeArrays(RIDDEN_LOOK);
  const hex = (i: number) =>
    (Math.round(bike.color[i * 3]! * 255) << 16) |
    (Math.round(bike.color[i * 3 + 1]! * 255) << 8) |
    Math.round(bike.color[i * 3 + 2]! * 255);
  for (let t = 0; t < bike.index.length; t += 3) {
    const [i, j, k] = [bike.index[t]!, bike.index[t + 1]!, bike.index[t + 2]!];
    if (bike.dither[i] || !!bike.hull[i] !== hull) continue;
    const n = v3(bike.normal, i);
    const hint: V3 = hull ? [-n[0], -n[1], -n[2]] : n;
    const color = hex(i);
    const [tint, c] = color === RIDDEN_FRAME ? [TINT.frame, 0xffffff] : [0, color];
    const part =
      hull || !(color === PARTS.lantern || color === PARTS.crate)
        ? BIKE + bike.bone[i]! + tint
        : color === PARTS.lantern
          ? PART.head
          : PART.tail;
    mesh.triangle(v3(bike.position, i), v3(bike.position, j), v3(bike.position, k), c, hint, part);
  }
  // The lamp on the fork crown and the reflector on the carrier's end, lit (bike-rig.ts).
  if (!hull) bikeLight(mesh, 0.52 * S, 0.73 * S, (-AXLE - 0.125) * S, (2 * WHEEL + 0.02) * S);
}

/** A rider on its bike: the body, or the ink hull. */
export function addRider(mesh: Builder, hull: boolean): void {
  addRiddenBike(mesh, hull);
  addRiderFigure(mesh, hull);
}

/**
 * The rider's pedalling, as the shader swings the figure's joints: over one pedal turn as three
 * harmonics (the mean, then a cosine and sine pair for each), fitted to the rider's pose. Thigh,
 * knee and foot of the left leg; the right is half a turn on. In the walker's own signs.
 */
export const PEDAL = {
  thigh: [-0.88, 0.399, -0.263, -0.008, 0.054, 0.013, -0.006],
  knee: [1.438, -0.702, -0.124, -0.019, -0.007, -0.016, -0.009],
  foot: [-0.308, 0.304, 0.537, 0.026, -0.048, 0.002, 0.015],
} as const;
/** How far a bike goes in a pedal turn (m): a city bike's gearing at the figure's size. */
export const BIKE_STRIDE = 5;
/** How many turns a wheel makes to a pedal turn, at the drawn wheel's size. */
const GEAR = BIKE_STRIDE / (2 * Math.PI * WHEEL * S);

const glsl = (x: number) => x.toFixed(3);
/** A joint's harmonics as GLSL. */
const harm = (c: readonly number[]) => `harm(${c.map(glsl).join(', ')}, q)`;

/**
 * The figure's bones swung about their joints in the vertex shader by the pedals' turn
 * (`state.x`, radians), with the hips on the saddle, the torso over the bars and the arms to
 * them; the bike's wheels and crank turn with it, the pedals staying level. Each chain turns
 * about its own joint first, then its parents', as the walker's skeleton does; the swings carry
 * the walker's signs negated, since here a positive turn carries a limb's end ahead.
 */
const RIDER_GLSL = `
  bool bike = part >= ${BIKE}.0;
  int bone = int(part) - (bike ? ${BIKE} : ${RIDER});
  float p = state.x;
  if (bike) {
    float w = -p * ${glsl(GEAR)};
    if (bone == 2) turn(transformed, ${glsl(AXLE * S)}, ${glsl(WHEEL * S)}, w);
    else if (bone == 3) turn(transformed, ${glsl(-AXLE * S)}, ${glsl(WHEEL * S)}, w);
    else if (bone >= 4) {
      if (bone == 5) turn(transformed, ${glsl(BRACKET[0] * S)}, ${glsl((BRACKET[1] - CRANK) * S)}, p);
      if (bone == 6) turn(transformed, ${glsl(BRACKET[0] * S)}, ${glsl((BRACKET[1] + CRANK) * S)}, p);
      turn(transformed, ${glsl(BRACKET[0] * S)}, ${glsl(BRACKET[1] * S)}, -p);
    }
  } else {
    bool left = bone == 4 || bone == 6 || bone == 8 || bone == 10 || bone == 12;
    float q = -p + (left ? 0.0 : PI);
    float thigh = -${harm(PEDAL.thigh)};
    float knee = -${harm(PEDAL.knee)};
    float foot = -${harm(PEDAL.foot)};
    if (bone >= 12) turn(transformed, 0.0, ${glsl(ANKLE * S)}, foot);
    if (bone >= 10) turn(transformed, 0.0, ${glsl(KNEE_Y * S)}, knee);
    if (bone >= 8) turn(transformed, 0.0, ${glsl(REST_HIPS * S)}, thigh);
    if (bone == 6 || bone == 7) turn(transformed, 0.0, ${glsl(ELBOW_Y * S)}, 1.151);
    if (bone >= 4 && bone <= 7) turn(transformed, 0.0, ${glsl(SHOULDER_Y * S)}, 0.26);
    if (bone == 3) turn(transformed, 0.0, ${glsl(NECK_Y * S)}, 0.34);
    if (bone >= 2 && bone <= 7) turn(transformed, 0.0, ${glsl(REST_HIPS * S)}, -0.4);
    if (bone > 0) { transformed.y += ${glsl((0.92 - REST_HIPS) * S)}; transformed.x += ${glsl(-0.22 * S)}; }
  }`;

/** A small quad flat on an end face (x = `x`, facing ahead or back) in a part's colour. */
function lampAt(
  mesh: Builder,
  x: number,
  y: number,
  part: number,
  color: number,
  half: readonly [number, number],
): void {
  const dir = x > 0 ? 1 : -1;
  const p = (dy: number, dz: number): V3 => [x + dir * 0.01, y + dy, dz];
  const [h, w] = half;
  const [a, b, d, e] = [p(-h, -w), p(-h, w), p(h, w), p(h, -w)];
  if (dir > 0) mesh.quad(a, b, d, e, color, [1, 0, 0], part);
  else mesh.quad(b, a, e, d, color, [-1, 0, 0], part);
}

/**
 * The lamp's pool of light on the street ahead (drawn at night by the shader): from the lamp to
 * `to` metres, `nearHalf` wide there and `farHalf` at its end, brightest down the middle and
 * dithering away to its sides and its far end: three strips, each corner carrying how bright it
 * is in its part's fraction (1 - fade), so the pool has no hard edge.
 */
function beam(mesh: Builder, from: number, to: number, nearHalf: number, farHalf: number): void {
  const y = 0.02;
  const strip = (n0: number, n1: number, f0: number, f1: number, fades: readonly number[]) =>
    mesh.quad(
      [from, y, n0],
      [from, y, n1],
      [to, y, f1],
      [to, y, f0],
      BIKE_LAMPS.lamp,
      [0, 1, 0],
      fades.map((fade) => PART.beam + 1 - fade) as [number, number, number, number],
    );
  const [ni, fi] = [nearHalf * 0.5, farHalf * 0.5];
  strip(-ni, ni, -fi, fi, [1, 1, 0.1, 0.1]);
  strip(-nearHalf, -ni, -farHalf, -fi, [0.3, 1, 0.1, 0.02]);
  strip(ni, nearHalf, fi, farHalf, [1, 0.3, 0.02, 0.1]);
}

/** The glow round a lamp at night: a larger, dimmer quad just proud of it, dithered by `fade`. */
function halo(
  mesh: Builder,
  x: number,
  y: number,
  part: number,
  color: number,
  half: readonly [number, number],
  fade: number,
): void {
  const dir = x > 0 ? 1 : -1;
  lampAt(mesh, x + dir * 0.015, y, part + 1 - fade, color, half);
}

/** A bike's lamp and reflector at night: a halo round each, and a small pool ahead on the street. */
function bikeLight(mesh: Builder, lampX: number, lampY: number, tailX: number, tailY: number) {
  halo(mesh, lampX, lampY, PART.halo, BIKE_LAMPS.lamp, [0.08, 0.08], 0.45);
  halo(mesh, tailX, tailY, PART.haloTail, BIKE_LAMPS.reflector, [0.06, 0.07], 0.45);
  beam(mesh, lampX, lampX + 3.5, 0.22, 0.75);
}

/** How far over the drawn surface the wheels ride, so they never sink in it (m). */
const RIDE_HEIGHT = 0.03;

/**
 * The vertex shader's share of the parts: the figure's bones and the bike's wheels and crank turn
 * with the pedals (RIDER_GLSL); the part and the beam's fade go to the fragment shader. For the
 * body's material, its ink's and its x-ray's.
 */
export function riderVertexShader(vertexShader: string): string {
  return (
    vertexShader
      // `turn` turns a point about the joint at (x, y) across the bike by a: positive carries
      // what hangs below it ahead.
      .replace(
        '#include <common>',
        `#include <common>
      attribute float facade;
      attribute vec3 shirt;
      attribute vec3 shorts;
      attribute vec3 skin;
      attribute vec3 hair;
      attribute vec3 frame;
      attribute vec4 state;
      varying float vPart;
      varying float vFade;
      varying vec4 vState;
      float harm(float a, float c1, float s1, float c2, float s2, float c3, float s3, float q) {
        return a + c1 * cos(q) + s1 * sin(q) + c2 * cos(2.0 * q) + s2 * sin(2.0 * q) + c3 * cos(3.0 * q) + s3 * sin(3.0 * q);
      }
      void turn(inout vec3 p, float x, float y, float a) {
        vec2 d = vec2(p.x - x, p.y - y);
        float c = cos(a);
        float s = sin(a);
        p.x = x + d.x * c - d.y * s;
        p.y = y + d.x * s + d.y * c;
      }`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
      float part = floor(facade);
      if (part >= ${RIDER}.0) {${RIDER_GLSL}
      }
      vPart = part;
      vFade = 1.0 - fract(facade);
      vState = state;`,
      )
  );
}

/** The instance's colours swapped in for the figure's and the frame's tints, each times its shade. */
export const TINT_GLSL = `#include <color_vertex>
      if (facade >= ${RIDER}.0) {
        float tint = fract(facade);
        float shade = max(vColor.r, max(vColor.g, vColor.b));
        if (abs(tint - ${TINT.shirt}) < 0.02) vColor.rgb = shirt * shade;
        else if (abs(tint - ${TINT.shorts}) < 0.02) vColor.rgb = shorts * shade;
        else if (abs(tint - ${TINT.hair}) < 0.02) vColor.rgb = hair * shade;
        else if (abs(tint - ${TINT.skin}) < 0.02) vColor.rgb = skin * shade;
        else if (abs(tint - ${TINT.frame}) < 0.02) vColor.rgb = frame * shade;
      }`;

/** The three.js classes the riders take from the engine, so their chunk imports none itself. */
export interface RiderThree {
  BackSide: typeof BackSide;
  InstancedBufferAttribute: typeof InstancedBufferAttribute;
  InstancedMesh: typeof InstancedMesh;
  Matrix4: typeof Matrix4;
  MeshBasicMaterial: typeof MeshBasicMaterial;
  MeshToonMaterial: typeof MeshToonMaterial;
}

/** What the riders' materials take from the engine. */
export interface RiderKit {
  three: RiderThree;
  MeshBuilder: typeof MeshBuilder;
  linearVertexColors: (vertexShader: string) => string;
  /** The 4×4 ordered dither, GLSL, for the beam's fade (facade-material.ts). */
  bayer: string;
  gradientMap: Texture;
  /** How far into the night it is, for the lamps (the facade material's uniform). */
  night: { value: number };
  ink: number;
  /** The figure's silhouette where a house hides it (`XRAY_LOOK`): the riders get the same. */
  xray: MeshBasicMaterialParameters;
}

/**
 * The riders' materials: the bodies' toon shading with their parts (the figure's bones, the
 * lamps, the beam, the tints), their ink hulls', and their x-ray silhouettes'.
 */
function riderMaterials(kit: RiderKit): {
  material: MeshToonMaterial;
  inkMaterial: MeshBasicMaterial;
  xrayMaterial: MeshBasicMaterial;
} {
  const { three, linearVertexColors, gradientMap, night } = kit;
  const material = new three.MeshToonMaterial({ vertexColors: true, gradientMap });
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uNight = night;
    // The tints are sRGB like the vertex colours: swapped in right after them, so the
    // linearisation that follows the include takes them too.
    shader.vertexShader = linearVertexColors(riderVertexShader(shader.vertexShader)).replace(
      '#include <color_vertex>',
      TINT_GLSL,
    );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uNight;
        varying float vPart;
        varying float vFade;
        varying vec4 vState;
        ${kit.bayer}`,
      )
      // The beam: a pool of light on the street, dithered out towards its edges, at night; the
      // halos round the lamps the same, the reflector's with the brakes too.
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        float dither = bayer4(gl_FragCoord.xy);
        if (vPart == ${PART.beam}.0 && dither >= uNight * vFade * 0.75) discard;
        if (vPart == ${PART.halo}.0 && dither >= uNight * vFade) discard;
        if (vPart == ${PART.haloTail}.0 && dither >= (0.6 * uNight + 0.9 * vState.y) * vFade) discard;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        if (vPart == ${PART.head}.0) totalEmissiveRadiance += vec3(1.0, 0.92, 0.7) * uNight;
        else if (vPart == ${PART.tail}.0) totalEmissiveRadiance += vec3(0.9, 0.08, 0.04) * (0.6 * uNight + 0.9 * vState.y);
        else if (vPart == ${PART.beam}.0) totalEmissiveRadiance += vec3(0.8, 0.72, 0.5) * (0.55 + 0.6 * vFade);
        else if (vPart == ${PART.halo}.0) totalEmissiveRadiance += vec3(1.0, 0.9, 0.62);
        else if (vPart == ${PART.haloTail}.0) totalEmissiveRadiance += vec3(0.9, 0.12, 0.06);`,
      );
  };
  material.customProgramCacheKey = () => 'rider-v1';
  const inkMaterial = new three.MeshBasicMaterial({ color: kit.ink, side: three.BackSide });
  inkMaterial.onBeforeCompile = (shader) => {
    shader.vertexShader = riderVertexShader(shader.vertexShader);
  };
  inkMaterial.customProgramCacheKey = () => 'rider-ink-v1';
  // The silhouette where a house hides it, the lamps' glow left out.
  const xrayMaterial = new three.MeshBasicMaterial(kit.xray);
  // Each in their own shirt's colour (sRGB, as the tints are), so nobody is taken for you.
  xrayMaterial.onBeforeCompile = (shader) => {
    shader.vertexShader = riderVertexShader(shader.vertexShader)
      .replace('#include <common>', '#include <common>\nvarying vec3 vShirt;')
      .replace('vState = state;', 'vState = state;\nvShirt = shirt;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vPart;\nvarying vec3 vShirt;')
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        if (vPart < ${RIDER}.0) discard;`,
      )
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\ndiffuseColor.rgb = sRGBTransferEOTF(vec4(vShirt, 1.0)).rgb;',
      );
  };
  xrayMaterial.customProgramCacheKey = () => 'rider-xray-v4';
  return { material, inkMaterial, xrayMaterial };
}

/** How a rider looks, in 24-bit sRGB: their clothes, skin and hair, and the bike's frame. */
export interface RiderLook {
  shirt: number;
  shorts: number;
  skin: number;
  hair: number;
  frame: number;
}

/** Where a rider is and what they're doing, this frame. */
export interface RiderPose {
  x: number;
  /** The ground under the wheels, as drawn (m). */
  y: number;
  z: number;
  /** Which way they ride: 0 is +z, as the walker's heading. */
  heading: number;
  /** Into a turn (radians, positive tips the bike to its right). */
  lean: number;
  /** The pedals' turn (radians). */
  pedal: number;
  braking: boolean;
}

export interface Riders {
  /** The body, the ink hull and the x-ray, to add to the scene (or not). */
  readonly meshes: readonly InstancedMesh[];
  /** How many ride this frame: the first `count` instances are drawn. */
  count: number;
  /** Places the i-th rider. */
  pose(i: number, at: RiderPose): void;
  /** Dresses the i-th rider. */
  dress(i: number, look: RiderLook): void;
  dispose(): void;
}

const srgb = (hex: number): V3 => [
  ((hex >> 16) & 255) / 255,
  ((hex >> 8) & 255) / 255,
  (hex & 255) / 255,
];
const LOOKS = ['shirt', 'shorts', 'skin', 'hair', 'frame'] as const;

/**
 * Up to `most` riders as instances of one rider: three draw calls (the x-ray first, then the
 * body and its hull) whatever the count, nothing while none ride.
 */
export function createRiders(kit: RiderKit, scene: Scene, most: number): Riders {
  const { three } = kit;
  const { material, inkMaterial, xrayMaterial } = riderMaterials(kit);
  const body = new kit.MeshBuilder();
  addRider(body, false);
  const hull = new kit.MeshBuilder();
  addRider(hull, true);
  const [bodyGeometry, hullGeometry] = [body, hull].map((b) =>
    b.build({ facade: true, keep: true }),
  ) as [BufferGeometry, BufferGeometry];
  const state = new three.InstancedBufferAttribute(new Float32Array(most * 4), 4);
  bodyGeometry.setAttribute('state', state);
  hullGeometry.setAttribute('state', state);
  const looks = Object.fromEntries(
    LOOKS.map((name) => {
      const attribute = new three.InstancedBufferAttribute(new Float32Array(most * 3), 3);
      bodyGeometry.setAttribute(name, attribute);
      return [name, attribute];
    }),
  ) as Record<(typeof LOOKS)[number], InstancedBufferAttribute>;
  const rider = new three.InstancedMesh(bodyGeometry, material, most);
  rider.receiveShadow = true;
  const ink = new three.InstancedMesh(hullGeometry, inkMaterial, most);
  ink.instanceMatrix = rider.instanceMatrix;
  const xray = new three.InstancedMesh(bodyGeometry, xrayMaterial, most);
  xray.instanceMatrix = rider.instanceMatrix;
  [xray.renderOrder, rider.renderOrder, ink.renderOrder] = [1, 2, 2];
  const meshes = [rider, ink, xray];
  for (const mesh of meshes) {
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.visible = false;
    scene.add(mesh);
  }
  const matrix = new three.Matrix4();
  const tilt = new three.Matrix4();
  return {
    meshes,
    get count() {
      return rider.count;
    },
    set count(n) {
      for (const mesh of meshes) {
        mesh.count = n;
        mesh.visible = n > 0;
      }
    },
    pose(i, at) {
      const yaw = Math.atan2(-Math.cos(at.heading), Math.sin(at.heading));
      matrix.makeRotationY(yaw).multiply(tilt.makeRotationX(at.lean));
      matrix.setPosition(at.x, at.y + RIDE_HEIGHT, at.z);
      rider.setMatrixAt(i, matrix);
      rider.instanceMatrix.needsUpdate = true;
      const s = state.array as Float32Array;
      s[i * 4] = at.pedal;
      s[i * 4 + 1] = at.braking ? 1 : 0;
      state.needsUpdate = true;
    },
    dress(i, look) {
      for (const name of LOOKS) {
        looks[name].array.set(srgb(look[name]), i * 3);
        looks[name].needsUpdate = true;
      }
    },
    dispose() {
      for (const mesh of meshes) scene.remove(mesh);
      bodyGeometry.dispose();
      hullGeometry.dispose();
      material.dispose();
      inkMaterial.dispose();
      xrayMaterial.dispose();
    },
  };
}
