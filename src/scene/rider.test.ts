import { describe, expect, test } from 'bun:test';

import type { Ground } from './collide.ts';
import {
  BACK,
  BRAKE,
  CORNER,
  CRUISE,
  GEAR,
  MAX_LEAN,
  SPRINT,
  WHEELBASE,
  createInput,
  createRider,
  level,
  maxSteer,
  routeInput,
  stepRider,
} from './rider.ts';
import type { Path, RideInput, Rider } from './rider.ts';
import { STEP } from './walker.ts';

/** Ground walled by half-planes, each a point on its face and the way out of it (x, z). */
function planes(...faces: [number, number, number, number][]): Ground {
  return {
    wallOverlap(x, z, radius, out) {
      let [sx, sz, deep] = [0, 0, 0];
      for (const [px, pz, nx, nz] of faces) {
        const into = radius - ((x - px) * nx + (z - pz) * nz);
        if (into > 0) [sx, sz, deep] = [sx + nx * into, sz + nz * into, Math.max(deep, into)];
      }
      const length = Math.hypot(sx, sz);
      if (length > 0) [out[0], out[1]] = [sx / length, sz / length];
      return length > 0 ? deep : 0;
    },
    closed: () => 0,
  };
}
const open = planes();

const input = (more: Partial<RideInput> = {}): RideInput => ({ ...createInput(), ...more });

/** Rides for `seconds` at the fixed step; returns the seconds until `until` held, or Infinity. */
function ride(
  r: Rider,
  seconds: number,
  with_: Partial<RideInput> = {},
  ground: Ground = open,
  until?: (r: Rider) => boolean,
): number {
  const i = input(with_);
  for (let n = 1; n <= seconds / STEP; n++) {
    stepRider(r, STEP, i, ground);
    if (until?.(r)) return n * STEP;
  }
  return Infinity;
}

const deg = (radians: number) => (radians * 180) / Math.PI;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

describe('pedalling', () => {
  test('reaches a cruise in about three seconds and holds it there', () => {
    const r = createRider(0, 0, 0);
    const t = ride(r, 10, { throttle: 1 }, open, (q) => q.speed >= CRUISE * 0.95);
    expect(t).toBeGreaterThan(2.5);
    expect(t).toBeLessThan(3.5);
    ride(r, 10, { throttle: 1 });
    expect(r.speed).toBeCloseTo(CRUISE, 0);
    expect(r.speed).toBeLessThanOrEqual(CRUISE + 0.01);
    expect(r.z).toBeGreaterThan(80);
    expect(Math.abs(r.x)).toBeLessThan(1e-6);
  });

  test('sprints to 17.5 m/s, and eases back to a cruise when the sprint ends', () => {
    expect([CRUISE, SPRINT]).toEqual([11.5, 17.5]); // 35% up from 8.5 and 13
    const r = createRider(0, 0, 0);
    r.speed = CRUISE;
    const t = ride(r, 10, { throttle: 1, sprint: true }, open, (q) => q.speed >= SPRINT * 0.95);
    expect(t).toBeLessThan(4);
    expect(r.stand).toBeGreaterThan(0.9);
    ride(r, 10, { throttle: 1 });
    expect(r.speed).toBeCloseTo(CRUISE, 0);
    expect(r.stand).toBeLessThan(0.01);
  });

  test('a half-pushed stick rides at about half the pace', () => {
    const r = createRider(0, 0, 0);
    ride(r, 10, { throttle: 0.5 });
    expect(r.speed).toBeGreaterThan(CRUISE * 0.45);
    expect(r.speed).toBeLessThan(CRUISE * 0.6);
  });

  test('coasts down at about 0.4 m/s² from a cruise, and brakes to a stop within 11 m', () => {
    const coast = createRider(0, 0, 0);
    coast.speed = CRUISE;
    ride(coast, 1);
    expect(CRUISE - coast.speed).toBeGreaterThan(0.3);
    expect(CRUISE - coast.speed).toBeLessThan(0.5);
    expect(coast.pedalling).toBe(false);
    const brake = createRider(0, 0, 0);
    brake.speed = CRUISE;
    const t = ride(brake, 5, { throttle: -1 }, open, (q) => q.speed <= 0);
    expect(t).toBeCloseTo(CRUISE / BRAKE, 1);
    expect(brake.z).toBeCloseTo((CRUISE * CRUISE) / (2 * BRAKE), 0);
    expect(brake.z).toBeLessThan(11);
  });

  test('held, S brakes to a stop and then backs up at a walking pace', () => {
    const r = createRider(0, 0, 0);
    r.speed = 3;
    ride(r, 4, { throttle: -1 });
    expect(r.speed).toBeCloseTo(-BACK);
    expect(r.z).toBeLessThan(1);
    ride(r, 1);
    expect(r.speed).toBe(0);
  });
});

