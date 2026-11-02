import type { City } from '../data/city.ts';
import type {
  BackSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshToonMaterial,
  Texture,
  WebGLProgramParametersWithUniforms,
} from 'three';

import type { MeshBuilder, V3 } from './mesh-builder.ts';
import { BUS, GUESTS, PROPS, WINDOW } from './palette.ts';
import { TURN_RATE, Traffic, VEHICLE_KINDS, turnTowards } from './traffic.ts';
import type { Vehicle, VehicleKind } from './traffic.ts';

/**
 * The traffic, drawn: the vehicles' shapes, one instanced mesh per kind with an ink hull
 * sharing its matrices, and the layer that moves them each frame. This is the traffic chunk's
 * entry (traffic.ts is the simulation); the viewer loads it once the first frame is drawn and
 * hands it what it shares with the engine as a `kit`, like the furniture.
 *
 * Shapes are a few boxes each, in their own frame: x ahead, y up, z to the right. Vertex colours
 * carry what never changes; the `facade` attribute says what does, as a part code: PAINT takes
 * the instance's colour, HEAD and TAIL glow at night and the tail with the brakes, the SIGNALs
 * blink before a turn, the BEAM is the headlamps' pool on the street at night, and the LEGs and
 * ARMs swing with the stride (the code's fraction is the joint's height, in tenths of a metre).
 */
export const PART = {
  plain: 0,
  head: 1,
  tail: 2,
  paint: 3,
  signalL: 4,
  signalR: 5,
  beam: 6,
  legL: 7,
  legR: 8,
  armL: 9,
  armR: 10,
} as const;

type Builder = Pick<MeshBuilder, 'quad' | 'triangle'>;

/** A swinging limb's part code: the part, with the joint's height folded into the fraction. */
const jointed = (part: number, pivot: number) => part + Math.min(0.99, pivot / 10);

const c = (x: number, y: number, z: number): V3 => [x, y, z];

/** Which faces of a box to write. The bottom is left out unless asked: nobody sees it. */
export const FACE = { top: 1, bottom: 2, front: 4, back: 8, right: 16, left: 32 } as const;
const ALL_BUT_BOTTOM = FACE.top | FACE.front | FACE.back | FACE.right | FACE.left;

/** An axis-aligned box in one colour, with one part code, as many of its faces as asked. */
export function boxOf(
  mesh: Builder,
  [x0, x1]: readonly [number, number],
  [y0, y1]: readonly [number, number],
  [z0, z1]: readonly [number, number],
  color: number,
  part = PART.plain as number,
  faces: number = ALL_BUT_BOTTOM,
): void {
  if (faces & FACE.top)
    mesh.quad(c(x0, y1, z0), c(x1, y1, z0), c(x1, y1, z1), c(x0, y1, z1), color, [0, 1, 0], part);
  if (faces & FACE.front)
    mesh.quad(c(x1, y0, z0), c(x1, y0, z1), c(x1, y1, z1), c(x1, y1, z0), color, [1, 0, 0], part);
  if (faces & FACE.back)
    mesh.quad(c(x0, y0, z1), c(x0, y0, z0), c(x0, y1, z0), c(x0, y1, z1), color, [-1, 0, 0], part);
  if (faces & FACE.right)
    mesh.quad(c(x0, y0, z1), c(x1, y0, z1), c(x1, y1, z1), c(x0, y1, z1), color, [0, 0, 1], part);
  if (faces & FACE.left)
    mesh.quad(c(x1, y0, z0), c(x0, y0, z0), c(x0, y1, z0), c(x1, y1, z0), color, [0, 0, -1], part);
  if (faces & FACE.bottom)
    mesh.quad(c(x0, y0, z1), c(x0, y0, z0), c(x1, y0, z0), c(x1, y0, z1), color, [0, -1, 0], part);
}

