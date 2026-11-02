import { describe, expect, test } from 'bun:test';

import { LANE, fieldCorners, fieldOf, pitchSurface } from './pitches.ts';

const AREA = [{ minX: -500, minZ: -500, maxX: 500, maxZ: 500 }];

/** A rectangle `length` along a direction `angle` from +x, `width` across, centred on (x, z). */
function rect(length: number, width: number, angle = 0, x = 0, z = 0): number[] {
  return fieldCorners({ sport: 'soccer', x, z, angle, length, width, count: 1 });
}

/** A stadium (two straights and two bends) `length` long and `width` wide, along x. */
function stadium(length: number, width: number, reverse = false): number[] {
  const r = width / 2;
  const half = length / 2 - r;
  const ring: number[] = [];
  for (let i = 0; i <= 16; i++) {
    const a = -Math.PI / 2 + (i / 16) * Math.PI;
    ring.push(half + r * Math.cos(a), r * Math.sin(a));
  }
  for (let i = 0; i <= 16; i++) {
    const a = Math.PI / 2 + (i / 16) * Math.PI;
    ring.push(-half + r * Math.cos(a), r * Math.sin(a));
  }
  if (!reverse) return ring;
  const out: number[] = [];
  for (let i = ring.length - 2; i >= 0; i -= 2) out.push(ring[i]!, ring[i + 1]!);
  return out;
}

const track = (outer: number[], holes: number[][]) =>
  fieldOf({ leisure: 'track' }, { outer, holes }, AREA);

const pitch = (sport: string, ring: number[], extra: Record<string, string> = {}) =>
  fieldOf({ leisure: 'pitch', sport, ...extra }, { outer: ring, holes: [] }, AREA);

describe('pitch surfaces', () => {
  test.each([
    [{ leisure: 'pitch', sport: 'soccer', surface: 'artificial_turf' }, 'turf'],
    [{ leisure: 'pitch', sport: 'tennis', surface: 'concrete' }, 'hard'],
    [{ leisure: 'pitch', sport: 'boules', surface: 'fine_gravel' }, 'gravel'],
    [{ leisure: 'track', surface: 'tartan' }, 'tartan'],
    [{ leisure: 'pitch', sport: 'basketball', surface: 'rubber' }, 'tartan'],
    // Untagged: the sport's usual surface, the first one that has one.
    [{ leisure: 'pitch', sport: 'tennis' }, 'clay'],
    [{ leisure: 'pitch', sport: 'soccer;field_hockey' }, 'grass'],
    [{ leisure: 'pitch', sport: 'kinball;padel' }, 'turf'],
    [{ leisure: 'pitch', sport: 'beachvolleyball' }, 'sand'],
    [{ leisure: 'pitch', sport: 'basketball', surface: 'something' }, 'hard'],
    // A running track is tartan, any other pitch grass.
    [{ leisure: 'track', sport: 'athletics' }, 'grass'],
    [{ leisure: 'track' }, 'tartan'],
    [{ leisure: 'pitch' }, 'grass'],
  ] as const)('%o is %s', (tags, surface) => {
    expect(pitchSurface(tags)).toBe(surface);
  });
});

describe('fields', () => {
  test('a soccer pitch keeps its rectangle, its direction folded into [0, π)', () => {
    const field = pitch('soccer', rect(105, 68, -0.4, 20, 30));
    expect(field).toMatchObject({ sport: 'soccer', count: 1 });
    expect(field!.x).toBeCloseTo(20);
    expect(field!.z).toBeCloseTo(30);
    expect(field!.length).toBeCloseTo(105);
    expect(field!.width).toBeCloseTo(68);
    expect(field!.angle).toBeCloseTo(Math.PI - 0.4);
  });

  test('the first sport with lines decides', () => {
    expect(pitch('field_hockey;soccer', rect(60, 40))?.sport).toBe('soccer');
    expect(pitch('basketball;soccer', rect(28, 15))?.sport).toBe('basketball');
    expect(pitch('padel', rect(20, 10))).toBeNull();
    expect(fieldOf({ leisure: 'pitch' }, { outer: rect(105, 68), holes: [] }, AREA)).toBeNull();
  });

  test('too small, too long, too square or not a rectangle: no lines', () => {
    expect(pitch('soccer', rect(25, 6))).toBeNull();
    expect(pitch('soccer', rect(20, 14))).toBeNull();
    expect(pitch('soccer', rect(50, 48))).toBeNull();
    expect(pitch('basketball', rect(22, 5))).toBeNull();
    expect(pitch('tennis', rect(15, 8))).toBeNull();
    // An L: a third of its rectangle is missing.
    expect(pitch('soccer', [0, 0, 60, 0, 60, 20, 30, 20, 30, 40, 0, 40])).toBeNull();
    // A pitch with a hole isn't a field.
    const holed = { outer: rect(105, 68), holes: [rect(10, 10)] };
    expect(fieldOf({ leisure: 'pitch', sport: 'soccer' }, holed, AREA)).toBeNull();
  });

  test('tennis courts lie side by side, whichever way round fits more', () => {
    expect(pitch('tennis', rect(34, 17))).toMatchObject({ count: 1 });
    expect(pitch('tennis', rect(37, 36))).toMatchObject({ count: 2 });
    // 51 by 37: three courts across the long side, each running along the short one.
    const three = pitch('tennis', rect(51, 37));
    expect(three).toMatchObject({ count: 3 });
    expect(three!.length).toBeCloseTo(37);
    expect(three!.width).toBeCloseTo(51);
    expect(three!.angle).toBeCloseTo(Math.PI / 2);
  });

  test('a running track: lanes between its infield and its outer edge', () => {
    const field = track(stadium(176, 92), [stadium(158, 73, true)]);
    expect(field).toMatchObject({ sport: 'track', count: Math.floor(9.5 / LANE) });
    expect(field!.length).toBeCloseTo(158, 0);
    expect(field!.width).toBeCloseTo(73, 0);
    // At most eight lanes; under three is no track to draw.
    expect(track(stadium(200, 110), [stadium(158, 73, true)])?.count).toBe(8);
    expect(track(stadium(162, 77), [stadium(158, 73, true)])).toBeNull();
    // A track drawn as one area, with no infield, or round a field too small or square.
    expect(track(stadium(176, 92), [])).toBeNull();
    expect(track(stadium(60, 30), [stadium(50, 20, true)])).toBeNull();
    expect(track(stadium(176, 150), [stadium(140, 130, true)])).toBeNull();
    expect(track(stadium(176, 92), [[-79, 36.5, 79, 36.5, 0, -36.5]])).toBeNull();
  });

  test('a field reaching out of the area gets no lines', () => {
    expect(pitch('soccer', rect(105, 68, 0, 450, 0))).toBeNull();
    expect(pitch('soccer', rect(105, 68, 0, 440, 0))).not.toBeNull();
  });

  test('corners run round the rectangle', () => {
    const corners = fieldCorners({
      sport: 'tennis',
      x: 10,
      z: 0,
      angle: Math.PI / 2,
      length: 4,
      width: 2,
      count: 1,
    });
    const expected = [11, -2, 11, 2, 9, 2, 9, -2];
    corners.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!));
  });
});
