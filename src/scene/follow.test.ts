import { describe, expect, test } from 'bun:test';

import { recentre, screenSteer } from './follow.ts';

describe('following the avatar', () => {
  test('glides the target to the avatar and arrives exactly', () => {
    const at = { x: 0, z: 0 };
    let moving = true;
    let frames = 0;
    while (moving && frames < 1000) {
      moving = recentre(at, 10, -4, 1 / 60);
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
    for (let i = 0; i < 30; i++) recentre(a, 20, 0, 1 / 30);
    for (let i = 0; i < 144; i++) recentre(b, 20, 0, 1 / 144);
    expect(a.x).toBeCloseTo(b.x, 3);
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