/** A box whose top is smaller than its base: a cabin with sloping glass, a cap. */
function taper(
  mesh: Builder,
  base: readonly [x0: number, x1: number, z0: number, z1: number],
  top: readonly [x0: number, x1: number, z0: number, z1: number],
  [y0, y1]: readonly [number, number],
  sides: number,
  cap: number,
  sidePart = PART.plain as number,
  capPart = PART.plain as number,
): void {
  const [bx0, bx1, bz0, bz1] = base;
  const [tx0, tx1, tz0, tz1] = top;
  mesh.quad(
    c(tx0, y1, tz0),
    c(tx1, y1, tz0),
    c(tx1, y1, tz1),
    c(tx0, y1, tz1),
    cap,
    [0, 1, 0],
    capPart,
  );
  mesh.quad(
    c(bx1, y0, bz0),
    c(bx1, y0, bz1),
    c(tx1, y1, tz1),
    c(tx1, y1, tz0),
    sides,
    [1, 0.5, 0],
    sidePart,
  );
  mesh.quad(
    c(bx0, y0, bz1),
    c(bx0, y0, bz0),
    c(tx0, y1, tz0),
    c(tx0, y1, tz1),
    sides,
    [-1, 0.5, 0],
    sidePart,
  );
  mesh.quad(
    c(bx0, y0, bz1),
    c(bx1, y0, bz1),
    c(tx1, y1, tz1),
    c(tx0, y1, tz1),
    sides,
    [0, 0.5, 1],
    sidePart,
  );
  mesh.quad(
    c(bx1, y0, bz0),
    c(bx0, y0, bz0),
    c(tx0, y1, tz0),
    c(tx1, y1, tz0),
    sides,
    [0, 0.5, -1],
    sidePart,
  );
}

/** A small quad flat on an end face (x = `x`, facing ahead or back) in a part's colour. */
function lampAt(
  mesh: Builder,
  x: number,
  y: number,
  z: number,
  part: number,
  color: number,
  half: readonly [number, number] = [0.1, 0.16],
): void {
  const dir = x > 0 ? 1 : -1;
  const p = (dy: number, dz: number): V3 => [x + dir * 0.01, y + dy, z + dz];
  const [h, w] = half;
  const [a, b, d, e] = [p(-h, -w), p(-h, w), p(h, w), p(h, -w)];
  if (dir > 0) mesh.quad(a, b, d, e, color, [1, 0, 0], part);
  else mesh.quad(b, a, e, d, color, [-1, 0, 0], part);
}

/** The headlamps' pool of light on the street ahead (drawn at night by the shader). */
function beam(mesh: Builder, from: number, to: number, nearHalf: number, farHalf: number): void {
  const y = 0.02;
  mesh.quad(
    c(from, y, -nearHalf),
    c(from, y, nearHalf),
    c(to, y, farHalf),
    c(to, y, -farHalf),
    BUS.headlamp,
    [0, 1, 0],
    [PART.beam, PART.beam, PART.beam + 0.95, PART.beam + 0.95],
  );
}

/** A wheel: a dark box without its hidden top, a pale hub on its outer face. */
function wheel(
  mesh: Builder,
  x: number,
  z: number,
  radius: number,
  width: number,
  g: number,
): void {
  const side = Math.sign(z);
  boxOf(
    mesh,
    [x - radius * g, x + radius * g],
    [0, 2 * radius * g],
    [z - width * g, z + width * g],
    PROPS.wheel,
    PART.plain,
    FACE.front | FACE.back | FACE.right | FACE.left | FACE.bottom,
  );
  if (g !== 1) return;
  const [hx, hy, hz] = [x, radius, z + side * (width + 0.005)];
  const r = radius * 0.45;
  const p = (dx: number, dy: number): V3 => [hx + dx, hy + dy, hz];
  if (side > 0) mesh.quad(p(-r, -r), p(r, -r), p(r, r), p(-r, r), PROPS.spokes, [0, 0, 1]);
  else mesh.quad(p(r, -r), p(-r, -r), p(-r, r), p(r, r), PROPS.spokes, [0, 0, -1]);
}

const PLATE = 0xf1ede2;
const AMBER = 0xf0a020;

/**
 * A hatchback: a painted body with a bonnet and a boot, a cabin of sloping glass under a painted
 * roof, four wheels with hubs, headlamps, tail lamps, indicators, number plates and a beam.
 */
