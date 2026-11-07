import { describe, expect, test } from 'bun:test';

import { FOLLOW_WAIT, followStrength, recentre, screenSteer } from './follow.ts';

describe('following the avatar', () => {
  test('waits after a pan by hand, then eases back in', () => {
    expect(followStrength(0)).toBe(0);
    expect(followStrength(FOLLOW_WAIT - 0.1)).toBe(0);
    const ramp = [0.1, 0.3, 0.5].map((t) => followStrength(FOLLOW_WAIT + t));
    expect(ramp[0]).toBeGreaterThan(0);
    expect(ramp[0]).toBeLessThan(ramp[1]!);
    expect(ramp[1]).toBeLessThan(ramp[2]!);
    expect(followStrength(FOLLOW_WAIT + 5)).toBe(1);
    expect(followStrength(Infinity)).toBe(1);
  });

  test('glides the target to the avatar and arrives exactly', () => {
    const at = { x: 0, z: 0 };
    let moving = true;
    let frames = 0;
    while (moving && frames < 1000) {
      moving = recentre(at, 10, -4, 1, 1 / 60);
      frames++;
    }
    expect(at).toEqual({ x: 10, z: -4 });
    // About a second for ten metres.
    expect(frames).toBeGreaterThan(30);
    expect(frames).toBeLessThan(120);
  });

  test('glides the same at any frame rate', () => {
    const [a, b] = [
      { x: 0, z: 0 },
      { x: 0, z: 0 },
    ];
    for (let i = 0; i < 30; i++) recentre(a, 20, 0, 1, 1 / 30);
    for (let i = 0; i < 144; i++) recentre(b, 20, 0, 1, 1 / 144);
    expect(a.x).toBeCloseTo(b.x, 3);
  });

  test('a paused follow leaves the view be; a weak one moves it less', () => {
    const at = { x: 0, z: 0 };
    expect(recentre(at, 10, 0, 0, 0.1)).toBe(false);
    expect(at.x).toBe(0);
    const [weak, full] = [
      { x: 0, z: 0 },
      { x: 0, z: 0 },
    ];
    recentre(weak, 10, 0, 0.3, 0.1);
    recentre(full, 10, 0, 1, 0.1);
    expect(weak.x).toBeGreaterThan(0);
    expect(weak.x).toBeLessThan(full.x);
  });
});

describe('steering by the screen', () => {
  test('up walks away from the camera, right to its right', () => {
    // Yaw 0: the camera south of its target, looking north (-z).
    const [ux, uz] = screenSteer(0, 0, 1);
    expect(ux).toBeCloseTo(0);
    expect(uz).toBeCloseTo(-1);
    const [rx, rz] = screenSteer(0, 1, 0);
    expect(rx).toBeCloseTo(1);
    expect(rz).toBeCloseTo(0);
  });

  test('turns with the map, a quarter at a time', () => {
    const [x, z] = screenSteer(Math.PI / 4, 0, 1);
    expect(x).toBeCloseTo(-Math.SQRT1_2);
    expect(z).toBeCloseTo(-Math.SQRT1_2);
    const [x2, z2] = screenSteer(Math.PI / 4 + Math.PI / 2, 0, 1);
    expect(x2).toBeCloseTo(-Math.SQRT1_2);
    expect(z2).toBeCloseTo(Math.SQRT1_2);
  });

  test('diagonals are as long as their keys say', () => {
    const [x, z] = screenSteer(1, 1, 1);
    expect(Math.hypot(x, z)).toBeCloseTo(Math.SQRT2);
  });
});
