import { describe, expect, test } from 'bun:test';

import { LIGHT } from './lighting.ts';
import {
  HOURS_PER_SECOND,
  PRESETS,
  SHADOW_FULL,
  SHADOW_GONE,
  SUN_STEP_HOURS,
  daylightAt,
  leuvenHour,
  nextPreset,
  presetAt,
  shadowWeight,
  sunStep,
  wrapHour,
} from './daylight.ts';
import { BOUNCE_LIGHT, SKY, SKY_LIGHT, SUN } from './palette.ts';

describe('daylightAt', () => {
  test('golden hour is the palette, exactly', () => {
    const d = daylightAt(18);
    expect(d.sun).toBe(SUN);
    expect(d.sunIntensity).toBe(LIGHT.sun);
    expect(d.sky).toBe(SKY_LIGHT);
    expect(d.skyIntensity).toBe(LIGHT.sky);
    expect(d.bounce).toBe(BOUNCE_LIGHT);
    expect(d.horizon).toBe(SKY.horizon);
    expect(d.top).toBe(SKY.top);
    expect(d.night).toBe(0);
    // From the south-west, 38° up, as the viewer always had it.
    expect(d.sunDirection[0]).toBeLessThan(0);
    expect(d.sunDirection[2]).toBeGreaterThan(0);
    expect(Math.hypot(...d.sunDirection)).toBeCloseTo(1);
  });

  test('night is dark, fully night, and still lit from above', () => {
    for (const hour of [0, 3, 23.5, 24]) {
      const d = daylightAt(hour);
      expect(d.night).toBe(1);
      expect(d.sunIntensity).toBeLessThan(1);
      expect(d.sunDirection[1]).toBeGreaterThanOrEqual(0.2);
      expect(d.top).toBeLessThan(0x202040);
    }
  });

  test('the sun rises in the east and sets in the west', () => {
    expect(daylightAt(7).sunDirection[0]).toBeGreaterThan(0.5);
    expect(daylightAt(13).sunDirection[1]).toBeGreaterThan(0.7);
    expect(daylightAt(20.5).sunDirection[0]).toBeLessThan(-0.5);
  });

  test('between keyframes everything blends, and never jumps', () => {
    let last = daylightAt(0);
    for (let h = 0.05; h <= 24; h += 0.05) {
      const d = daylightAt(h);
      expect(Math.abs(d.night - last.night)).toBeLessThan(0.08);
      expect(Math.abs(d.sunIntensity - last.sunIntensity)).toBeLessThan(0.1);
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(d.sunDirection[i]! - last.sunDirection[i]!)).toBeLessThan(0.12);
      }
      expect(Math.hypot(d.sunDirection[0], d.sunDirection[1], d.sunDirection[2])).toBeCloseTo(1, 1);
      last = d;
    }
  });

  test('a sunset goes through orange, not grey', () => {
    const d = daylightAt(19.5);
    const [r, g, b] = [(d.horizon >> 16) & 255, (d.horizon >> 8) & 255, d.horizon & 255];
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });

  test('hours wrap round the clock', () => {
    expect(daylightAt(25)).toEqual(daylightAt(1));
    expect(daylightAt(-1)).toEqual(daylightAt(23));
    expect(wrapHour(-0.5)).toBeCloseTo(23.5);
  });
});

const linear = (c: number) => ((c / 255 + 0.055) / 1.055) ** 2.4;
const luma = (hex: number) =>
  0.2126 * linear((hex >> 16) & 255) +
  0.7152 * linear((hex >> 8) & 255) +
  0.0722 * linear(hex & 255);

// Flat ground: what the sun adds where it reaches, over what's left in the shadow.
const contrast = (hour: number) => {
  const d = daylightAt(hour);
  const sky = d.skyIntensity * luma(d.sky);
  const sun = d.sunIntensity * luma(d.sun);
  return (sky + sun) / (sky + (1 - d.shadow) * sun);
};

describe('how much a shadow weighs', () => {
  test('goes with the strength of the sun, all of it to none of it', () => {
    expect(shadowWeight(SHADOW_FULL)).toBe(1);
    expect(shadowWeight(3)).toBe(1);
    expect(shadowWeight(SHADOW_GONE)).toBe(0);
    expect(shadowWeight(0)).toBe(0);
    expect(shadowWeight((SHADOW_FULL + SHADOW_GONE) / 2)).toBeCloseTo(0.5);
  });

  test('a day keeps its full shadows, golden hour and midday as they were', () => {
    expect(daylightAt(13).shadow).toBe(1);
    expect(daylightAt(18).shadow).toBe(1);
    expect(contrast(18)).toBeGreaterThan(2.5);
  });

  test('a weak sun gives a weak shadow, melting away rather than switching off', () => {
    expect(contrast(20.5)).toBeLessThan(1.5);
    expect(contrast(23)).toBeLessThan(1.3);
    expect(contrast(7)).toBeLessThan(1.8);
    // Between the sun and the moon nothing casts a shadow to be seen swinging across the sky.
    expect(daylightAt(21.25).shadow).toBeLessThan(0.1);
    let last = contrast(19.25);
    for (let h = 19.25; h <= 21.25; h += 0.05) {
      const now = contrast(h);
      expect(now).toBeLessThanOrEqual(last + 1e-6);
      last = now;
    }
  });

  test('the low sun stays over 20 degrees, so its shadows stop short of a street away', () => {
    for (let h = 7; h <= 20.5; h += 0.25) {
      expect(Math.asin(daylightAt(h).sunDirection[1]) * (180 / Math.PI)).toBeGreaterThan(20);
    }
  });
});

describe('presets', () => {
  test('step round the day and find the nearest to an hour', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['morning', 'midday', 'golden', 'dusk', 'night']);
    expect(nextPreset('golden')).toBe('dusk');
    expect(nextPreset('night')).toBe('morning');
    expect(presetAt(18.4)).toBe('golden');
    expect(presetAt(2)).toBe('night');
    expect(presetAt(23.9)).toBe('night');
    expect(presetAt(9)).toBe('morning');
  });
});

describe('the clock', () => {
  test('reads Leuven time, whatever the device keeps', () => {
    // 2026-07-01T10:30Z is 12:30 in Leuven (CEST).
    expect(leuvenHour(new Date('2026-07-01T10:30:00Z'))).toBeCloseTo(12.5);
    // In winter one hour ahead of UTC.
    expect(leuvenHour(new Date('2026-01-15T23:30:00Z'))).toBeCloseTo(0.5);
    expect(leuvenHour()).toBeGreaterThanOrEqual(0);
    expect(leuvenHour()).toBeLessThan(24);
  });

  test('the shadow sun moves in quarter-hour steps; a day passes in a few minutes', () => {
    expect(sunStep(18.2)).toBe(18);
    expect(sunStep(18.26)).toBe(18.25);
    expect(sunStep(24.1)).toBeCloseTo(0);
    expect(SUN_STEP_HOURS).toBe(0.25);
    expect(24 / HOURS_PER_SECOND).toBeLessThan(300);
  });
});