describe('turning', () => {
  test('at full lock, turns as tight as the speed allows and leans a gentle 16° at most', () => {
    const table: string[] = [];
    for (const v of [2, 5, CRUISE, SPRINT]) {
      const r = createRider(0, 0, 0);
      r.speed = v;
      for (let i = 0; i < 2 / STEP; i++) {
        stepRider(r, STEP, input({ throttle: 1, turn: 1, sprint: v > CRUISE }), open);
        r.speed = v;
      }
      const radius = v / Math.abs(r.turning);
      table.push(`${v} m/s: r ${radius.toFixed(1)} m, lean ${deg(r.lean).toFixed(0)}°`);
      expect(radius).toBeCloseTo(Math.max(1.5, (v * v) / 12), 0);
      // Turning right leans right: negative, toward -x from +z.
      expect(r.turning).toBeLessThan(0);
      expect(r.lean).toBeLessThan(0);
      expect(Math.abs(r.lean)).toBeLessThanOrEqual(MAX_LEAN + 1e-6);
    }
    expect(deg(MAX_LEAN)).toBeCloseTo(16, 0);
    // 1.5 m round at 2 m/s, 2.1 at 5, 11 at a cruise and 25.5 flat out (were 1.7, 3.1, 16.5, 38, leaning
    // up to 39°).
    expect(table).toEqual([
      '2 m/s: r 1.5 m, lean -7°',
      '5 m/s: r 2.1 m, lean -16°',
      '11.5 m/s: r 11.0 m, lean -16°',
      '17.5 m/s: r 25.6 m, lean -16°',
    ]);
  });

  test('a street corner taken at a cruise fits: turning hard sheds a little speed until it does', () => {
    // A right turn into a side street, keys or stick: round in about 1.3 s and under 10 m ahead
    // and across, as two of Leuven's 8 to 12 m streets leave room for, slowing to about 8 m/s.
    // (It took 1.6 s, 9.3 m ahead and 7 across, slowing to 6.5.)
    for (const more of [
      { throttle: 1, turn: 1 },
      { turn: 1 },
      { throttle: 1, toward: -Math.PI / 2 },
    ]) {
      const r = createRider(0, 0, 0);
      r.speed = CRUISE;
      const t = ride(r, 5, more, open, (q) => q.heading < -Math.PI / 2 + 0.05);
      expect(t).toBeLessThan(1.5);
      expect(r.z).toBeLessThan(9);
      expect(-r.x).toBeLessThan(10);
      expect(r.speed).toBeGreaterThan(CORNER - 0.5);
      expect(Math.abs(r.lean)).toBeLessThanOrEqual(MAX_LEAN + 1e-6);
    }
    // Without easing off, the tightest turn at a cruise is 11 m round: past the corner.
    expect((CRUISE * CRUISE) / 12).toBeGreaterThan(10.5);
    // A gentle bend keeps the pace.
    const bend = createRider(0, 0, 0);
    bend.speed = CRUISE;
    ride(bend, 1, { throttle: 1, toward: -0.3 });
    expect(bend.speed).toBeGreaterThan(CRUISE - 0.1);
  });

  test('the bars ease round rather than snapping, quickly, and lean lags the turn', () => {
    const r = createRider(0, 0, 0);
    r.speed = CRUISE;
    stepRider(r, STEP, input({ throttle: 1, turn: -1 }), open);
    expect(r.steer).toBeGreaterThan(0);
    expect(r.steer).toBeLessThan(maxSteer(CRUISE) / 4);
    expect(Math.abs(r.lean)).toBeLessThan(0.01);
    // Full lock (95%) in about 0.13 s, where it took 0.21.
    const t = ride(
      r,
      1,
      { throttle: 1, turn: -1 },
      open,
      (q) => q.steer > 0.95 * maxSteer(q.speed),
    );
    expect(t).toBeGreaterThan(0.08);
    expect(t).toBeLessThan(0.15);
  });

  test('below a crawl it walks the bike round on the spot', () => {
    const r = createRider(0, 0, 0);
    ride(r, 0.5, { turn: 1 });
    expect(r.speed).toBe(0);
    expect(r.heading).toBeCloseTo(-1.1, 1);
    expect(Math.hypot(r.x, r.z)).toBeLessThan(1e-9);
  });

  test('steers toward a heading, and a heading far behind brakes it first', () => {
    const r = createRider(0, 0, 0);
    r.speed = CRUISE;
    const t = ride(r, 5, { throttle: 1, toward: Math.PI / 2 }, open, (q) => {
      return Math.abs(q.heading - Math.PI / 2) < 0.09;
    });
    expect(t).toBeLessThan(2);
    const back = createRider(0, 0, 0);
    back.speed = CRUISE;
    ride(back, 0.5, { throttle: 1, toward: Math.PI });
    expect(back.speed).toBeLessThan(CRUISE - 2);
    ride(back, 4, { throttle: 1, toward: Math.PI });
    expect(Math.abs(back.heading)).toBeGreaterThan(Math.PI - 0.2);
    expect(back.speed).toBeGreaterThan(1);
  });
});

