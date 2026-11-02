import { describe, expect, test } from 'bun:test';

import { PAWLS, bell, createRideSounds, kickstand, pawl, thud } from './riding.ts';
import type { Voice } from './sound.ts';

const mid = () => 0.5;
const pitches = (v: Voice) => (typeof v.pitch === 'number' ? [v.pitch, v.pitch] : v.pitch);

/** Every voice stays a quiet toy sound: audible, never shrill, rising and falling cleanly. */
function expectSane(voices: Voice[], longest = 0.4) {
  for (const v of voices) {
    for (const hz of pitches(v)) {
      expect(hz).toBeGreaterThanOrEqual(50);
      expect(hz).toBeLessThanOrEqual(8000);
    }
    expect(v.decay).toBeGreaterThan(0.005);
    expect((v.attack ?? 0) + v.decay + (v.delay ?? 0)).toBeLessThanOrEqual(longest);
  }
  expect(voices.reduce((sum, v) => sum + v.gain, 0)).toBeLessThanOrEqual(0.3);
}

describe('riding sounds', () => {
  test('the freewheel ticks as each pawl passes, only while coasting', () => {
    const played: Voice[][] = [];
    const sounds = createRideSounds((voices) => played.push([...voices]));
    // Two turns of the wheel at a cruise, coasting: a tick a pawl passed (not the one it starts on).
    for (let wheel = 0; wheel < 4 * Math.PI; wheel += 0.05) {
      sounds.freewheel(wheel % (2 * Math.PI), 8.5, true);
    }
    expect(played).toHaveLength(2 * PAWLS - 1);
    // Pedalling, or crawling, it is quiet.
    for (let wheel = 0; wheel < 2 * Math.PI; wheel += 0.05) sounds.freewheel(wheel, 8.5, false);
    for (let wheel = 0; wheel < 2 * Math.PI; wheel += 0.05) sounds.freewheel(wheel, 0.3, true);
    expect(played).toHaveLength(2 * PAWLS - 1);
    // About 18 a second at a cruise.
    expect((8.5 / (0.34 * 1.3) / (Math.PI * 2)) * PAWLS).toBeCloseTo(18, 0);
  });

  test('a pawl is a tiny click, quieter slowly', () => {
    expectSane(pawl(8, mid));
    expect(pawl(2, mid)[0]!.gain).toBeLessThan(pawl(8, mid)[0]!.gain);
  });

  test('the bell rings twice in two partials, and longer than a tap', () => {
    const ring = bell(mid);
    expectSane(ring, 0.7);
    const tones = ring.filter((v) => v.wave === 'sine');
    expect(tones).toHaveLength(4);
    expect(new Set(tones.map((v) => v.delay)).size).toBe(2);
    expect(pitches(tones[1]!)[0]! / pitches(tones[0]!)[0]!).toBeCloseTo(1.48);
  });

  test('the kickstand clacks, and a hard hit thuds deeper and louder than a soft one', () => {
    expectSane(kickstand(true));
    expect(pitches(kickstand(true)[1]!)[0]).toBeLessThan(pitches(kickstand(false)[1]!)[0]!);
    expectSane(thud(13, mid));
    expect(thud(13, mid)[0]!.gain).toBeGreaterThan(thud(2, mid)[0]!.gain);
  });

  test('each sound plays through the engine it is given', () => {
    const played: Voice[][] = [];
    const sounds = createRideSounds((voices) => played.push([...voices]));
    sounds.bell();
    sounds.kickstand(false);
    sounds.thud(5);
    expect(played.map((v) => v.length)).toEqual([6, 2, 2]);
  });
});
