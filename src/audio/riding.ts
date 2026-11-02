/**
 * Riding's sounds, in riding's own chunk: the freewheel ticking while the bike coasts, the bell,
 * the kickstand and a thud against a wall. Each is scheduled when it happens (a pawl passing,
 * a key pressed), never per frame, in the same felt-and-wood register as the footsteps.
 */

import { sound, vary } from './sound.ts';
import type { Voice } from './sound.ts';

/** Clicks of the freewheel's pawls per turn of the wheel: about 25 a second at a cruise. */
export const PAWLS = 6;
/** Slower than this (m/s) the ticks are too far apart to hear as a freewheel. */
const TICKING = 0.6;

/** One pawl: a tiny bright click, quieter the slower the wheel turns. */
export function pawl(speed: number, random = Math.random): Voice[] {
  const level = Math.min(1, speed / 8);
  return [
    {
      wave: 'noise',
      pitch: vary(5200, 0.08, random),
      gain: 0.012 + 0.014 * level,
      decay: 0.008,
      q: 6,
    },
    { wave: 'triangle', pitch: vary(2600, 0.05, random), gain: 0.008 * level, decay: 0.01 },
  ];
}

/**
 * The bell: a "tring" of two inharmonic partials, struck twice by its little hammer, ringing on
 * a little after.
 */
export function bell(random = Math.random): Voice[] {
  const base = vary(2350, 0.01, random);
  return [0, 0.09].flatMap((delay, i): Voice[] => [
    { wave: 'sine', pitch: base, gain: 0.07 - 0.02 * i, decay: 0.55, delay, cutoff: 6000 },
    { wave: 'sine', pitch: base * 1.48, gain: 0.04 - 0.01 * i, decay: 0.35, delay, cutoff: 7000 },
    { wave: 'noise', pitch: 4800, gain: 0.02, decay: 0.006, q: 4, delay },
  ]);
}

/** The kickstand flipping down or up: a hard little clack and a low knock under it. */
export const kickstand = (down: boolean): Voice[] => [
  { wave: 'noise', pitch: down ? 2600 : 3200, gain: 0.05, decay: 0.012, q: 3 },
  { wave: 'triangle', pitch: [down ? 420 : 520, 300], gain: 0.07, decay: 0.04, cutoff: 1500 },
];

/** Running into a wall: a soft thud, deeper and louder the harder (`speed`, m/s). */
export function thud(speed: number, random = Math.random): Voice[] {
  const hard = Math.min(1, speed / 10);
  return [
    {
      wave: 'triangle',
      pitch: [vary(120, 0.08, random), 55],
      gain: 0.08 + 0.12 * hard,
      decay: 0.12,
      cutoff: 500,
    },
    { wave: 'noise', pitch: [900, 300], gain: 0.03 + 0.04 * hard, decay: 0.06, q: 0.8 },
  ];
}

export interface RideSounds {
  /** Each step's wheel: a pawl clicks each time it passes one, while coasting. */
  freewheel(wheel: number, speed: number, coasting: boolean): void;
  bell(): void;
  kickstand(down: boolean): void;
  thud(speed: number): void;
}

export function createRideSounds(
  play: (voices: readonly Voice[]) => void = sound.play,
): RideSounds {
  let passed = 0;
  return {
    freewheel(wheel, speed, coasting) {
      const now = Math.floor((wheel / (Math.PI * 2)) * PAWLS);
      if (now === passed) return;
      passed = now;
      if (coasting && Math.abs(speed) >= TICKING) play(pawl(Math.abs(speed)));
    },
    bell: () => play(bell()),
    kickstand: (down) => play(kickstand(down)),
    thud: (speed) => play(thud(speed)),
  };
}
