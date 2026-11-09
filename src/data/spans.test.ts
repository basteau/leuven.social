import { describe, expect, test } from 'bun:test';

import { carriesOf, lineLength, planSpans } from './spans.ts';
import type { SpanGround, SpanWay } from './spans.ts';

const road = (line: number[], tags = {}): SpanWay => ({
  line,
  tags: { highway: 'residential', ...tags },
});
const bridge = (line: number[], tags = {}): SpanWay => road(line, { bridge: 'yes', ...tags });
const rail = (line: number[], tags = {}): SpanWay => ({
  line,
  tags: { railway: 'rail', ...tags },
});

const open: SpanGround = {
  water: () => false,
  roadHalf: () => 5,
  roadway: () => false,
};
const ring = (x0: number, z0: number, x1: number, z1: number) => [x0, z0, x1, z0, x1, z1, x0, z1];

describe('carriesOf', () => {
  test('tells roads, paths and tracks apart', () => {
    expect(carriesOf({ railway: 'rail' })).toBe('rail');
    expect(carriesOf({ highway: 'footway' })).toBe('path');
    expect(carriesOf({ highway: 'primary' })).toBe('road');
    expect(carriesOf({ highway: 'proposed' })).toBeNull();
    expect(carriesOf({})).toBeNull();
  });
});

describe('lineLength', () => {
  test('adds up its segments', () => {
    expect(lineLength([0, 0, 3, 4, 3, 10])).toBe(11);
  });
});

describe('a road bridge over a railway', () => {
  const deck = [0, -10, 30, 10];
  const roads = [road([-200, 0, 0, 0]), bridge([0, 0, 30, 0]), road([30, 0, 230, 0])];
  const tracks = [rail([15, -100, 15, 100])];
  const plan = planSpans(roads, tracks, [ring(deck[0]!, deck[1]!, deck[2]!, deck[3]!)], open);

  test('stands the deck clear of the tracks, on its GRB outline', () => {
    expect(plan.decks).toHaveLength(1);
    expect(Math.max(...plan.decks[0]!.rise)).toBeCloseTo(7.5, 1);
    expect(plan.taken.has(0)).toBe(true);
  });

  test('ramps down to the ground on both sides, at a gentle grade', () => {
    expect(plan.ramps).toHaveLength(2);
    for (const ramp of plan.ramps) {
      expect(ramp.rise[0]).toBeCloseTo(7.5, 1);
      expect(ramp.rise.at(-1)).toBeCloseTo(0, 1);
      expect(lineLength(ramp.line)).toBeGreaterThan(100);
    }
  });

  test('leaves the ways it carries off the ground', () => {
    expect(plan.carried.has(roads[1]!)).toBe(true);
    expect(plan.carried.has(roads[0]!)).toBe(false);
  });
});

const carriageway = (z: number) => [
  road([-200, z, 0, z]),
  bridge([0, z, 30, z]),
  road([30, z, 230, z]),
];

describe('a road bridge with two carriageways over the same outline', () => {
  const tracks = [rail([15, -100, 15, 100])];
  const narrow = { ...open, roadHalf: () => 3 };
  const outline = [ring(0, -14, 30, 14)];

  test('brings each up to the deck, not only the longest', () => {
    const plan = planSpans([...carriageway(-9), ...carriageway(9)], tracks, outline, narrow);
    expect(plan.decks).toHaveLength(1);
    expect(plan.ramps).toHaveLength(4);
    for (const z of [-9, 9]) {
      expect(plan.ramps.filter((r) => Math.abs(r.line[1]! - z) < 1)).toHaveLength(2);
    }
  });

  test('gives one a ramp already carries no second', () => {
    const plan = planSpans([...carriageway(-1), ...carriageway(1)], tracks, outline, open);
    expect(plan.ramps).toHaveLength(2);
  });

  test('gives none where there is no room to climb at any grade', () => {
    const stub = [road([-20, 9, 0, 9]), bridge([0, 9, 30, 9]), road([30, 9, 50, 9])];
    const plan = planSpans([...carriageway(-9), ...stub], tracks, outline, narrow);
    expect(plan.ramps).toHaveLength(2);
  });

  test('reads a way that runs on past the outline from where it leaves it', () => {
    const long = bridge([-10, 9, 40, 9]);
    const plan = planSpans([...carriageway(-9), long], tracks, outline, narrow);
    expect(plan.decks).toHaveLength(1);
  });
});

