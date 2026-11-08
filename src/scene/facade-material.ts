import {
  Color,
  DataTexture,
  LinearFilter,
  MeshBasicMaterial,
  MeshToonMaterial,
  RGBAFormat,
  Vector2,
  Vector4,
} from 'three';
import type { Texture } from 'three';

import { SHOP_KINDS } from '../data/shop-kinds.ts';
import {
  AWNING,
  CROWN,
  LANCETS,
  ORNATE,
  PANE,
  ROOF,
  ROOF_FLAT,
  SHOP_FRONT,
} from './facade-codes.ts';
import { LUMA, SHADE_CHROMA, SHADE_HUE, SHADE_RANGE } from './lighting.ts';
import { LIFT_UNIT, linearVertexColors } from './mesh-builder.ts';
import {
  ANGLES,
  LINE_LOD,
  PAINT_GRADE,
  PAINT_HALF,
  PAINT_KIND,
  STRIPE_LOD,
  SURFACE,
} from './paint.ts';
import { FRONTS, OUTLINE, WINDOW } from './palette.ts';
import { SLEEPER_CODE } from './rails.ts';

const f = (v: number) => v.toFixed(4);
/** How much of the ground the darkest contact shadow covers, in pixels of its dither. */
const CONTACT_DARK = 0.36;
/** A 4×4 ordered dither: a threshold from 0 to 15/16 for each pixel of a block. */
export const BAYER = `float bayer2(vec2 a) { a = mod(floor(a), 2.0); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }`;

/** What every material lit by the street lamps reads (`LAMP_FRAGMENT`). */
export interface LampLight {
  map: { value: Texture };
  /** The field's corner (x, z) and one over its size (m). */
  box: { value: Vector4 };
  /** The ground heights its alpha runs between (m). */
  height: { value: Vector2 };
  /** How far on the lamps are, 0 to 1. */
  on: { value: number };
  /** How many device pixels make one pixel of the dither. */
  cell: { value: number };
}

