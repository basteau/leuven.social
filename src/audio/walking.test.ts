import { describe, expect, test } from 'bun:test';

import type { Voice } from './sound.ts';
import { createWalkSounds, flight, footstep, routeEnd, routeStart } from './walking.ts';

const mid = () => 0.5;
const notes = (voices: Voice[]) => voices.filter((v) => v.wave !== 'noise').map(startPitch);
const startPitch = (v: Voice) => (typeof v.pitch === 'number' ? v.pitch : v.pitch[0]);

/** Every voice stays a UI sound: audible, short and quiet (create-sound's validation rules). */
function expectSane(voices: Voice[]) {
  for (const v of voices) {
    const [from, to] = typeof v.pitch === 'number' ? [v.pitch, v.pitch] : v.pitch;
    for (const hz of [from, to]) expect(hz).toBeGreaterThanOrEqual(60);
    for (const hz of [from, to]) expect(hz).toBeLessThanOrEqual(8000);
    expect(v.decay).toBeGreaterThan(0.005);
    expect((v.attack ?? 0) + v.decay + (v.delay ?? 0)).toBeLessThanOrEqual(0.4);
  }
  expect(voices.reduce((sum, v) => sum + v.gain, 0)).toBeLessThanOrEqual(0.6);
}

describe('footsteps', () => {
  test('land on each foot as the gait passes π/2 and 3π/2, not when wrapping round', () => {
    const play: Voice[][] = [];
    const recorder = createWalkSounds((voices) => play.push([...voices]));
    // Two full strides, in small frames.
    for (let phase = 0; phase < 4 * Math.PI; phase += 0.3) {
      recorder.stride(phase % (2 * Math.PI), 2, 0);
    }
    expect(play).toHaveLength(4);
    expect(play.every((voices) => voices.length === 2)).toBe(true);
  });

  test('a shuffle is silent', () => {
    const play: unknown[] = [];
    const sounds = createWalkSounds((voices) => play.push(voices));
    for (let phase = 0; phase < 2 * Math.PI; phase += 0.3) sounds.stride(phase, 0.2, 0);
    expect(play).toHaveLength(0);
  });

  test('a run lands higher, harder and quicker than a walk', () => {
    const [walkThump, walkScuff] = footstep(0, true, mid);
    const [runThump, runScuff] = footstep(1, true, mid);
    expect(startPitch(runThump!)).toBeGreaterThan(startPitch(walkThump!));
    expect(runThump!.gain).toBeGreaterThan(walkThump!.gain);
    expect(runThump!.decay).toBeLessThan(walkThump!.decay);
    expect(runScuff!.gain).toBeGreaterThan(walkScuff!.gain);
    expect(startPitch(footstep(0, false, mid)[0]!)).toBeLessThan(startPitch(walkThump!));
  });

  test('no two steps are the same', () => {
    const a = footstep(0, true);
    const b = footstep(0, true);
    expect(startPitch(a[0]!)).not.toBe(startPitch(b[0]!));
  });

  test('every walk sound is short, quiet and audible', () => {
    for (const random of [() => 0, () => 0.999]) {
      expectSane(footstep(0, true, random));
      expectSane(footstep(1, false, random));
    }
    expectSane(flight(true));
    expectSane(flight(false));
    expectSane(routeStart());
    expectSane(routeEnd());
  });
});

test('the cues play their own sounds, going down rising and coming up falling', () => {
  const play: Voice[][] = [];
  const sounds = createWalkSounds((voices) => play.push([...voices]));
  sounds.enter();
  sounds.leave();
  sounds.routeStart();
  sounds.routeEnd();
  expect(play).toEqual([flight(true), flight(false), expect.any(Array), routeEnd()]);
  const [down, up] = [notes(play[0]!), notes(play[1]!)];
  expect(down[1]).toBeGreaterThan(down[0]!);
  expect(up[1]).toBeLessThan(up[0]!);
  expect(play[2]).toHaveLength(1);
});