describe('how wide a ramp is', () => {
  const roads = [road([-200, 0, 0, 0]), bridge([0, 0, 30, 0]), road([30, 0, 230, 0])];
  const tracks = [rail([15, -100, 15, 100])];
  const halfOf = (roadHalf: SpanGround['roadHalf']) =>
    planSpans(roads, tracks, [ring(0, -10, 30, 10)], { ...open, roadHalf }).ramps[0]!.half;

  test('is the road it runs on, whatever a junction along the way measures', () => {
    expect(halfOf((x) => (Math.abs(x + 60) < 6 ? 14 : 3))).toBeCloseTo(3.2);
  });

  test('is what the way says where no road surface was surveyed', () => {
    expect(halfOf(() => 0)).toBeCloseTo(5.2);
  });
});

describe('a bridge over water', () => {
  test('arches, its ends at the ground, with no ramp', () => {
    const wet: SpanGround = { ...open, water: () => true };
    const plan = planSpans([bridge([0, 0, 20, 0])], [], [], wet);
    const [deck] = plan.decks;
    expect(deck!.rise[0]).toBeCloseTo(0, 5);
    expect(Math.max(...deck!.rise)).toBeGreaterThan(0.5);
    expect(plan.ramps).toHaveLength(0);
  });
});

describe('a way marked a bridge over nothing mapped', () => {
  test('is a deck just over the ground, as wide as its way', () => {
    const plan = planSpans(
      [bridge([0, 0, 20, 0], { highway: 'footway', width: '3' })],
      [],
      [],
      open,
    );
    expect(Math.max(...plan.decks[0]!.rise)).toBeLessThan(1);
    expect(plan.taken.size).toBe(0);
  });
});

describe('a bridge with no room for ramps', () => {
  test('stays low enough to meet the ground it can reach', () => {
    const roads = [road([-5, 0, 0, 0]), bridge([0, 0, 30, 0]), road([30, 0, 34, 0])];
    const plan = planSpans(roads, [rail([15, -40, 15, 40])], [], open);
    expect(Math.max(...plan.decks[0]!.rise)).toBeLessThan(1);
  });
});

describe('a railway bridge over a road', () => {
  const roads = [road([-100, 0, 100, 0])];
  const tracks = [
    rail([0, -50, 0, -5]),
    rail([0, -5, 0, 5], { bridge: 'yes' }),
    rail([0, 5, 0, 50]),
  ];
  const plan = planSpans(roads, tracks, [ring(-8, -10, 8, 10)], open);

  test('keeps the tracks at the terrain', () => {
    expect(plan.decks).toHaveLength(1);
    expect(plan.decks[0]!.carries).toBe('rail');
    expect(Math.max(...plan.decks[0]!.rise)).toBe(0);
  });

  test('sinks the road under it', () => {
    expect(plan.ramps.length).toBeGreaterThanOrEqual(1);
    for (const ramp of plan.ramps) {
      expect(ramp.rise[0]).toBeLessThan(0);
      expect(ramp.rail).toBe(false);
    }
  });

  test('sinks it no deeper or longer than a street needs', () => {
    for (const ramp of plan.ramps) expect(ramp.rise[0]).toBeCloseTo(-4.2, 1);
    expect(lineLength(plan.ramps.at(-1)!.line)).toBeLessThan(60);
  });
});

describe('a covered road with a way in at both ends', () => {
  const roads = [
    road([-100, 0, 0, 0]),
    road([0, 0, 40, 0], { tunnel: 'yes', layer: '-1' }),
    road([40, 0, 140, 0]),
  ];
  const plan = planSpans(roads, [], [], open);

  test('is a tunnel with a mouth at each end, and a ramp down to it', () => {
    expect(plan.tunnels).toHaveLength(1);
    expect(plan.tunnels[0]!.mouths).toEqual([true, true]);
    expect(plan.ramps).toHaveLength(2);
    expect(plan.ramps[0]!.rise[0]).toBeLessThan(0);
  });
});

describe('a covered road with one end in a garage', () => {
  test('is left out', () => {
    const roads = [road([-20, 0, 0, 0]), road([0, 0, 20, 0], { tunnel: 'yes', layer: '-1' })];
    expect(planSpans(roads, [], [], open).tunnels).toHaveLength(0);
  });
});

describe('a junction', () => {
  test('stops a ramp: what branches off stays at the ground', () => {
    const roads = [
      road([-100, 0, -30, 0]),
      road([-30, 0, 0, 0]),
      road([-30, 0, -30, 40]),
      bridge([0, 0, 30, 0]),
      road([30, 0, 200, 0]),
    ];
    const plan = planSpans(roads, [rail([15, -40, 15, 40])], [], open);
    const west = plan.ramps.find((r) => r.line[2]! <= 0)!;
    expect(lineLength(west.line)).toBeLessThanOrEqual(35);
  });
});

