import { fromOklab, toOklab } from '../data/colour.ts';
import { LIGHT } from './lighting.ts';
import type { V3 } from './mesh-builder.ts';
import { BOUNCE_LIGHT, SKY, SKY_LIGHT, SUN } from './palette.ts';

/**
 * The light over the city through a day: a few keyframes on a 24-hour clock, blended between.
 * Golden hour is the look DESIGN.md describes, kept as it was; the rest of the day is drawn
 * round it. Nothing here touches three.js: the viewer reads a `Daylight` and sets its lights,
 * fog and uniforms from it, and the app paints the sky behind the canvas from the same colours.
 */
export interface Daylight {
  /** Hours since midnight, 0 to 24. */
  hour: number;
  /** Towards the sun (or the moon at night): a unit vector, never below 0.2 up. */
  sunDirection: V3;
  sun: number;
  sunIntensity: number;
  /** How much of the sun a shadow takes away, 0 to 1: weak sun, weak shadow (`shadowWeight`). */
  shadow: number;
  /** The sky's fill, and the warm bounce under it. */
  sky: number;
  skyIntensity: number;
  bounce: number;
  /** The haze at the horizon, and the sky overhead: the fog, the walking sky, the page. */
  horizon: number;
  top: number;
  /** How far into the night it is, 0 to 1: lit windows, and past `LAMPS_ON` the lamps. */
  night: number;
}

type Keyframe = Omit<Daylight, 'shadow'>;

/**
 * The whole of the night, midnight to 5:30 and 22:00 on: moonlight and the sky's fill enough that
 * the roofs keep their shapes and colours, the moon under the sky so its shadow is a hint, not a
 * slab across the street.
 */
const NIGHT: Omit<Keyframe, 'hour'> = {
  sunDirection: [0.45, 0.55, 0.5],
  sun: 0xa8bff0,
  sunIntensity: 0.55,
  sky: 0x5468a0,
  skyIntensity: 1,
  bounce: 0x2a2e48,
  horizon: 0x1f2a4c,
  top: 0x0c1428,
  night: 1,
};

/**
 * How much of the sun a shadow takes away, from how strong the sun is: all of it from `SHADOW_FULL`
 * up, none at `SHADOW_GONE` and under. A low sun's light is mostly the sky's, so a shadow melts
 * away with the sun instead of staying near-black until the sun is switched off. No cost: it is
 * one uniform (`LightShadow.intensity`), and the toon ramp still shades faces by the sun's angle.
 * The ramp bends at `SHADOW_KNEE`: a sun as weak as the evening's weighs a fifth of a shadow, not
 * half. At 20:00 the low sun still laid hard bands of the next block's roofline across a wall, half
 * as dark as by day, with the light all but gone; the moon's shadow stays a faint hint under it.
 */
export const SHADOW_FULL = 1.7;
export const SHADOW_GONE = 0.3;
export const SHADOW_KNEE = { sun: 1, weight: 0.2 } as const;
export const shadowWeight = (sunIntensity: number): number => {
  const { sun, weight } = SHADOW_KNEE;
  if (sunIntensity <= sun)
    return (Math.max(0, sunIntensity - SHADOW_GONE) / (sun - SHADOW_GONE)) * weight;
  return Math.min(1, weight + ((1 - weight) * (sunIntensity - sun)) / (SHADOW_FULL - sun));
};

/**
 * The keyframes, clockwise: night, dawn from the east, a pale morning, midday from the south,
 * golden hour from the south-west (the palette's colours, exactly), a red dusk, blue hour, night
 * again. At night a cool moon stands in for the sun, in the east, so shadows stay faint but there.
 * Blue hour is the sun gone and the moon not up: the two swing across the sky between them, and
 * with so little of either nothing casts a shadow to be seen swinging.
 */
const KEYFRAMES: readonly Keyframe[] = [
  { hour: 0, ...NIGHT },
  { hour: 5.5, ...NIGHT },
  {
    hour: 7,
    // As at dusk: low, but not grazing.
    sunDirection: [0.78, 0.38, 0.55],
    sun: 0xffb27a,
    sunIntensity: 1.1,
    sky: 0x94a8cc,
    skyIntensity: 1.05,
    bounce: 0x5e4e48,
    horizon: 0xf4bc8a,
    top: 0x6a8ab8,
    night: 0.35,
  },
  {
    hour: 9.5,
    sunDirection: [0.62, 0.55, 0.56],
    sun: 0xfff0d8,
    sunIntensity: 2.0,
    sky: 0xc8dcf5,
    skyIntensity: 1.2,
    bounce: 0x8e8470,
    horizon: 0xf8e9d2,
    top: 0x9cc8ea,
    night: 0,
  },
  {
    hour: 13,
    sunDirection: [0.08, 0.78, 0.62],
    sun: 0xfff7ea,
    sunIntensity: 2.3,
    sky: 0xd8e8fc,
    skyIntensity: 1.35,
    bounce: 0x9c9482,
    horizon: 0xf6ecdc,
    top: 0x8cc2ee,
    night: 0,
  },
  {
    hour: 18,
    sunDirection: [-0.55, 0.62, 0.56],
    sun: SUN,
    sunIntensity: LIGHT.sun,
    sky: SKY_LIGHT,
    skyIntensity: LIGHT.sky,
    bounce: BOUNCE_LIGHT,
    horizon: SKY.horizon,
    top: SKY.top,
    night: 0,
  },
  {
    hour: 20.5,
    // Low, but not grazing: at 17° a shadow is over three times a house's height, a gap between
    // two houses a razor sliver 50 m long.
    sunDirection: [-0.82, 0.36, 0.3],
    sun: 0xff9a60,
    sunIntensity: 0.8,
    sky: 0x7c84b4,
    skyIntensity: 0.95,
    bounce: 0x4a3e48,
    horizon: 0xf0a070,
    top: 0x3c4a84,
    night: 0.7,
  },
  {
    hour: 21.25,
    sunDirection: [-0.2, 0.6, 0.4],
    sun: 0x9d9ccc,
    // Too faint to cast, strong enough for the toon ramp to keep the roofs' slopes apart.
    sunIntensity: 0.42,
    sky: 0x6a74a8,
    skyIntensity: 1.05,
    bounce: 0x3a3648,
    horizon: 0x8a7898,
    top: 0x1c2448,
    night: 0.85,
  },
  { hour: 22, ...NIGHT },
  { hour: 24, ...NIGHT },
];

