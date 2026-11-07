import { describe, expect, test } from 'bun:test';

import { DEFAULT_DELAY, createSnapshots, shortestArc } from './interpolate.ts';
import type { PlayerState } from './protocol.ts';

const at = (x: number, z = 0, more: Partial<PlayerState> = {}): PlayerState => ({
  x,
  z,
  heading: 0,
  speed: 1.4,
  mode: 'foot',
  place: '',
  floor: 0,
  ...more,
});

describe('shortestArc', () => {
  test('turns the short way round', () => {
    expect(shortestArc(0, 1)).toBeCloseTo(1);
    expect(shortestArc(1, 0)).toBeCloseTo(-1);
    expect(shortestArc(0.1, Math.PI * 2 - 0.1)).toBeCloseTo(-0.2);
    expect(shortestArc(Math.PI * 2 - 0.1, 0.1)).toBeCloseTo(0.2);
    expect(shortestArc(0, Math.PI)).toBeCloseTo(Math.PI);
    expect(shortestArc(0, 7 * Math.PI)).toBeCloseTo(Math.PI);
  });
});

describe('createSnapshots', () => {
  test('nothing to draw before the first update, then the first one', () => {
    const s = createSnapshots();
    expect(s.sample(1000)).toBeNull();
    expect(s.latest()).toBeNull();
    s.push(1000, at(5));
    expect(s.sample(1000)).toEqual(at(5));
    expect(s.sample(5000)).toEqual(at(5));
    expect(s.latest()).toEqual(at(5));
  });

  test('draws `delay` in the past, between the updates around it', () => {
    const s = createSnapshots();
    s.push(1000, at(0));
    s.push(1100, at(1, 2, { heading: 1, speed: 2 }));
    s.push(1200, at(2, 4));
    expect(s.sample(1000 + DEFAULT_DELAY)).toEqual(at(0));
    const mid = s.sample(1050 + DEFAULT_DELAY)!;
    expect(mid.x).toBeCloseTo(0.5);
    expect(mid.z).toBeCloseTo(1);
    expect(mid.heading).toBeCloseTo(0.5);
    expect(mid.speed).toBeCloseTo(1.7);
    expect(s.sample(1175 + DEFAULT_DELAY)!.x).toBeCloseTo(1.75);
    expect(s.sample(1200 + DEFAULT_DELAY)!.x).toBeCloseTo(2);
  });

  test('turns across north the short way', () => {
    const s = createSnapshots({ delay: 0 });
    s.push(0, at(0, 0, { heading: Math.PI * 2 - 0.2 }));
    s.push(100, at(0, 0, { heading: 0.2 }));
    expect(s.sample(50)!.heading).toBeCloseTo(Math.PI * 2);
  });

  test('carries on for a moment past the last update, the way it faces, then stops', () => {
    const s = createSnapshots({ delay: 0, extrapolate: 200 });
    s.push(0, at(0));
    // Facing east (+x) at 10 m/s.
    s.push(100, at(1, 0, { heading: Math.PI / 2, speed: 10 }));
    const ahead = s.sample(150)!;
    expect(ahead.x).toBeCloseTo(1.5);
    expect(ahead.z).toBeCloseTo(0);
    expect(ahead.heading).toBe(Math.PI / 2);
    expect(ahead.speed).toBe(10);
    expect(s.sample(300)!.x).toBeCloseTo(3);
    expect(s.sample(10_000)!.x).toBeCloseTo(3);
  });

  test('two updates a millisecond apart are no leap', () => {
    const s = createSnapshots({ delay: 0, extrapolate: 200 });
    s.push(0, at(0, 0, { heading: Math.PI / 2, speed: 1.5 }));
    s.push(100, at(0.15, 0, { heading: Math.PI / 2, speed: 1.5 }));
    s.push(102, at(0.3, 0, { heading: Math.PI / 2, speed: 1.5 }));
    // 200 ms on at 1.5 m/s: 30 cm past the last update, not metres.
    expect(s.sample(422)!.x).toBeCloseTo(0.6);
  });

  test('a figure that stopped does not run on', () => {
    const s = createSnapshots({ delay: 0 });
    s.push(0, at(0));
    s.push(100, at(1, 0, { speed: 0 }));
    expect(s.sample(250)).toEqual(at(1, 0, { speed: 0 }));
  });

  test('snaps across a door instead of gliding', () => {
    const s = createSnapshots({ delay: 0 });
    s.push(0, at(0));
    s.push(100, at(40));
    expect(s.sample(50)).toEqual(at(0));
    expect(s.sample(100)).toEqual(at(40));
    expect(s.sample(150)).toEqual(at(40));
  });

  test('a change of room or floor is a jump however short', () => {
    const s = createSnapshots({ delay: 0 });
    s.push(0, at(0));
    s.push(100, at(1, 0, { place: 'stadhuis' }));
    s.push(200, at(1, 0, { place: 'stadhuis', floor: 1 }));
    expect(s.sample(50)).toEqual(at(0));
    expect(s.sample(150)).toEqual(at(1, 0, { place: 'stadhuis' }));
    expect(s.sample(250)).toEqual(at(1, 0, { place: 'stadhuis', floor: 1 }));
  });

  test('the discrete fields switch when the draw time reaches the next update', () => {
    const s = createSnapshots({ delay: 0 });
    s.push(0, at(0));
    s.push(100, at(1, 0, { mode: 'bike' }));
    expect(s.sample(99)!.mode).toBe('foot');
    expect(s.sample(100)!.mode).toBe('bike');
  });

  test('after a pause the figure sets off from where it stood', () => {
    const s = createSnapshots({ delay: 0 });
    s.push(0, at(0));
    s.push(5000, at(1));
    expect(s.sample(4900)).toEqual(at(0));
    expect(s.sample(4950)!.x).toBeCloseTo(0.5);
  });

  test('a second update in the same millisecond replaces the first', () => {
    const s = createSnapshots({ delay: 0 });
    s.push(0, at(0));
    s.push(100, at(1));
    s.push(100, at(2));
    s.push(90, at(3));
    expect(s.latest()).toEqual(at(3));
    expect(s.sample(50)!.x).toBeCloseTo(1.5);
  });

  test('keeps only a few updates', () => {
    const s = createSnapshots({ delay: 0, keep: 3 });
    for (let i = 0; i < 10; i++) s.push(i * 100, at(i));
    // The oldest kept is at 700 ms: earlier draw times clamp to it.
    expect(s.sample(0)).toEqual(at(7));
  });
});