function dark(): DataTexture {
  const texture = new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

/** The lamps, off, over a black field, until `setLightField` has one to show. */
export function lampLight(): LampLight {
  return {
    map: { value: dark() },
    box: { value: new Vector4(0, 0, 1, 1) },
    height: { value: new Vector2() },
    on: { value: 0 },
    cell: { value: 1 },
  };
}

/** The baked light (lamp-light.ts) as a texture the shaders can sample, filtered smooth. */
export function setLightField(
  light: LampLight,
  field: {
    data: Uint8Array;
    width: number;
    height: number;
    minX: number;
    minZ: number;
    texel: number;
    low: number;
    high: number;
  },
): void {
  const texture = new DataTexture(
    field.data as Uint8Array<ArrayBuffer>,
    field.width,
    field.height,
    RGBAFormat,
  );
  texture.magFilter = texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  light.map.value = texture;
  light.box.value.set(
    field.minX,
    field.minZ,
    1 / (field.width * field.texel),
    1 / (field.height * field.texel),
  );
  light.height.value.set(field.low, field.high);
}

const LAMP_UNIFORMS = `uniform sampler2D uLightMap;
uniform vec4 uLightBox;
uniform vec2 uLightHeight;
uniform float uLamps;
uniform float uDitherCell;`;

/**
 * What the lamps add to a surface at `vWorld`, as light on its own colour rather than a sticker
 * over it, so the setts under a lamp stay setts: the field's light, gone by 7 m over the ground
 * under it (a wall's foot is lit and its eaves aren't, nor is a roof), in five steps with the
 * ordered dither between them, the pixel pattern of everything else here.
 */
const LAMP_FRAGMENT = `if (uLamps > 0.0) {
  vec4 lampField = texture2D(uLightMap, (vWorld.xz - uLightBox.xy) * uLightBox.zw);
  float lampHigh = vWorld.y - mix(uLightHeight.x, uLightHeight.y, lampField.a);
  vec3 lampRay = lampField.rgb * (1.0 - smoothstep(1.2, 7.0, lampHigh));
  float lampMost = max(lampRay.r, max(lampRay.g, lampRay.b));
  if (lampMost > 0.004) {
    float lampStep = floor(lampMost * 5.0 + bayer4(gl_FragCoord.xy / uDitherCell)) / 5.0;
    totalEmissiveRadiance += diffuseColor.rgb * (lampRay / lampMost) * lampStep * 1.7 * uLamps;
  }
}`;

/** Hands a toon material's shader the lamps' uniforms. */
function withLamps(uniforms: Record<string, { value: unknown }>, light: LampLight): void {
  uniforms.uLightMap = light.map;
  uniforms.uLightBox = light.box;
  uniforms.uLightHeight = light.height;
  uniforms.uLamps = light.on;
  uniforms.uDitherCell = light.cell;
}

/**
 * The one material every cell draws with: toon shading plus detail from world position.
 * - Walls (`facade` > 0 holds the wall top, plus a code for a church or a shop front's kind,
 *   facade-codes.ts): windows in each building's own rhythm, or a church's tall pointed lancets,
 *   fading to an average wall tint when a window shrinks below two pixels instead of aliasing
 *   into stripes. A shop front glazes the ground floor under its kind's canvas (`FRONTS`).
 * - Awnings (storefronts.ts): striped in their kind's second colour.
 * - Road surfaces (`facade` a small negative code, paint.ts): asphalt patches, setts, paving
 *   joints, each fading out before it's finer than a pixel.
 * - Road paint (larger negative codes): the vertex shader widens a line to cover a whole pixel, or
 *   folds away a mark too fine to see and shows its average instead.
 * - Railway sleepers (codes from `SLEEPER_CODE`, rails.ts): a band of them along each track, from
 *   the distance along it, fading to their average tint when they get finer than a pixel.
 * - Shade everywhere keeps a richer version of its surface's own hue (lighting.ts).
 * None of it costs a triangle.
 */
export function createFacadeMaterial(
  gradientMap: Texture,
  light: LampLight = lampLight(),
): MeshToonMaterial {
  // Faces sit a hair behind their ink lines, so outlines draw solid instead of dashed.
  const material = new MeshToonMaterial({
    vertexColors: true,
    gradientMap,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const glass = new Color(WINDOW.glass);
  const lit = new Color(WINDOW.lit);
  const pixel = { value: 1 };
  material.userData.pixel = pixel;
  const night = { value: 0 };
  material.userData.night = night;
  const crowns = { value: 0 };
  material.userData.crowns = crowns;
  // Each kind of shop front as two vec4s: its canvas and whether its panes are warm, its stripe
  // and whether it shows goods.
  const fronts = SHOP_KINDS.flatMap((kind) => {
    const { canvas, stripe = canvas, lit: warm, goods } = FRONTS[kind];
    const [a, b] = [new Color(canvas), new Color(stripe)];
    return [new Vector4(a.r, a.g, a.b, warm ? 1 : 0), new Vector4(b.r, b.g, b.b, goods ? 1 : 0)];
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGlass = { value: glass };
    shader.uniforms.uLit = { value: lit };
    shader.uniforms.uFront = { value: fronts };
    shader.uniforms.uPixel = pixel;
    shader.uniforms.uNight = night;
    shader.uniforms.uCrowns = crowns;
    withLamps(shader.uniforms, light);
    shader.vertexShader = linearVertexColors(shader.vertexShader)
      .replace(
        '#include <common>',
        `#include <common>
        attribute float facade;
        attribute float lift;
        uniform float uPixel;
        uniform float uCrowns;
        varying float vFacade;
        varying float vLift;
        varying vec3 vWorld;
        varying vec2 vWallNormal;
        varying float vUp;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        // Up close the puffs of leaves take over from the crown, which goes.
        if (facade > ${f(CROWN - 0.5)} && uCrowns > 0.5) transformed = vec3(0.0);
        float paint = -facade;
        if (paint >= ${f(ANGLES * 2)} && paint < ${f(SLEEPER_CODE)}) {
          float kind = floor(paint / ${f(ANGLES * 2)});
          float rest = paint - kind * ${f(ANGLES * 2)};
          float side = mod(rest, 2.0) * 2.0 - 1.0;
          float angle = floor(rest / 2.0) * PI / ${f(ANGLES)};
          vec2 across = vec2(cos(angle), sin(angle));
          float reach = kind == ${f(PAINT_KIND.line)} ? ${f(PAINT_HALF.line)}
            : kind == ${f(PAINT_KIND.block)} ? ${f(PAINT_HALF.block)}
            : kind == ${f(PAINT_KIND.patch)} ? ${f(PAINT_HALF.patch)} : ${f(PAINT_HALF.stripe)};
          float want = reach;
          if (kind == ${f(PAINT_KIND.line)}) {
            // Screen size of a metre across the line, measured square to it on screen.
            vec2 a = (modelViewMatrix * vec4(across.x, 0.0, across.y, 0.0)).xy;
            vec2 t = (modelViewMatrix * vec4(-across.y, 0.0, across.x, 0.0)).xy;
            float scale = abs(t.x * a.y - t.y * a.x) / max(length(t), 1e-4);
            want = uPixel > ${f(LINE_LOD)} ? 0.0 : max(reach, 0.5 * uPixel / max(scale, 0.2));
          } else if (kind == ${f(PAINT_KIND.patch)}) {
            want = uPixel > ${f(STRIPE_LOD)} ? reach : 0.0;
          } else {
            want = uPixel > ${f(STRIPE_LOD)} ? 0.0 : reach;
          }
          transformed.xz += across * side * (want - reach);
          transformed.y += max(want - reach, 0.0) * ${f(PAINT_GRADE)};
        }`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vFacade = facade;
        vLift = lift * ${f(LIFT_UNIT)};
        vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWallNormal = normalize((modelMatrix * vec4(objectNormal, 0.0)).xz + 1e-5);
        vUp = (modelMatrix * vec4(objectNormal, 0.0)).y;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uGlass;
        uniform vec3 uLit;
        uniform float uNight;
        uniform float uCrowns;
        ${LAMP_UNIFORMS}
        uniform vec4 uFront[${fronts.length}];
        varying float vFacade;
        varying float vLift;
        varying vec3 vWorld;
        varying vec2 vWallNormal;
        varying float vUp;
        ${BAYER}
        // Sleepers: one per metre, wider apart than the real 0.6 m so a standard screen still
        // resolves them at the closest zoom.
        const float SLEEPER_PITCH = 1.0;
        float hash2(vec2 c) { return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453); }
        float noise2(vec2 p) {
          vec2 i = floor(p);
          vec2 u = fract(p);
          u = u * u * (3.0 - 2.0 * u);
          return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), u.x),
                     mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x), u.y);
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 glowEmit = vec3(0.0);
        if (vFacade > ${f(PANE - 0.5)}) {
          // A window on a roof, a dormer's or lying on the slope: lit in two of three at night.
          float roofLit = uNight * step(0.34, hash2(floor(vWorld.xz * 0.5) + floor(vWorld.y)));
          diffuseColor.rgb = mix(uGlass, vec3(1.0, 0.74, 0.4), roofLit);
          glowEmit = vec3(1.0, 0.72, 0.38) * roofLit * 0.85;
        } else if (vFacade > ${f(CROWN - 0.5)}) {
          // A crown as it shows from afar: its facets, with a dither of leaves as it gets nearer.
          diffuseColor.rgb *= 0.96 + 0.08 * noise2(vWorld.xz * 1.3 + vWorld.y);
        } else if (vFacade > ${f(ROOF_FLAT - 0.5)}) {
          // A flat roof: patches of bitumen under a scatter of gravel.
          vec2 p = vWorld.xz;
          float pixel = max(fwidth(p.x), fwidth(p.y));
          float patchy = noise2(p / 4.0);
          diffuseColor.rgb *= 0.98 + 0.05 * patchy;
          diffuseColor.rgb *= 1.0 + (hash2(floor(p / 0.14)) - 0.5) * 0.1 * (1.0 - smoothstep(0.06, 0.14, pixel));
        } else if (vFacade > ${f(ROOF - 0.5)}) {
          // A pitched roof, in courses from the ridge down: pantiles where it's red, staggered
          // slates where it's grey. Each stone or tile its own tone, a shadow under each course,
          // the ridge tiles a band along the top, moss on the shaded and the old. Fades to its
          // blotchy average before a course is thinner than a few pixels.
          float ridge = vFacade - ${f(ROOF + 100)};
          float slope = sqrt(max(1.0 - vUp * vUp, 0.02));
          vec2 p = vec2(dot(vWorld.xz, vec2(-vWallNormal.y, vWallNormal.x)), (ridge - vWorld.y) / slope);
          float pixel = max(fwidth(p.x), fwidth(p.y));
          float clay = smoothstep(0.015, 0.07, vColor.r - vColor.b);
          float grey = 1.0 - clay;
          vec2 size = mix(vec2(0.62, 0.46), vec2(0.44, 0.4), clay);
          vec2 q = p / size;
          q.x += 0.5 * mod(floor(q.y), 2.0);
          vec2 g = fract(q);
          float tone = hash2(floor(q) + vec2(ridge));
          float fine = 1.0 - smoothstep(size.y / 6.0, size.y / 3.0, pixel);
          float blotch = noise2(vWorld.xz / 6.5) * 0.6 + noise2(vWorld.xz / 2.1) * 0.4;
          float rows = 0.0;
          rows -= 0.34 * (1.0 - smoothstep(0.0, 0.2, g.y));
          rows += 0.1 * smoothstep(0.55, 1.0, g.y);
          rows += clay * 0.2 * (cos(g.x * 6.2832) * 0.5 + 0.1);
          rows -= grey * 0.22 * step(g.x, 0.06);
          float each = (tone - 0.5) * mix(0.2, 0.3, clay);
          diffuseColor.rgb *= 0.96 + 0.08 * blotch;
          diffuseColor.rgb *= 1.0 + (rows + each) * fine;
          // Now and then a new tile, redder or bluer than the rest.
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * mix(vec3(0.82, 0.9, 1.15), vec3(1.2, 0.92, 0.75), clay),
            step(0.965, tone) * fine);
          float north = 0.5 - 0.5 * vWallNormal.y;
          float moss = smoothstep(0.8, 0.92, blotch + 0.08 * north) * step(0.66, tone) * fine;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.26, 0.09), moss * 0.32);
          float cap = (1.0 - step(0.34, p.y)) * (1.0 - smoothstep(0.08, 0.16, pixel));
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * mix(0.72, 1.2, step(0.5, fract(p.x / 0.5))), cap);
        } else if (vFacade > ${f(AWNING - 0.5)}) {
          // An awning's canvas, striped across in its kind's second colour (facade-codes.ts).
          vec3 second = uFront[int(vFacade - ${f(AWNING - 0.5)}) * 2 + 1].rgb;
          float along = dot(vWorld.xz, vec2(-vWallNormal.y, vWallNormal.x)) / 0.9;
          float band = mix(0.5, step(0.5, fract(along)), 1.0 - smoothstep(0.2, 0.35, fwidth(along)));
          diffuseColor.rgb = mix(diffuseColor.rgb, second, band);
        } else if (vFacade > 0.0) {
          // Walls carry their top height, plus LANCETS on churches, ORNATE on civic Gothic or
          // SHOP_FRONT + 100 · kind over a shop front (facade-codes.ts).
          float shop = step(${f(SHOP_FRONT - 0.5)}, vFacade);
          float ornate = step(${f(ORNATE - 0.5)}, vFacade) - shop;
          float church = step(${f(LANCETS - 0.5)}, vFacade) - ornate - shop;
          float kind = shop * floor((vFacade - ${f(SHOP_FRONT)}) / 100.0);
          float top = vFacade - church * ${f(LANCETS)} - ornate * ${f(ORNATE)} -
            shop * (${f(SHOP_FRONT)} + 100.0 * kind);
          // Each building's own rhythm, seeded by its wall height: bay width, window width,
          // and as many storeys as fit, so the top row always sits under the eaves.
          float seed = fract(sin(top * 91.345) * 43758.5453);
          float seed2 = fract(seed * 13.17 + 0.37);
          float storey = clamp(top / max(1.0, floor(top / 3.2 + 0.5)), 2.8, 4.0);
          // A church: a lancet 1.5 m wide every 5.5 m.
          vec2 size = vec2(mix(mix(2.2, 3.4, seed), 5.5, church), storey);
          float halfWidth = mix(mix(0.17, 0.25, seed2), 0.75 / 5.5, church);
          // Storeys count from the foot of the house, wherever the ground lifted it.
          vec2 p = vec2(dot(vWorld.xz, vec2(-vWallNormal.y, vWallNormal.x)), vWorld.y - vLift);
          vec2 cell = floor(p / size);
          vec2 g = fract(p / size);
          float house = (1.0 - church) * (1.0 - ornate);
          // Each building's own style (DESIGN.md, "Facades"): arched windows on a quarter of
          // the houses, tall ones with a balcony rail on another quarter, the rest plain; and
          // whether it wears a cornice, a string course, a bluestone plinth or shutters.
          float sA = fract(seed * 17.13 + 0.29);
          float sB = fract(seed * 23.71 + 0.61);
          float sC = fract(seed * 29.37 + 0.83);
          float arched = house * step(0.74, sA);
          float tall = house * step(0.5, sA) * (1.0 - arched);
          float sillY = mix(0.32, 0.2, tall);
          float headY = mix(0.8, 0.84, tall);
          // A segmental arch takes 0.12 of the storey off the head towards the window's sides.
          float across = (g.x - 0.5) / max(halfWidth, 1e-3);
          float head = headY - arched * 0.12 * (1.0 - sqrt(max(0.0, 1.0 - across * across)));
          float window = step(0.5 - halfWidth, g.x) * step(g.x, 0.5 + halfWidth) * step(sillY, g.y) * step(g.y, head);
          // Only between the ground-floor sill and just under the eaves.
          window *= step(1.0, p.y) * step(p.y, top - 0.7);
          float average = 2.0 * halfWidth * 0.48 * step(1.0, p.y);
          // Lancets from 3 m to 2 m under the eaves, narrowing to a point over their last 1.6 m.
          float apex = top - 2.0;
          float lancet = step(3.0, p.y) * step(p.y, apex) *
            step(abs(g.x - 0.5) * size.x, 0.75 * sqrt(clamp((apex - p.y) / 1.6, 0.0, 1.0)));
          window = mix(window, lancet, church);
          average = mix(average, 2.0 * halfWidth * step(3.0, p.y) * step(p.y, apex), church);
          // A lancet's tracery: a stone mullion down its middle and a transom every 2.4 m.
          float fromMiddle = abs(g.x - 0.5) * size.x;
          window *= 1.0 - church * max(step(fromMiddle, 0.06), step(fract(p.y / 2.4), 0.05));
          // Civic Gothic draws niches of its own instead of windows (below).
          window *= 1.0 - ornate;
          average *= 1.0 - ornate;
          // A front door in one bay in four of a house's walls (never a shop's): 1.1 m wide and
          // 2.3 m tall in the frames' paint, under a pale fanlight. Its bay has no ground-floor
          // window.
          float bay4 = floor(cell.x / 4.0);
          float doorBay = house * (1.0 - shop) * step(hash2(vec2(bay4, seed * 100.0)), 0.7) *
            step(abs(mod(cell.x, 4.0) - floor(hash2(vec2(seed * 50.0, bay4)) * 4.0)), 0.5) *
            step(cell.y, 0.5) * step(4.0, top);
          float door = doorBay * step(abs(g.x - 0.5) * size.x, 0.55) * step(0.0, p.y) * step(p.y, 2.3);
          float fanlight = door * step(1.95, p.y);
          window *= 1.0 - doorBay;
          vec3 glass = uGlass;
          // A shop front: one wide pane per bay on the ground floor, under its kind's canvas,
          // with a door at one end of it, and a mullion down the middle of a wide one.
          float ground = shop * (1.0 - step(storey, p.y));
          float awning = ground * step(storey * 0.78, p.y) * step(p.y, storey * 0.92);
          float doorSide = step(0.5, fract(seed * 5.17)) * 2.0 - 1.0;
          float doorU = (g.x - 0.5) * size.x * doorSide;
          float doorAt = 0.5 * size.x - 0.6;
          float shopDoor = ground * step(abs(mod(cell.x, 3.0) - 1.0), 0.5) * step(abs(doorU - doorAt), 0.5) *
            step(0.1, p.y) * step(p.y, storey * 0.72);
          float mullion = step(0.6, fract(seed * 9.1)) * step(abs(g.x - 0.5) * size.x, 0.05) * (1.0 - shopDoor);
          float pane = step(0.08, g.x) * step(g.x, 0.92) * step(0.1, p.y) * step(p.y, storey * 0.72) * (1.0 - mullion);
          window = mix(window, pane, ground);
          average = mix(average, 0.6, ground);
          // A window narrower than about two device pixels aliases into stripes, so the grid
          // fades to its average tint between three and two pixels per window.
          float pixel = max(fwidth(p.x), fwidth(p.y));
          vec4 front = uFront[int(kind) * 2];
          vec4 second = uFront[int(kind) * 2 + 1];
          // Stripes 45 cm wide, blended to their average once finer than a couple of pixels.
          float band = mix(0.5, step(0.5, fract(p.x / 0.9)), 1.0 - smoothstep(0.2, 0.35, pixel));
          vec3 canvas = mix(front.rgb, second.rgb, band);
          // Warm panes in a café, goods in a shop's window: blocks of its canvas and paper.
          glass = mix(glass, mix(glass, uLit, 0.55), ground * front.w);
          float item = hash2(floor(vec2(p.x / 0.32, p.y / 0.28)));
          float goods = ground * second.w * step(0.15, p.y) * step(p.y, storey * 0.3) * step(0.45, item);
          glass = mix(glass, mix(front.rgb, vec3(0.93, 0.89, 0.8), item), goods);
          float span = 2.0 * halfWidth * size.x;
          float detail = 1.0 - smoothstep(span / 3.0, span / 2.0, pixel);
          float coverage = mix(average, window, detail);
          float litHash = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
          float glow = step(0.93, litHash) * (1.0 - ground - church);
          // At night (uNight), a share of the windows light up, most of them warm, a few cool,
          // and three shop fronts in four, a café's warm: they glow whatever the light on them.
          float lit = uNight * house * (1.0 - ground) * step(1.0 - 0.45 * uNight, litHash);
          vec3 bulb = fract(litHash * 7.0) < 0.78 ? vec3(1.0, 0.76, 0.4) : vec3(0.72, 0.8, 1.0);
          // From afar one window's hash against the next is a checkerboard: their average instead.
          lit = mix(uNight * house * (1.0 - ground) * 0.45 * uNight, lit, detail);
          bulb = mix(vec3(1.0, 0.76, 0.4), bulb, detail);
          float shopLit = ground * uNight * step(0.25, fract(seed * 3.3));
          vec3 shopLight = mix(vec3(0.9, 0.9, 0.85), vec3(1.0, 0.72, 0.38), front.w);
          // Up close a window is more than a dark square: bars across it, a reveal shading its
          // top, a streak of sky on the glass by day; lit, a warm room, brighter at the ceiling,
          // between two curtains.
          float paneU = (g.x - 0.5 + halfWidth) / max(2.0 * halfWidth, 1e-3);
          float paneV = (g.y - sillY) / max(head - sillY, 1e-3);
          float plainPane = house * (1.0 - ground) * window * detail;
          float bars = max(step(abs(paneU - 0.5), 0.035), step(abs(paneV - 0.64), 0.03)) * plainPane;
          float reveal = smoothstep(0.8, 1.0, paneV) * plainPane;
          float sky = step(0.5, fract(litHash * 5.0)) * step(abs(paneU * 0.9 - paneV * 0.5 - 0.2 + 0.3 * fract(litHash * 9.0)), 0.09) * plainPane;
          float curtain = max(step(paneU, 0.16), step(0.84, paneU)) * plainPane;
          glass = mix(glass, mix(glass, vec3(0.5, 0.66, 0.82), 0.26), sky);
          glass *= 1.0 - 0.45 * reveal;
          vec3 room = bulb * mix(0.72, 1.12, paneV) * (1.0 - 0.45 * curtain);
          vec3 paneColour = mix(mix(glass, uLit, glow * detail), room, lit);
          paneColour = mix(paneColour, shopLight, shopLit);
          paneColour = mix(paneColour, vec3(0.05, 0.05, 0.06), bars * 0.85);
          diffuseColor.rgb = mix(diffuseColor.rgb, paneColour, coverage * 0.8);
          glowEmit = room * lit * mix(average * 0.6, window * (1.0 - bars), detail) * 0.9 +
            shopLight * shopLit * window * 0.8;
          diffuseColor.rgb = mix(diffuseColor.rgb, canvas, awning * (1.0 - smoothstep(0.3, 0.6, pixel)));
          // A lancet's stone surround, a little paler than the wall, once it spans a few pixels.
          float surround = church * (1.0 - lancet) * step(2.85, p.y) * step(p.y, apex + 0.15) *
            step(fromMiddle, 0.9 * sqrt(clamp((apex + 0.15 - p.y) / 1.75, 0.0, 1.0)));
          diffuseColor.rgb *= 1.0 + 0.12 * surround * (1.0 - smoothstep(0.1, 0.2, pixel));
          // Civic Gothic, as on the Stadhuis: tiers 3.6 m tall of pointed niches 1.6 m apart, each
          // with a statue on its plinth, over a moulded band, from the first tier to the eaves.
          if (ornate > 0.5) {
            vec2 bay = vec2(1.6, 3.6);
            float nx = abs(fract(p.x / bay.x) - 0.5) * bay.x;
            float ny = fract((p.y - 1.0) / bay.y) * bay.y;
            float arch = 2.6 + 0.45 * sqrt(clamp(1.0 - nx / 0.42, 0.0, 1.0));
            float niche = step(nx, 0.42) * step(0.5, ny) * step(ny, arch);
            float figure = step(nx, 0.15) * step(0.75, ny) * step(ny, 2.15) +
              step(length(vec2(nx, ny - 2.32)), 0.13) + step(nx, 0.24) * step(0.5, ny) * step(ny, 0.75);
            vec3 stone = diffuseColor.rgb;
            vec3 carved = mix(stone, stone * 1.15, step(ny, 0.18));
            carved = mix(carved, stone * 0.45, niche);
            carved = mix(carved, min(stone * 1.25, vec3(1.0)), clamp(figure, 0.0, 1.0) * niche);
            float sharp = 1.0 - smoothstep(0.17, 0.28, pixel);
            diffuseColor.rgb = mix(stone, mix(stone * 0.82, carved, sharp),
              step(1.0, p.y) * step(p.y, top - 1.2));
          }
          // Round an ordinary window, a frame and a bluestone sill, and under one in five a
          // box of flowers, red, pink, white or yellow: houses that look lived in, at no geometry.
          // A frame fades out before it's thinner than a pixel, a flower box a little later.
          float plain = house * (1.0 - ground) * (1.0 - doorBay) *
            step(1.0, (cell.y + sillY) * size.y) * step((cell.y + headY) * size.y, top - 0.7);
          vec2 rim = vec2(0.09) / size;
          float inX = step(0.5 - halfWidth - rim.x, g.x) * step(g.x, 0.5 + halfWidth + rim.x);
          float frame = inX * step(sillY - rim.y, g.y) * step(g.y, head + rim.y) * (1.0 - window);
          float sill = step(0.5 - halfWidth - 2.0 * rim.x, g.x) * step(g.x, 0.5 + halfWidth + 2.0 * rim.x) *
            step(sillY - 2.0 * rim.y, g.y) * step(g.y, sillY - rim.y);
          float bloom = step(0.8, hash2(cell + vec2(3.7, 1.3))) * (1.0 - tall);
          float flowerBox = bloom * inX * step(sillY - 5.0 * rim.y, g.y) * step(g.y, sillY - 2.0 * rim.y);
          float fine = plain * (1.0 - smoothstep(0.05, 0.12, pixel));
          float luma = dot(vColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          // White frames on brick; on a pale render, painted wood: bottle green, oxblood or charcoal.
          float paint = fract(seed * 7.31);
          vec3 wood = paint < 0.4 ? vec3(0.04, 0.12, 0.07) : paint < 0.7 ? vec3(0.22, 0.04, 0.03) : vec3(0.06, 0.06, 0.07);
          vec3 frameColour = luma > 0.4 ? wood : vec3(0.88, 0.85, 0.79);
          diffuseColor.rgb = mix(diffuseColor.rgb, frameColour, frame * fine);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.43, 0.44), sill * fine);
          // Tall windows on the upper floors stand behind a balcony rail of iron bars.
          float rail = tall * plain * step(0.5, cell.y) * inX * step(sillY, g.y) * step(g.y, sillY + 0.1) *
            max(step(0.6, fract(p.x / 0.14)), step(g.y, sillY + 0.025));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.1, 0.1, 0.11), rail * (1.0 - smoothstep(0.04, 0.09, pixel)));
          // Shutters either side of the windows of one pale house in five.
          float side = abs(g.x - 0.5);
          float shutter = step(0.8, sC) * step(0.4, luma) * plain * step(halfWidth + rim.x, side) *
            step(side, halfWidth + rim.x + 0.6 * halfWidth) * step(sillY, g.y) * step(g.y, headY);
          diffuseColor.rgb = mix(diffuseColor.rgb, wood * 1.6, shutter * (1.0 - smoothstep(0.1, 0.2, pixel)));
          float hue = hash2(cell + vec2(9.1, 4.2));
          vec3 petals = hue < 0.4 ? vec3(0.72, 0.07, 0.05) : hue < 0.65 ? vec3(0.86, 0.33, 0.45)
            : hue < 0.85 ? vec3(0.9, 0.87, 0.8) : vec3(0.9, 0.68, 0.1);
          float petal = step(0.5, hash2(floor(p / 0.1)));
          diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.06, 0.18, 0.04), petals, petal),
            flowerBox * plain * (1.0 - smoothstep(0.1, 0.22, pixel)));
          // Trim: a cornice under the eaves of most houses and a string course over the ground
          // floor of some, pale stone on brick and a darker band on render; a bluestone plinth
          // on half of them. Brick shows its courses, faintly, once one spans a couple of pixels.
          vec3 trim = luma > 0.4 ? vColor.rgb * 0.8 : vec3(0.9, 0.87, 0.78);
          float cornice = house * step(0.4, sB) * step(top - 0.5, p.y) * step(p.y, top - 0.1);
          float course = house * (1.0 - shop) * step(0.72, sB) * step(storey - 0.14, p.y) * step(p.y, storey - 0.02);
          float plinth = house * (1.0 - shop) * step(0.5, sC) * step(0.0, p.y) * step(p.y, 0.5);
          float trimFine = 1.0 - smoothstep(0.12, 0.25, pixel);
          diffuseColor.rgb = mix(diffuseColor.rgb, trim, max(cornice, course) * trimFine);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.3, 0.33, 0.36), plinth * trimFine);
          float courses = step(luma, 0.4) * house * step(0.88, fract(p.y / 0.3)) * (1.0 - smoothstep(0.04, 0.08, pixel));
          diffuseColor.rgb *= 1.0 - 0.08 * courses * (1.0 - window) * (1.0 - max(cornice, plinth));
          // At night a church and a hall are floodlit from below, stronger at the foot.
          float flood = max(church, ornate) * step(0.0, p.y);
          glowEmit += diffuseColor.rgb * vec3(0.95, 0.68, 0.38) * flood * uNight * mix(0.48, 0.14, smoothstep(0.0, top, p.y)) * (1.0 - coverage);
          // Grime along the foot of every wall, and the slow weathering of the rest.
          diffuseColor.rgb *= 1.0 - 0.2 * (1.0 - smoothstep(0.0, 1.5, p.y));
          diffuseColor.rgb *= 0.95 + 0.1 * noise2(vec2(p.x / 3.1, p.y / 2.3));
          vec3 doorColour = mix(wood, vec3(0.9, 0.86, 0.72), fanlight);
          diffuseColor.rgb = mix(diffuseColor.rgb, doorColour, door * (1.0 - smoothstep(0.15, 0.3, pixel)));
          // The shop's door: its wooden frame, a bar at handle height and a kick plate.
          float doorFrame = shopDoor * clamp(step(0.42, abs(doorU - doorAt)) + step(abs(p.y - 1.0), 0.04) + step(p.y, 0.2), 0.0, 1.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, wood, doorFrame * (1.0 - smoothstep(0.06, 0.12, pixel)));
        } else if (vFacade < ${f(-SLEEPER_CODE + 0.5)}) {
          float along = (-vFacade - ${f(SLEEPER_CODE)}) / SLEEPER_PITCH;
          float detail = 1.0 - smoothstep(0.25, 0.4, fwidth(along));
          float sleeper = mix(0.5, step(fract(along), 0.5), detail);
          diffuseColor.rgb *= mix(0.84, 1.0, sleeper);
        } else if (vFacade < -0.5 && vFacade > ${f(-SURFACE.earth - 0.5)}) {
          float surface = floor(0.5 - vFacade);
          vec2 p = vWorld.xz;
          float pixel = max(fwidth(p.x), fwidth(p.y));
          // Patches of newer and older surface, with hard edges like the rest of the scene.
          float wear = noise2(p / 9.0) + 0.35 * noise2(p / 2.3);
          float shade = 1.0 + 0.045 * (step(0.98, wear) - step(wear, 0.5));
          if (surface == ${f(SURFACE.sett)}) {
            // Setts in staggered rows: each stone a little lighter or darker once it spans a
            // pixel and a half, a pale crown on it, and joints, at least a pixel wide, once it
            // spans four.
            vec2 size = vec2(0.6, 0.45);
            vec2 q = p / size;
            q.x += 0.5 * mod(floor(q.y), 2.0);
            vec2 g = fract(q);
            vec2 width = max(vec2(0.1), pixel / size);
            float joint = 1.0 - step(width.x, g.x) * step(width.y, g.y);
            float stone = hash2(floor(q));
            float crown = smoothstep(0.55, 0.15, length(g - 0.5));
            shade = 1.0 + (0.055 * (step(0.67, stone) - step(stone, 0.33)) + 0.05 * crown) * (1.0 - smoothstep(0.3, 0.45, pixel))
              - 0.2 * joint * (1.0 - smoothstep(0.11, 0.15, pixel));
          } else if (surface == ${f(SURFACE.paving)}) {
            // Square slabs, each its own tone, with joints at least a pixel wide once a slab
            // spans eight, and a fine grain up close.
            vec2 g = fract(p / 1.2);
            float width = max(0.04, pixel / 1.2);
            float joint = 1.0 - step(width, g.x) * step(width, g.y);
            shade = 1.0 + 0.05 * (hash2(floor(p / 1.2)) - 0.5) * (1.0 - smoothstep(0.3, 0.6, pixel))
              + 0.05 * (hash2(floor(p / 0.12)) - 0.5) * (1.0 - smoothstep(0.05, 0.1, pixel))
              - 0.09 * joint * (1.0 - smoothstep(0.1, 0.15, pixel));
          } else if (surface == ${f(SURFACE.asphalt)}) {
            // Asphalt: a speckle of stone in the tar, and here and there a crack.
            float speckle = hash2(floor(p / 0.11));
            float crack = (1.0 - smoothstep(0.0, 0.015 + pixel * 0.25, abs(noise2(p / 3.7) - 0.5))) * step(0.56, noise2(p / 19.0));
            shade += (speckle - 0.5) * 0.13 * (1.0 - smoothstep(0.05, 0.11, pixel));
            shade -= 0.16 * crack * (1.0 - smoothstep(0.05, 0.12, pixel));
          } else if (surface == ${f(SURFACE.gravel)} || surface == ${f(SURFACE.earth)}) {
            // Gravel and packed earth: pebbles in clumps, dark and pale.
            float pebble = hash2(floor(p / 0.13));
            float clump = noise2(p / 3.0);
            shade = 0.95 + 0.1 * clump + (pebble - 0.5) * (surface == ${f(SURFACE.earth)} ? 0.14 : 0.26) * (1.0 - smoothstep(0.05, 0.12, pixel));
          } else if (surface == ${f(SURFACE.water)}) {
            // Water: slow bands of deeper and paler blue along the stream, and streaks of sky.
            vec2 w = vec2(p.x * 0.62 + p.y * 0.32, p.y * 0.62 - p.x * 0.32);
            float swell = noise2(w * vec2(0.12, 0.42)) + 0.45 * noise2(w * vec2(0.4, 1.3));
            float bands = floor(swell * 4.5) / 4.5;
            diffuseColor.rgb *= mix(vec3(0.68, 0.76, 0.86), vec3(1.14, 1.12, 1.08), bands);
            float streak = step(0.8, noise2(w * vec2(0.5, 3.4))) * step(0.5, noise2(w * vec2(0.09, 0.28)));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.95, 1.0), streak * 0.55 * (1.0 - smoothstep(0.08, 0.2, pixel)));
            shade = 1.0;
          } else if (surface == ${f(SURFACE.woods)}) {
            // A wood's floor: dappled, with fallen leaves up close.
            float dapple = noise2(p / 4.5) + 0.5 * noise2(p / 1.5);
            diffuseColor.rgb *= 0.84 + 0.26 * floor(dapple * 4.0) / 4.0;
            float leaf = hash2(floor(p / 0.2));
            diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.22, 0.16, 0.05), vec3(0.34, 0.27, 0.07), leaf), step(0.88, leaf) * (1.0 - smoothstep(0.05, 0.1, pixel)));
            shade = 1.0;
          } else if (surface == ${f(SURFACE.flowers)} || surface == ${f(SURFACE.garden)}) {
            // Grass, painted: fields of warmer and cooler green in hard-edged bands, and up close
            // short slanted strokes of light and dark, as a brush leaves them.
            float field = noise2(p / 16.0) * 0.62 + noise2(p / 5.5) * 0.28 + noise2(p / 1.9) * 0.1;
            float bands = floor(field * 7.0) / 6.0;
            diffuseColor.rgb *= mix(vec3(0.82, 0.92, 0.84), vec3(1.18, 1.1, 0.74), bands);
            vec2 b = vec2(p.x + 0.42 * p.y, p.y) / vec2(0.17, 0.46);
            vec2 cell = floor(b + vec2(0.5 * mod(floor(b.y), 2.0), 0.0));
            float blade = hash2(cell);
            float near = 1.0 - smoothstep(0.035, 0.09, pixel);
            diffuseColor.rgb *= 1.0 + (step(0.68, blade) * 0.16 - step(blade, 0.3) * 0.16) * near;
            if (surface == ${f(SURFACE.flowers)}) {
              // A flower here and there on the grass, one in six cells of 0.9 m at most, each
              // its own spot in its cell: yellow, white or pink. Only once a flower spans a
              // couple of pixels, so the lawn never sparkles as the map moves.
              vec2 q = p / 0.9;
              vec2 flowerCell = floor(q);
              float h = hash2(flowerCell);
              vec2 spot = vec2(hash2(flowerCell + 17.0), hash2(flowerCell + 31.0)) * 0.6 + 0.2;
              float bloom = step(length(fract(q) - spot) * 0.9, 0.1) * step(h, 0.16) *
                (1.0 - smoothstep(0.045, 0.07, pixel));
              vec3 petal = h < 0.07 ? vec3(0.95, 0.75, 0.16) : h < 0.12 ? vec3(0.93, 0.9, 0.84) : vec3(0.9, 0.42, 0.55);
              diffuseColor.rgb = mix(diffuseColor.rgb, petal, bloom);
            }
            shade = 1.0;
          }
          diffuseColor.rgb *= shade;
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        // Lit windows and shop fronts glow at night whatever the light on them.
        `#include <emissivemap_fragment>\ntotalEmissiveRadiance += glowEmit;\n${LAMP_FRAGMENT}`,
      )
      .replace(
        '#include <opaque_fragment>',
        `// Shade keeps a richer version of its own hue at the same lightness (lighting.ts), so
        // sand in shadow stays sand instead of matching asphalt in the sun.
        vec3 luma = vec3(${LUMA.map(f).join(', ')});
        float shadeRatio = dot(outgoingLight, luma) / max(dot(diffuseColor.rgb, luma), 1e-4);
        vec3 own = diffuseColor.rgb * shadeRatio;
        vec3 rich = max(vec3(dot(own, luma)) + (own - dot(own, luma)) * ${f(SHADE_CHROMA)}, 0.0);
        float keep = ${f(SHADE_HUE)} * (1.0 - smoothstep(${f(SHADE_RANGE[0])}, ${f(SHADE_RANGE[1])}, shadeRatio));
        outgoingLight = mix(outgoingLight, rich, keep);
        #include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => 'facade-v12';
  return material;
}

/**
 * What stands on the ground darkens the ground beside it, in the ordered dither (contact.ts): the
 * foot of a wall, a rack. Each vertex's `facade` is how dark, 1 at the wall and 0 where it ends.
 */
export function createContactMaterial(cell: { value: number }): MeshBasicMaterial {
  const material = new MeshBasicMaterial({ color: OUTLINE });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDitherCell = cell;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float facade;\nvarying float vDark;',
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDark = facade;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nuniform float uDitherCell;\nvarying float vDark;\n${BAYER}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>\nif (bayer4(gl_FragCoord.xy / uDitherCell) >= vDark * ${f(CONTACT_DARK)}) discard;`,
      );
  };
  material.customProgramCacheKey = () => 'contact-v1';
  return material;
}