/** The street lamps come on at this much night (dusk), and are full at 1. */
export const LAMPS_ON = 0.3;

/** The presets the menu steps through, by name, in the order of the day. */
export const PRESETS = [
  { id: 'morning', label: 'Morning', hour: 8.5 },
  { id: 'midday', label: 'Midday', hour: 13 },
  { id: 'golden', label: 'Golden hour', hour: 18 },
  { id: 'dusk', label: 'Dusk', hour: 20.5 },
  { id: 'night', label: 'Night', hour: 23 },
] as const;
export type PresetId = (typeof PRESETS)[number]['id'];

/** The preset nearest an hour of the day, by name. */
export function presetAt(hour: number): PresetId {
  const h = wrapHour(hour);
  const gap = (q: { hour: number }) => Math.min(Math.abs(h - q.hour), 24 - Math.abs(h - q.hour));
  let best: (typeof PRESETS)[number] = PRESETS[0];
  for (const p of PRESETS) {
    if (gap(p) < gap(best)) best = p;
  }
  return best.id;
}

/** The preset after this one, round the clock. */
export function nextPreset(id: PresetId): PresetId {
  const i = PRESETS.findIndex((p) => p.id === id);
  return PRESETS[(i + 1) % PRESETS.length]!.id;
}

export const wrapHour = (hour: number): number => ((hour % 24) + 24) % 24;

/** Blends two sRGB colours in Oklab, so a sunset passes through orange, not grey. */
function blendColor(a: number, b: number, t: number): number {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const [la, aa, ba] = toOklab(a);
  const [lb, ab, bb] = toOklab(b);
  return fromOklab([la + (lb - la) * t, aa + (ab - aa) * t, ba + (bb - ba) * t]);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The light at an hour of the day, blended between the keyframes either side of it. */
export function daylightAt(hour: number): Daylight {
  const h = wrapHour(hour);
  let i = 0;
  while (i + 2 < KEYFRAMES.length && KEYFRAMES[i + 1]!.hour <= h) i++;
  const [a, b] = [KEYFRAMES[i]!, KEYFRAMES[i + 1]!];
  const raw = (h - a.hour) / (b.hour - a.hour);
  // Eased, so the light lingers on each keyframe's look and turns smoothly between them.
  const t = raw * raw * (3 - 2 * raw);
  const dir: V3 = [
    lerp(a.sunDirection[0], b.sunDirection[0], t),
    lerp(a.sunDirection[1], b.sunDirection[1], t),
    lerp(a.sunDirection[2], b.sunDirection[2], t),
  ];
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const sunDirection: V3 = [dir[0] / len, Math.max(0.2, dir[1] / len), dir[2] / len];
  const sunIntensity = lerp(a.sunIntensity, b.sunIntensity, t);
  return {
    hour: h,
    sunDirection,
    sun: blendColor(a.sun, b.sun, t),
    sunIntensity,
    shadow: shadowWeight(sunIntensity),
    sky: blendColor(a.sky, b.sky, t),
    skyIntensity: lerp(a.skyIntensity, b.skyIntensity, t),
    bounce: blendColor(a.bounce, b.bounce, t),
    horizon: blendColor(a.horizon, b.horizon, t),
    top: blendColor(a.top, b.top, t),
    night: lerp(a.night, b.night, t),
  };
}

/** The hour of the day in Leuven now, whatever clock the visitor's device keeps. */
export function leuvenHour(date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Brussels',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(date);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? Number.NaN);
    const hour = get('hour') + get('minute') / 60;
    if (Number.isFinite(hour)) return wrapHour(hour);
  } catch {
    // No time zone support: the device's own clock is near enough.
  }
  return date.getHours() + date.getMinutes() / 60;
}

/**
 * How the shadow map's sun moves: in steps, so a passing day redraws the static shadows every
 * so often rather than every frame. A step is a quarter of an hour.
 */
export const SUN_STEP_HOURS = 0.25;

/** How fast a day passes when it's let to: an hour every eight seconds, a day in about three minutes. */
export const HOURS_PER_SECOND = 1 / 8;

/** The same sun direction for every hour within one step, so the shadows hold still between. */
export function sunStep(hour: number): number {
  return Math.floor(wrapHour(hour) / SUN_STEP_HOURS) * SUN_STEP_HOURS;
}