describe('walls', () => {
  test('glancing a wall, it keeps the cosine share of its speed and turns along it', () => {
    // A wall along z at x = 2, ridden into at 30°.
    const wall = planes([2, 0, -1, 0]);
    const r = createRider(0, 0, Math.PI / 6);
    r.speed = CRUISE;
    let peak = 0;
    for (let i = 0; i < 2 / STEP; i++) {
      stepRider(r, STEP, input({ throttle: 1 }), wall);
      peak = Math.max(peak, r.x);
    }
    expect(peak).toBeLessThan(2 - 0.45);
    expect(Math.abs(r.heading)).toBeLessThan(0.05);
    expect(r.speed).toBeGreaterThan(CRUISE * Math.cos(Math.PI / 6) - 0.5);
    expect(r.z).toBeGreaterThan(10);
  });

  test('head on, it stops with a little bounce back and a thud', () => {
    const wall = planes([0, 5, 0, -1]);
    const r = createRider(0, 0, 0);
    r.speed = CRUISE;
    ride(r, 1, {}, wall, (q) => q.bump > 0);
    expect(r.bump).toBeGreaterThan(CRUISE - 1);
    expect(r.speed).toBeLessThan(0);
    expect(r.speed).toBeGreaterThan(-1);
    expect(r.z).toBeLessThan(5 - 0.5);
  });

  test('is never stuck: from a corner or nose to a wall, pedalling and turning gets it out', () => {
    const corner = planes([3, 0, -1, 0], [0, 3, 0, -1]);
    for (let k = 0; k < 16; k++) {
      const heading = (k / 16) * Math.PI * 2;
      for (const turn of [-1, 1]) {
        const r = createRider(2.3, 2.3, heading);
        ride(r, 6, { throttle: 1, turn }, corner);
        // Out and away from the corner, riding round in the open.
        expect(Math.hypot(r.x - 3, r.z - 3)).toBeGreaterThan(1.5);
        expect(r.x).toBeLessThan(3 - 0.45);
        expect(r.z).toBeLessThan(3 - 0.45);
      }
    }
  });

  test('scraping along a wall it steers into, it keeps going rather than grinding to a halt', () => {
    const wall = planes([2, 0, -1, 0]);
    const r = createRider(1.4, 0, 0);
    r.speed = CRUISE;
    // The rider holds the bars a little into the wall the whole way.
    ride(r, 3, { throttle: 1, toward: 0.3 }, wall);
    expect(r.speed).toBeGreaterThan(CRUISE * 0.8);
    expect(r.z).toBeGreaterThan(18);
    expect(r.x).toBeLessThan(2 - 0.45);
  });

  test('taken out of a rack it stood in, it rides out of the rack’s footprint', () => {
    // A rack across the bike's middle: inside its ring, the way out is the nearer long side.
    const rack: Ground = {
      wallOverlap(x, z, radius, out) {
        if (Math.abs(x) > 1.5 + radius || Math.abs(z) > 0.3 + radius) return 0;
        [out[0], out[1]] = [0, z < 0 ? -1 : 1];
        return radius + 0.3 - Math.abs(z);
      },
      closed: () => 0,
    };
    const r = createRider(0, 0.05, 0);
    ride(r, 3, { throttle: 1 }, rack);
    expect(r.z).toBeGreaterThan(5);
  });

  test('held back by the edge of the water, it stops rather than pushing on', () => {
    const water: Ground = { wallOverlap: () => 0, closed: (_x, z) => (z > 4 ? 1 : 0) };
    const r = createRider(0, 0, 0);
    r.speed = 5;
    ride(r, 3, { throttle: 1 }, water);
    expect(r.z).toBeLessThan(4);
    expect(r.speed).toBeLessThan(1);
  });
});