export function addCar(mesh: Builder, g = 1): void {
  boxOf(mesh, [-2.1 * g, 2.1 * g], [0.3, 0.82 * g], [-0.88 * g, 0.88 * g], 0xffffff, PART.paint);
  boxOf(
    mesh,
    [0.7 * g, 2.05 * g],
    [0.82 * g, 0.98 * g],
    [-0.84 * g, 0.84 * g],
    0xffffff,
    PART.paint,
  );
  boxOf(
    mesh,
    [-2.05 * g, -1.1 * g],
    [0.82 * g, 1.02 * g],
    [-0.84 * g, 0.84 * g],
    0xffffff,
    PART.paint,
  );
  taper(
    mesh,
    [-1.15 * g, 0.75 * g, -0.82 * g, 0.82 * g],
    [-0.95 * g, 0.35 * g, -0.7 * g, 0.7 * g],
    [0.82 * g, 1.48 * g],
    WINDOW.glass,
    0xffffff,
    PART.plain,
    PART.paint,
  );
  for (const x of [-1.35, 1.35]) for (const z of [-0.8, 0.8]) wheel(mesh, x, z, 0.33, 0.12, g);
  if (g !== 1) return;
  for (const z of [-0.6, 0.6]) {
    lampAt(mesh, 2.1, 0.7, z, PART.head, BUS.headlamp);
    lampAt(mesh, -2.1, 0.7, z, PART.tail, BUS.taillamp);
    const signal = z < 0 ? PART.signalL : PART.signalR;
    lampAt(mesh, 2.1, 0.7, z + Math.sign(z) * 0.22, signal, AMBER, [0.06, 0.06]);
    lampAt(mesh, -2.1, 0.7, z + Math.sign(z) * 0.22, signal, AMBER, [0.06, 0.06]);
  }
  lampAt(mesh, 2.1, 0.45, 0, PART.plain, PLATE, [0.06, 0.25]);
  lampAt(mesh, -2.1, 0.45, 0, PART.plain, PLATE, [0.06, 0.25]);
  beam(mesh, 2.1, 8, 0.9, 2);
}

/**
 * A city bus: a long cream body under a slightly inset roof, a band of windows and a coloured
 * stripe down each side, a door, a windscreen, wheels, lamps, indicators and a beam.
 */
export function addBus(mesh: Builder, g = 1): void {
  boxOf(mesh, [-6 * g, 6 * g], [0.45, 3.1 * g], [-1.25 * g, 1.25 * g], 0xffffff, PART.paint);
  boxOf(mesh, [-5.8 * g, 5.8 * g], [3.1 * g, 3.3 * g], [-1.1 * g, 1.1 * g], 0xffffff, PART.paint);
  for (const x of [-4, 4]) for (const z of [-1.1, 1.1]) wheel(mesh, x, z, 0.5, 0.15, g);
  if (g !== 1) return;
  for (const side of [-1, 1]) {
    const z = side * 1.26;
    const n: V3 = [0, 0, side];
    const p = (x: number, y: number): V3 => [x, y, z];
    const band = (x0: number, x1: number, y0: number, y1: number, color: number) => {
      if (side > 0) mesh.quad(p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1), color, n);
      else mesh.quad(p(x1, y0), p(x0, y0), p(x0, y1), p(x1, y1), color, n);
    };
    band(-5.6, 5.6, 1.7, 2.7, WINDOW.glass);
    band(-5.9, 5.9, 1.15, 1.45, BUS.band);
    // The door, on the right, behind the front wheel.
    if (side > 0) band(2.2, 3.4, 0.5, 2.7, 0x8a8f96);
  }
  lampAt(mesh, 6, 2.2, 0, PART.plain, WINDOW.glass, [0.7, 1.1]);
  for (const z of [-0.85, 0.85]) {
    lampAt(mesh, 6, 0.9, z, PART.head, BUS.headlamp, [0.12, 0.2]);
    lampAt(mesh, -6, 0.9, z, PART.tail, BUS.taillamp, [0.12, 0.2]);
    const signal = z < 0 ? PART.signalL : PART.signalR;
    lampAt(mesh, 6, 0.9, z + Math.sign(z) * 0.3, signal, AMBER, [0.08, 0.08]);
    lampAt(mesh, -6, 0.9, z + Math.sign(z) * 0.3, signal, AMBER, [0.08, 0.08]);
  }
  beam(mesh, 6, 12, 1.2, 2.4);
}

/** A flat wheel seen from both sides: a thin disc as two quads. */
function disc(mesh: Builder, x: number, radius: number, g: number): void {
  const [r, y] = [radius * g, radius * g];
  for (const side of [-1, 1]) {
    const p = (dx: number, dy: number): V3 => [x + dx, y + dy, side * 0.03 * g];
    if (side > 0) mesh.quad(p(-r, -r), p(r, -r), p(r, r), p(-r, r), PROPS.wheel, [0, 0, 1]);
    else mesh.quad(p(r, -r), p(-r, -r), p(-r, r), p(r, r), PROPS.wheel, [0, 0, -1]);
  }
}

/**
 * A cyclist: two wheels, a frame, bars and a saddle, and a rider whose legs pump with the
 * pedals, a shirt in the instance's colour, arms to the bars, a head and hair; a lamp in front
 * and a reflector behind, lit at night.
 */
