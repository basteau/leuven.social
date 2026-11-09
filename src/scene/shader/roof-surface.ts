import { ROOF, ROOF_FLAT } from '../facade-codes.ts';
import { f } from './glsl.ts';

/** A window on a roof, a dormer's or lying on the slope: lit in two of three at night. */
const PANE_ROOF = `void paneSurface(inout vec3 albedo, inout vec3 glowEmit) {
  float roofLit = uNight * step(0.34, hash2(floor(vWorld.xz * 0.5) + floor(vWorld.y)));
  albedo = mix(uGlass, vec3(1.0, 0.74, 0.4), roofLit);
  glowEmit = vec3(1.0, 0.72, 0.38) * roofLit * 0.85;
}`;

/**
 * A flat roof, its seams square to the building (its turn is the code's fraction): gravel and
 * patches of bitumen. No skylights: laid out on a grid of their own, they read as stray windows
 * and were cut off by the roof's edge.
 */
const FLAT_ROOF = `void flatRoof(inout vec3 albedo) {
  float turn = (vFacade - ${f(ROOF_FLAT)}) * PI;
  vec2 axis = vec2(cos(turn), sin(turn));
  vec2 p = vec2(dot(vWorld.xz, axis), dot(vWorld.xz, vec2(-axis.y, axis.x)));
  float pixel = max(fwidth(p.x), fwidth(p.y));
  float fine = 1.0 - smoothstep(0.1, 0.2, pixel);
  albedo *= 0.98 + 0.05 * noise2(p / 4.0);
  albedo *= 1.0 + (hash2(floor(p / 0.14)) - 0.5) * 0.1 * (1.0 - smoothstep(0.05, 0.12, pixel));
  albedo *= 1.0 - 0.1 * max(step(fract(p.x / 4.0), 0.012), step(fract(p.y / 4.0), 0.012)) * fine;
}`;

/**
 * A pitched roof, in courses from the ridge down: pantiles where it's red, staggered slates where
 * it's grey. Each stone or tile its own tone, now and then a new one redder or bluer than the rest,
 * a shadow under each course, the ridge tiles a band along the top, moss on the shaded and the
 * old. Fades to its blotchy average before a course is thinner than a few pixels.
 */
const PITCHED_ROOF = `void pitchedRoof(inout vec3 albedo, vec3 base) {
  float ridge = vFacade - ${f(ROOF + 100)};
  float slope = sqrt(max(1.0 - vUp * vUp, 0.02));
  vec2 p = vec2(dot(vWorld.xz, vec2(-vWallNormal.y, vWallNormal.x)), (ridge - vWorld.y) / slope);
  float pixel = max(fwidth(p.x), fwidth(p.y));
  float clay = smoothstep(0.015, 0.07, base.r - base.b);
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
  albedo *= 0.96 + 0.08 * blotch;
  albedo *= 1.0 + (rows + each) * fine;
  albedo = mix(albedo, albedo * mix(vec3(0.82, 0.9, 1.15), vec3(1.2, 0.92, 0.75), clay),
    step(0.965, tone) * fine);
  float north = 0.5 - 0.5 * vWallNormal.y;
  float moss = smoothstep(0.8, 0.92, blotch + 0.08 * north) * step(0.66, tone) * fine;
  albedo = mix(albedo, vec3(0.2, 0.26, 0.09), moss * 0.32);
  float cap = (1.0 - step(0.34, p.y)) * (1.0 - smoothstep(0.08, 0.16, pixel));
  albedo = mix(albedo, albedo * mix(0.72, 1.2, step(0.5, fract(p.x / 0.5))), cap);
}`;

/** Roofs (facade-codes.ts): pitched ones in courses from the ridge, flat ones and roof windows. */
export const ROOF_SURFACES = `${PANE_ROOF}
${FLAT_ROOF}
${PITCHED_ROOF}`;