describe('the drive', () => {
  test('pedalling, the crank turns in time with the wheel, at the gear', () => {
    const r = createRider(0, 0, 0);
    r.speed = 6;
    let [wheel, crank] = [0, 0];
    const i = input({ throttle: 1 });
    for (let n = 0; n < 240; n++) {
      const [w0, c0] = [r.wheel, r.crank];
      stepRider(r, STEP, i, open);
      [wheel, crank] = [wheel + wrap(r.wheel - w0), crank + wrap(r.crank - c0)];
    }
    // The crank falls as the wheel rolls on: the bottom pedal goes back (rider-pose.ts).
    expect(crank).toBeCloseTo(-wheel * GEAR, 6);
    // At a cruise, about 75 turns of the crank a minute.
    const cadence = ((CRUISE / (0.34 * 1.3)) * GEAR * 60) / (Math.PI * 2);
    expect(cadence).toBeGreaterThan(70);
    expect(cadence).toBeLessThan(80);
  });

  test('coasting, it freewheels with the pedals coming level', () => {
    const r = createRider(0, 0, 0);
    r.speed = CRUISE;
    r.crank = 0.3;
    ride(r, 1);
    expect(r.crank).toBeCloseTo(level(0.3), 1);
    expect(Math.cos(r.crank)).toBeCloseTo(0, 1);
    expect(level(4)).toBeCloseTo((3 * Math.PI) / 2);
  });

  test('stopped, a foot goes down and the bike leans onto it; riding, it comes up', () => {
    const r = createRider(0, 0, 0);
    expect(r.foot).toBe(1);
    ride(r, 1, { throttle: 1 });
    expect(r.foot).toBeLessThan(0.01);
    ride(r, 5, { throttle: -1 }, open, (q) => q.speed <= 0);
    ride(r, 1);
    expect(r.foot).toBeGreaterThan(0.99);
    expect(r.lean).toBeGreaterThan(0.1);
  });

  test('settles: a bike left alone stops asking for frames', () => {
    const r = createRider(0, 0, 0);
    r.speed = 1;
    const i = input();
    let moving = true;
    for (let n = 0; n < 1200 && moving; n++) moving = stepRider(r, STEP, i, open);
    expect(moving).toBe(false);
  });

  test('a step costs a few microseconds and allocates nothing worth measuring', () => {
    const r = createRider(0, 0, 0);
    const i = input({ throttle: 1, turn: 0.4, sprint: true });
    const wall = planes([20, 0, -1, 0]);
    const start = performance.now();
    for (let n = 0; n < 20_000; n++) stepRider(r, STEP, i, wall);
    expect(((performance.now() - start) * 1000) / 20_000).toBeLessThan(10);
  });
});

function along(path: Path, r: Rider, seconds: number, each?: (r: Rider) => void): void {
  const i = createInput();
  for (let n = 0; n < seconds / STEP && path.route; n++) {
    Object.assign(i, createInput());
    routeInput(r, path, i);
    stepRider(r, STEP, i, open);
    each?.(r);
  }
}

describe('routes', () => {
  const route = Float32Array.of(0, 0, 0, 40, 30, 40);
  test('rides a route, slowing for its corner and stopping at its end', () => {
    const r = createRider(0, 0, 0);
    const path: Path = { route, next: 1, travelled: 0 };
    let fastest = 0;
    let atCorner = Infinity;
    along(path, r, 30, (q) => {
      fastest = Math.max(fastest, q.speed);
      if (Math.hypot(q.x, q.z - 40) < 3) atCorner = Math.min(atCorner, q.speed);
    });
    expect(path.route).toBeNull();
    expect(fastest).toBeGreaterThan(CRUISE - 0.5);
    expect(atCorner).toBeLessThan(6.5);
    expect(Math.hypot(r.x - 30, r.z - 40)).toBeLessThan(1.5);
    expect(path.travelled).toBeGreaterThan(65);
    ride(r, 3);
    expect(r.speed).toBe(0);
  });

  test('turns round for a route that starts behind it', () => {
    const r = createRider(0, 1, Math.PI);
    r.speed = 4;
    const path: Path = { route, next: 1, travelled: 0 };
    along(path, r, 30);
    expect(path.route).toBeNull();
    expect(Math.hypot(r.x - 30, r.z - 40)).toBeLessThan(1.5);
  });

  test('a ridden route leaves the input alone', () => {
    const r = createRider(0, 0, 0);
    const i = createInput();
    routeInput(r, { route: null, next: 0, travelled: 0 }, i);
    expect(i).toEqual(createInput());
    expect(WHEELBASE).toBeCloseTo(1.43);
  });
});