export function addBike(mesh: Builder, g = 1): void {
  for (const x of [-0.55, 0.55]) disc(mesh, x, 0.34, g);
  boxOf(mesh, [-0.5 * g, 0.5 * g], [0.5, 0.6 * g], [-0.04 * g, 0.04 * g], PROPS.iron);
  boxOf(mesh, [0.42 * g, 0.5 * g], [0.6 * g, 1.02 * g], [-0.04 * g, 0.04 * g], PROPS.iron);
  boxOf(mesh, [0.4 * g, 0.5 * g], [1.0 * g, 1.06 * g], [-0.3 * g, 0.3 * g], PROPS.iron);
  boxOf(mesh, [-0.3 * g, -0.1 * g], [0.9 * g, 0.98 * g], [-0.1 * g, 0.1 * g], 0x2b2420);
  // The rider: legs hinged at the hip, pumping; arms reaching the bars; body, head, hair.
  const hip = 0.95;
  for (const [z, part] of [
    [-0.1, PART.legL],
    [0.1, PART.legR],
  ] as const) {
    boxOf(
      mesh,
      [-0.08 * g, 0.12 * g],
      [0.4, hip * g],
      [z - 0.07 * g, z + 0.07 * g],
      GUESTS.legs[0]!,
      jointed(part, hip),
    );
  }
  boxOf(mesh, [-0.18 * g, 0.12 * g], [0.9, 1.5 * g], [-0.2 * g, 0.2 * g], 0xffffff, PART.paint);
  for (const z of [-0.24, 0.24]) {
    boxOf(
      mesh,
      [-0.1 * g, 0.42 * g],
      [1.05, 1.42 * g],
      [z - 0.05 * g, z + 0.05 * g],
      GUESTS.skin[1]!,
    );
  }
  boxOf(mesh, [-0.06 * g, 0.22 * g], [1.5, 1.78 * g], [-0.13 * g, 0.13 * g], GUESTS.skin[1]!);
  boxOf(mesh, [-0.08 * g, 0.24 * g], [1.72, 1.84 * g], [-0.15 * g, 0.15 * g], GUESTS.hair[1]!);
  if (g !== 1) return;
  lampAt(mesh, 0.52, 0.85, 0, PART.head, BUS.headlamp, [0.04, 0.04]);
  lampAt(mesh, -0.5, 0.75, 0, PART.tail, BUS.taillamp, [0.03, 0.04]);
}

/**
 * Someone on foot: legs and arms swinging with the stride, a shirt in the instance's colour,
 * a head and hair. Half the size of a cyclist's rider, give or take: a walker among walkers.
 */
export function addPerson(mesh: Builder, g = 1): void {
  const hip = 0.85;
  const shoulder = 1.45;
  for (const [z, part] of [
    [-0.09, PART.legL],
    [0.09, PART.legR],
  ] as const) {
    boxOf(
      mesh,
      [-0.08 * g, 0.08 * g],
      [0, hip * g],
      [z - 0.08 * g, z + 0.08 * g],
      GUESTS.legs[0]!,
      jointed(part, hip),
    );
  }
  boxOf(mesh, [-0.13 * g, 0.13 * g], [0.8, 1.5 * g], [-0.21 * g, 0.21 * g], 0xffffff, PART.paint);
  for (const [z, part] of [
    [-0.27, PART.armL],
    [0.27, PART.armR],
  ] as const) {
    boxOf(
      mesh,
      [-0.06 * g, 0.06 * g],
      [0.85, shoulder * g],
      [z - 0.06 * g, z + 0.06 * g],
      GUESTS.skin[2]!,
      jointed(part, shoulder),
    );
  }
  boxOf(mesh, [-0.11 * g, 0.11 * g], [1.5, 1.78 * g], [-0.12 * g, 0.12 * g], GUESTS.skin[2]!);
  boxOf(mesh, [-0.13 * g, 0.13 * g], [1.7, 1.84 * g], [-0.14 * g, 0.14 * g], GUESTS.hair[2]!);
}

export const SHAPES: Record<VehicleKind, (mesh: Builder, grow?: number) => void> = {
  car: addCar,
  bus: addBus,
  bike: addBike,
  person: addPerson,
};

/** Each shape's ink hull: the same boxes grown a little, drawn inside out behind it. */
export const HULL_GROW = 1.06;

/** How far over the carriageway's surface the wheels ride, so they never sink in it (m). */
export const RIDE_HEIGHT = 0.03;