/**
 * Leaves up close: a tree's crown as puffs (tree-puffs in trees.ts), one quad each, turned to the
 * camera in the vertex shader. In the fragment shader each is a ball of blocky clumps of leaves:
 * a ragged rim, its normal from the ball, so the toon ramp shades it in round steps, and its depth
 * too, so the puffs of a crown cut into each other as balls do. Lit and shadowed as the rest.
 */
export function createPuffMaterial(
  gradientMap: Texture,
  light: LampLight,
  pixel: { value: number },
  depthPerMetre: number,
): MeshToonMaterial {
  const material = new MeshToonMaterial({ vertexColors: true, gradientMap });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uPixel = pixel;
    withLamps(shader.uniforms, light);
    shader.vertexShader = linearVertexColors(shader.vertexShader)
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 puff;
        uniform float uPixel;
        varying vec2 vPuff;
        varying vec3 vWorld;
        varying float vRadius;
        varying float vLeaf;
        varying float vSeed;`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = puff.xyz
          + vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]) * position.x * puff.w
          + vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]) * position.y * puff.w;
        vPuff = position.xy;
        vWorld = transformed;
        vRadius = puff.w;
        vLeaf = max(0.18, uPixel * 2.6) / puff.w;
        vSeed = fract(puff.x * 3.17 + puff.z * 7.31);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec2 vPuff;
        varying vec3 vWorld;
        varying float vRadius;
        varying float vLeaf;
        varying float vSeed;
        ${LAMP_UNIFORMS}
        ${BAYER}
        float hash2(vec2 c) { return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453); }`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        vec2 leaf = (floor(vPuff / vLeaf) + 0.5) * vLeaf;
        float grain = hash2(leaf * 41.0 + vSeed * 13.0);
        float rim = length(leaf);
        if (rim > 1.0 - 0.24 * grain) discard;
        vec3 ball = vec3(leaf + (grain - 0.5) * 0.26, 0.0);
        ball.z = sqrt(max(0.05, 1.0 - dot(ball.xy, ball.xy)));
        gl_FragDepth = gl_FragCoord.z - ball.z * vRadius * ${depthPerMetre.toFixed(9)};`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        diffuseColor.rgb *= 0.86 + 0.3 * grain;`,
      )
      .replace(
        '#include <normal_fragment_begin>',
        'vec3 normal = normalize(ball);\nvec3 nonPerturbedNormal = normal;',
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>\n${LAMP_FRAGMENT}`,
      );
  };
  material.customProgramCacheKey = () => 'puff-v1';
  return material;
}

/** Whether the puffs stand in for the crowns now, which then go. */
export function setCrowns(material: MeshToonMaterial, covered: boolean): void {
  (material.userData.crowns as { value: number }).value = covered ? 1 : 0;
}

/** World metres per screen pixel: decides how much road paint and texture the material draws. */
export function setPixelSize(material: MeshToonMaterial, metres: number): void {
  (material.userData.pixel as { value: number }).value = metres;
}

/** How far into the night it is, 0 (day) to 1: how many windows and shop fronts are lit. */
export function setNight(material: MeshToonMaterial, night: number): void {
  (material.userData.night as { value: number }).value = night;
}

/**
 * The lamps' light at night (furniture.ts, `addLampGlow`): unlit, in its own colour, drawn only
 * where a 4×4 ordered dither lets it through, by each vertex's `facade` (1 at a lantern and a
 * pool's middle, 0 at a pool's rim) times how far into the night it is. No blending, no sorting:
 * a pool of light on the street fades out in the same pixel pattern as everything else here.
 */
export function createGlowMaterial(lamps: { value: number }): MeshBasicMaterial {
  const material = new MeshBasicMaterial({ vertexColors: true });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = lamps;
    shader.vertexShader = linearVertexColors(shader.vertexShader)
      .replace(
        '#include <common>',
        '#include <common>\nattribute float facade;\nvarying float vGlow;',
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = facade;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nuniform float uNight;\nvarying float vGlow;\n${BAYER}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\nif (bayer4(gl_FragCoord.xy) >= vGlow * uNight) discard;',
      );
  };
  material.customProgramCacheKey = () => 'glow-v1';
  return material;
}
