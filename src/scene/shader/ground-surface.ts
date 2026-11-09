import { SURFACE } from '../paint.ts';
import { SLEEPER_CODE } from '../rails.ts';
import { f } from './glsl.ts';

/**
 * The ground: road surfaces, stone, asphalt, gravel, grass, woods and water, each named by a small
 * negative `facade` code (`SURFACE` in paint.ts), and the railway's sleepers, from the distance along
 * the track. Everything fades out before it is finer than a couple of pixels, so nothing crawls
 * while the map moves.
 */
export const GROUND = `// Sleepers: one per metre, wider apart than the real 0.6 m so a standard screen still resolves
// them at the closest zoom.
const float SLEEPER_PITCH = 1.0;

void sleeperBand(inout vec3 albedo) {
  float along = (-vFacade - ${f(SLEEPER_CODE)}) / SLEEPER_PITCH;
  float detail = 1.0 - smoothstep(0.25, 0.4, fwidth(along));
  float sleeper = mix(0.5, step(fract(along), 0.5), detail);
  albedo *= mix(0.84, 1.0, sleeper);
}

void groundSurface(inout vec3 albedo) {
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
    // Asphalt: a speckle of stone in the tar.
    float speckle = hash2(floor(p / 0.11));
    shade += (speckle - 0.5) * 0.13 * (1.0 - smoothstep(0.05, 0.11, pixel));
  } else if (surface == ${f(SURFACE.gravel)} || surface == ${f(SURFACE.earth)}) {
    // Gravel and packed earth: pebbles in clumps, dark and pale.
    float pebble = hash2(floor(p / 0.13));
    float clump = noise2(p / 3.0);
    shade = 0.95 + 0.1 * clump + (pebble - 0.5) * (surface == ${f(SURFACE.earth)} ? 0.14 : 0.26) * (1.0 - smoothstep(0.05, 0.12, pixel));
  } else if (surface == ${f(SURFACE.water)}) {
    // Water: slow bands of deeper and paler blue along the stream, ripples close in, faint
    // streaks of sky.
    vec2 w = vec2(p.x * 0.62 + p.y * 0.32, p.y * 0.62 - p.x * 0.32);
    float swell = noise2(w * vec2(0.12, 0.42)) + 0.45 * noise2(w * vec2(0.4, 1.3));
    float bands = floor(swell * 5.0) / 5.0;
    albedo *= mix(vec3(0.62, 0.72, 0.85), vec3(1.16, 1.14, 1.08), bands);
    float fine = 1.0 - smoothstep(0.06, 0.16, pixel);
    float ripple = noise2(w * vec2(1.2, 6.0));
    albedo *= 1.0 + (step(0.72, ripple) * 0.12 - step(ripple, 0.28) * 0.1) * fine;
    float streak = step(0.8, noise2(w * vec2(0.5, 3.4))) * step(0.5, noise2(w * vec2(0.09, 0.28)));
    albedo = mix(albedo, vec3(0.86, 0.95, 1.0), streak * 0.16 * (1.0 - smoothstep(0.08, 0.2, pixel)));
    shade = 1.0;
  } else if (surface == ${f(SURFACE.woods)}) {
    // A wood's floor: dappled, with fallen leaves up close.
    float dapple = noise2(p / 4.5) + 0.5 * noise2(p / 1.5);
    albedo *= 0.84 + 0.26 * floor(dapple * 4.0) / 4.0;
    float leaf = hash2(floor(p / 0.2));
    albedo = mix(albedo, mix(vec3(0.22, 0.16, 0.05), vec3(0.34, 0.27, 0.07), leaf), step(0.88, leaf) * (1.0 - smoothstep(0.05, 0.1, pixel)));
    shade = 1.0;
  } else if (surface == ${f(SURFACE.flowers)} || surface == ${f(SURFACE.garden)}) {
    // Grass, painted: fields of warmer and cooler green in hard-edged bands, drifts of clover,
    // a coarse grain from the middle distance, and up close short slanted strokes of light and
    // dark with darker tufts among them, as a brush leaves them.
    float field = noise2(p / 16.0) * 0.62 + noise2(p / 5.5) * 0.28 + noise2(p / 1.9) * 0.1;
    float bands = floor(field * 7.0) / 6.0;
    albedo *= mix(vec3(0.82, 0.92, 0.84), vec3(1.18, 1.1, 0.74), bands);
    float clover = step(0.76, noise2(p / 1.7 + 40.0));
    albedo *= 1.0 + vec3(0.05, 0.07, -0.03) * clover;
    float mid = 1.0 - smoothstep(0.1, 0.24, pixel);
    albedo *= 1.0 + (hash2(floor(p / 0.55)) - 0.5) * 0.12 * mid;
    vec2 b = vec2(p.x + 0.42 * p.y, p.y) / vec2(0.17, 0.46);
    vec2 cell = floor(b + vec2(0.5 * mod(floor(b.y), 2.0), 0.0));
    float blade = hash2(cell);
    float near = 1.0 - smoothstep(0.035, 0.09, pixel);
    albedo *= 1.0 + (step(0.68, blade) * 0.17 - step(blade, 0.3) * 0.17) * near;
    float tuft = step(0.7, noise2(p / 0.8)) * step(0.5, blade);
    albedo *= 1.0 - 0.2 * tuft * near;
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
      albedo = mix(albedo, petal, bloom);
    }
    shade = 1.0;
  }
  albedo *= shade;
}`;

export { SLEEPER_CODE, SURFACE };