describe('piers', () => {
  test('stand on the outline, off carriageways and tracks', () => {
    const wet: SpanGround = { ...open, water: () => true };
    const roads = [bridge([0, 0, 60, 0])];
    const plan = planSpans(roads, [], [ring(0, -6, 60, 6)], wet);
    const { piers } = plan.decks[0]!;
    expect(piers.length).toBeGreaterThan(0);
    for (let i = 0; i < piers.length; i += 2) expect(Math.abs(piers[i + 1]!)).toBeLessThan(6);
  });
});

describe('a surface road across an outline left at the ground', () => {
  test('gets its carriageway back', () => {
    const roads = [
      road([-30, 0, 30, 0]),
      road([0, -50, 0, -8]),
      road([0, -8, 0, 8], { tunnel: 'yes', layer: '-1' }),
      road([0, 8, 0, 50]),
    ];
    const plan = planSpans(roads, [], [ring(-10, -8, 10, 8)], open);
    expect(plan.groundLanes.length).toBeGreaterThan(0);
  });
});

describe('bridge ways with no GRB outline', () => {
  test('that run on from one another are one deck', () => {
    const plan = planSpans([bridge([0, 0, 15, 0]), bridge([15, 0, 30, 0])], [], [], {
      ...open,
      water: () => true,
    });
    expect(plan.decks).toHaveLength(1);
  });

  test('are one deck along the whole of them, whichever way each runs', () => {
    const plan = planSpans([bridge([0, 0, 15, 0]), bridge([25, 0, 15, 0])], [], [], {
      ...open,
      water: () => true,
    });
    const { axis } = plan.decks[0]!;
    expect(axis[0]).toBeLessThan(0);
    expect(axis.at(-2)).toBeGreaterThan(25);
  });

  test('two that do not meet are two decks', () => {
    const plan = planSpans([bridge([0, 0, 15, 0]), bridge([100, 0, 115, 0])], [], [], {
      ...open,
      water: () => true,
    });
    expect(plan.decks).toHaveLength(2);
  });
});

describe('a pier over the tracks', () => {
  test('is not built on them', () => {
    const wet: SpanGround = { ...open, water: () => true };
    const lined = [bridge([0, 0, 60, 0])];
    const rails = [rail([-10, -5, 70, -5])];
    const plan = planSpans(lined, rails, [ring(0, -6, 60, 6)], wet);
    const { piers } = plan.decks[0]!;
    for (let i = 0; i < piers.length; i += 2) expect(piers[i + 1]).toBeGreaterThan(-5.5);
  });

  test('none are built on a carriageway', () => {
    const busy: SpanGround = { ...open, water: () => true, roadway: () => true };
    const plan = planSpans([bridge([0, 0, 60, 0])], [], [ring(0, -6, 60, 6)], busy);
    expect(plan.decks[0]!.piers).toHaveLength(0);
  });
});

describe('a footbridge over the road', () => {
  test('clears a person, not a lorry', () => {
    const roads = [
      road([-100, 0, 0, 0], { highway: 'footway' }),
      bridge([0, 0, 20, 0], { highway: 'footway' }),
      road([20, 0, 120, 0], { highway: 'footway' }),
      road([10, -40, 10, 40], { highway: 'footway' }),
    ];
    expect(Math.max(...planSpans(roads, [], [], open).decks[0]!.rise)).toBeCloseTo(3.4, 1);
  });
});

describe('a tunnel of several ways', () => {
  test('is one tunnel whose inner joints are not mouths', () => {
    const roads = [
      road([-100, 0, 0, 0]),
      road([0, 0, 20, 0], { tunnel: 'yes', layer: '-1' }),
      road([20, 0, 40, 0], { tunnel: 'yes', layer: '-1' }),
      road([40, 0, 140, 0]),
    ];
    const plan = planSpans(roads, [], [], open);
    expect(plan.tunnels).toHaveLength(2);
    expect(plan.tunnels.flatMap((t) => t.mouths).filter(Boolean)).toHaveLength(2);
  });
});

describe('a skewed GRB outline', () => {
  test('lies wholly over its axis', () => {
    const skew = [0, -10, 30, -10, 40, 10, 10, 10];
    const plan = planSpans([bridge([5, 0, 35, 0])], [], [skew], {
      ...open,
      water: () => true,
    });
    const { axis, ring: outline } = plan.decks[0]!;
    expect(axis[0]).toBeLessThanOrEqual(Math.min(...outline.filter((_, i) => i % 2 === 0)));
    expect(axis.at(-2)).toBeGreaterThanOrEqual(Math.max(...outline.filter((_, i) => i % 2 === 0)));
  });
});