/**
 * The vertex shader's share of the parts: limbs swing about their joint with the stride; the
 * part and the beam's fade go to the fragment shader. For the body's material and its ink's.
 */
export function vehicleVertexShader(vertexShader: string): string {
  return vertexShader
    .replace(
      '#include <common>',
      `#include <common>
      attribute float facade;
      attribute vec3 paint;
      attribute vec4 state;
      varying float vPart;
      varying float vFade;
      varying vec4 vState;`,
    )
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      float part = floor(facade);
      if (part >= ${PART.legL}.0 && part <= ${PART.armR}.0) {
        // Left leg and right arm swing together, as a stride does; legs further than arms.
        float leg = step(part, ${PART.legR}.5);
        float side = (part == ${PART.legL}.0 || part == ${PART.armR}.0) ? 1.0 : -1.0;
        float a = side * mix(0.4, 0.55, leg) * sin(state.x);
        float pivot = fract(facade) * 10.0;
        vec2 d = vec2(transformed.x, transformed.y - pivot);
        transformed.x = d.x * cos(a) - d.y * sin(a);
        transformed.y = pivot + d.x * sin(a) + d.y * cos(a);
      }
      vPart = part;
      vFade = 1.0 - fract(facade);
      vState = state;`,
    );
}

/** The three.js classes the layer takes from the engine, so this chunk imports none itself. */
export interface TrafficThree {
  InstancedMesh: typeof InstancedMesh;
  InstancedBufferAttribute: typeof InstancedBufferAttribute;
  Matrix4: typeof Matrix4;
  MeshToonMaterial: typeof MeshToonMaterial;
  MeshBasicMaterial: typeof MeshBasicMaterial;
  BackSide: typeof BackSide;
}

/** What the chunk takes from the engine rather than importing it, as the furniture does. */
export interface TrafficKit {
  three: TrafficThree;
  MeshBuilder: typeof MeshBuilder;
  linearVertexColors: (vertexShader: string) => string;
  /** The 4×4 ordered dither, GLSL, for the beams' fade (facade-material.ts). */
  bayer: string;
  city: Pick<City, 'ways'>;
  /** The ground a vehicle rides on at a spot: the carriageway as drawn (m). */
  ground: (x: number, z: number) => number;
  gradientMap: Texture;
  /** How far into the night it is, for the lamps (the facade material's uniform). */
  night: { value: number };
  ink: number;
}

export interface TrafficLayer {
  /** The meshes to add to the scene: a body and an ink hull per kind. */
  meshes: InstancedMesh[];
  traffic: Traffic;
  /**
   * Keeps the fleet round a spot (the view's target) within `radius`, steps the traffic and
   * moves every instance; returns how many vehicles are on the streets.
   */
  update(dt: number, x: number, z: number, radius: number): number;
  dispose(): void;
}

/**
 * The traffic on the streets, drawn: one instanced mesh per kind, with an inverted hull in ink
 * behind it sharing its matrices, two draw calls a kind. Bodies take the city's toon shading
 * and its shadows; `paint` colours the painted parts per instance and `state` (the stride,
 * the brakes, the indicator, a blink offset) drives the limbs and the lamps.
 */
export function createTrafficLayer(kit: TrafficKit, seed = 1): TrafficLayer {
  const { three, MeshBuilder, linearVertexColors, gradientMap, night } = kit;
  const traffic = new Traffic(kit.city.ways, seed);
  const time = { value: 0 };
  const material = new three.MeshToonMaterial({ vertexColors: true, gradientMap });
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uNight = night;
    shader.uniforms.uTime = time;
    // The paint is sRGB like the vertex colours: swapped in right after them, so the
    // linearisation that follows the include takes it too.
    shader.vertexShader = linearVertexColors(vehicleVertexShader(shader.vertexShader)).replace(
      '#include <color_vertex>',
      `#include <color_vertex>\nif (abs(facade - ${PART.paint}.0) < 0.5) vColor.rgb = paint;`,
    );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uNight;
        uniform float uTime;
        varying float vPart;
        varying float vFade;
        varying vec4 vState;
        ${kit.bayer}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        // The beam: a pool of light on the street, dithered out towards its far end, at night.
        if (vPart == ${PART.beam}.0 && bayer4(gl_FragCoord.xy) >= uNight * vFade * 0.7) discard;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        if (vPart == ${PART.head}.0) totalEmissiveRadiance += vec3(1.0, 0.92, 0.7) * uNight;
        else if (vPart == ${PART.tail}.0) totalEmissiveRadiance += vec3(0.9, 0.08, 0.04) * (0.6 * uNight + 0.9 * vState.y);
        else if (vPart == ${PART.beam}.0) totalEmissiveRadiance += vec3(0.8, 0.72, 0.5);
        else if (vPart == ${PART.signalL}.0 || vPart == ${PART.signalR}.0) {
          float wanted = vPart == ${PART.signalL}.0 ? step(vState.z, -0.5) : step(0.5, vState.z);
          float blink = step(0.5, fract(uTime * 1.2 + vState.w));
          totalEmissiveRadiance += vec3(1.0, 0.6, 0.1) * wanted * blink;
        }`,
      );
  };
  material.customProgramCacheKey = () => 'vehicle-v2';
  const inkMaterial = new three.MeshBasicMaterial({ color: kit.ink, side: three.BackSide });
  inkMaterial.onBeforeCompile = (shader) => {
    shader.vertexShader = vehicleVertexShader(shader.vertexShader);
    // The hull has no lamps and no beam: nothing of it is discarded or lit.
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vPart;\nvarying float vFade;\nvarying vec4 vState;',
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>\nif (vPart == ${PART.beam}.0) discard;`,
      );
  };
  inkMaterial.customProgramCacheKey = () => 'vehicle-ink-v2';
  const meshes: InstancedMesh[] = [];
  const matrix = new three.Matrix4();
  const groups: { mesh: InstancedMesh; state: InstancedBufferAttribute; vehicles: Vehicle[] }[] =
    [];
  for (const kind of VEHICLE_KINDS) {
    const vehicles = traffic.vehicles.filter((v) => v.kind === kind);
    const body = new MeshBuilder();
    SHAPES[kind](body);
    const hull = new MeshBuilder();
    SHAPES[kind](hull, HULL_GROW);
    const geometry = body.build({ facade: true, keep: true });
    const paint = new Float32Array(vehicles.length * 3);
    for (const [i, v] of vehicles.entries()) paint.set(v.paint, i * 3);
    geometry.setAttribute('paint', new three.InstancedBufferAttribute(paint, 3));
    const state = new three.InstancedBufferAttribute(new Float32Array(vehicles.length * 4), 4);
    geometry.setAttribute('state', state);
    const mesh = new three.InstancedMesh(geometry, material, vehicles.length);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    const hullGeometry = hull.build({ facade: true, keep: true });
    hullGeometry.setAttribute('state', state);
    const ink = new three.InstancedMesh(hullGeometry, inkMaterial, vehicles.length);
    ink.instanceMatrix = mesh.instanceMatrix;
    ink.frustumCulled = false;
    meshes.push(mesh, ink);
    groups.push({ mesh, state, vehicles });
  }
  const spot: [number, number, number, number] = [0, 0, 0, 0];
  return {
    meshes,
    traffic,
    update(dt, fx, fz, radius) {
      traffic.focus(fx, fz, radius);
      traffic.step(dt);
      time.value += dt;
      let drawn = 0;
      for (const { mesh, state, vehicles } of groups) {
        const states = state.array as Float32Array;
        for (const [i, v] of vehicles.entries()) {
          if (!v.active) {
            // Parked out of sight: nothing of it, until it is let out again.
            mesh.setMatrixAt(i, matrix.makeScale(0, 0, 0));
            continue;
          }
          drawn++;
          traffic.place(v, spot);
          const [x, z, dx, dz] = spot;
          // Local x ahead: a turn about y by atan2(-dz, dx) takes it to (dx, dz). The drawn
          // heading swings after the path's, so a corner is a turn, not a snap.
          v.yaw = turnTowards(v.yaw, Math.atan2(-dz, dx), TURN_RATE[v.kind], dt);
          matrix.makeRotationY(v.yaw);
          matrix.setPosition(x, kit.ground(x, z) + RIDE_HEIGHT, z);
          mesh.setMatrixAt(i, matrix);
          states[i * 4] = v.phase;
          states[i * 4 + 1] = v.brake;
          states[i * 4 + 2] = v.signal;
          states[i * 4 + 3] = v.blink;
        }
        mesh.instanceMatrix.needsUpdate = true;
        state.needsUpdate = true;
      }
      return drawn;
    },
    dispose() {
      for (const m of meshes) {
        m.dispose();
        m.geometry.dispose();
      }
      material.dispose();
      inkMaterial.dispose();
    },
  };
}
