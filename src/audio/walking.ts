/**
 * Walk mode's sounds, in its own chunk: footsteps in time with the stride, a cue going down to
 * the street and back up, a thud landing there, a low pair for a spot nobody can walk to, and a
 * tick when a route starts and ends. Each is scheduled when it happens, never per frame.
 */

import { sound, vary } from './sound.ts';
import type { Voice } from './sound.ts';

/** Slower than this, a foot shuffles rather than lands. */
const STEP_SPEED = 0.5;

/**
 * A footfall on stone: a soft heel thump under a short scuff of grit, in a felt-soled
 * cartoon register. A run lands harder and quicker; the right foot is a touch lower than the
 * left, like a real gait.
 */
export function footstep(run: number, left: boolean, random = Math.random): Voice[] {
  const foot = left ? 1 : 0.95;
  const pitch = vary(150, 0.06, random) * foot * (1 + 0.15 * run);
  // A few milliseconds early or late, so a stride never sounds like a metronome.
  const delay = 0.008 * random();
  return [
    {
      wave: 'triangle',
      pitch: [pitch, pitch / 2],
      gain: vary(0.15, 0.15, random) * (1 + 0.25 * run),
      decay: 0.07 - 0.02 * run,
      cutoff: 700,
      delay,
    },
    {
      wave: 'noise',
      pitch: [vary(1700, 0.12, random), 900],
      gain: vary(0.05, 0.2, random) * (1 + 0.3 * run),
      decay: 0.035 - 0.01 * run,
      q: 0.9,
      delay: delay + 0.004,
    },
  ];
}

/** Two felted notes and the air rushing by: rising down to the street, falling back up. */
export function flight(down: boolean): Voice[] {
  const [first, second] = down ? [587, 880] : [880, 587];
  const note = { wave: 'triangle', decay: 0.18, attack: 0.008, cutoff: 2000 } as const;
  return [
    {
      wave: 'noise',
      pitch: down ? [500, 1500] : [1500, 500],
      gain: 0.03,
      decay: 0.25,
      attack: 0.06,
    },
    { ...note, pitch: first, gain: 0.09, delay: 0.04 },
    { ...note, pitch: second, gain: 0.07, delay: 0.13 },
  ];
}

/** The walker dropped in landing on its feet: a soft, low thud under a puff of grit. */
export const landing = (): Voice[] => [
  { wave: 'triangle', pitch: [120, 60], gain: 0.22, decay: 0.16, cutoff: 500 },
  { wave: 'noise', pitch: [900, 400], gain: 0.06, decay: 0.12, q: 0.7, delay: 0.005 },
];

/** A spot nobody can walk to: two low notes, falling, quieter than any cue that goes. */
export const blocked = (): Voice[] => [
  { wave: 'triangle', pitch: 330, gain: 0.05, decay: 0.09, cutoff: 1200 },
  { wave: 'triangle', pitch: 247, gain: 0.05, decay: 0.12, cutoff: 1200, delay: 0.09 },
];

/** A quiet tick setting off along a route, and a lighter pair of them on arriving. */
export const routeStart = (): Voice[] => [
  { wave: 'triangle', pitch: vary(1175, 0.03), gain: 0.05, decay: 0.035 },
];
export const routeEnd = (): Voice[] => [
  { wave: 'triangle', pitch: 880, gain: 0.05, decay: 0.1 },
  { wave: 'triangle', pitch: 1175, gain: 0.04, decay: 0.14, delay: 0.08 },
];

/** Which half of the gait a phase is in: 0 after the left foot lands, 1 after the right. */
const half = (phase: number) => Math.floor((phase - Math.PI / 2) / Math.PI) & 1;

export interface WalkSounds {
  /** Each frame's gait: a foot lands each time the phase passes π/2 (left) or 3π/2 (right). */
  stride(phase: number, speed: number, run: number): void;
  enter(): void;
  leave(): void;
  /** The walker dropped in and landed. */
  land(): void;
  /** A click on a spot nobody can walk to. */
  blocked(): void;
  routeStart(): void;
  routeEnd(): void;
}

export function createWalkSounds(
  play: (voices: readonly Voice[]) => void = sound.play,
): WalkSounds {
  // A new walker stands at phase 0, half a stride after its right foot landed.
  let landed = 1;
  return {
    stride(phase, speed, run) {
      const now = half(phase);
      if (now === landed) return;
      landed = now;
      // Landing in the left half means the left foot just came down.
      if (speed >= STEP_SPEED) play(footstep(run, now === 0));
    },
    enter: () => play(flight(true)),
    leave: () => play(flight(false)),
    land: () => play(landing()),
    blocked: () => play(blocked()),
    routeStart: () => play(routeStart()),
    routeEnd: () => play(routeEnd()),
  };
}
