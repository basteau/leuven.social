import { describe, expect, test } from 'bun:test';

import { BIKE, FINE, INDOORS, createPeople } from './people.ts';
import type { People } from './people.ts';
import type { Outfit, PlayerState } from './protocol.ts';

const OUTFIT: Outfit = { skin: 0xff0000, hair: 0x00ff00, shirt: 0x0000ff, shorts: 0x111111 };
const state = (x: number, z = 0, speed = 1.4): PlayerState => ({
  x,
  z,
  heading: 0,
  speed,
  mode: 'foot',
  place: '',
  floor: 0,
});
const stride = (x: number, z = 0, speed = 1.4) => ({
  x,
  z,
  heading: 0,
  speed,
  mode: 'foot' as const,
});

/** Runs frames at 60 Hz from `from` to `to`, and returns the x of slot 0 at each. */
function frames(people: People, from: number, to: number, each?: (now: number) => void) {
  const xs: number[] = [];
  for (let now = from; now <= to; now += 1000 / 60) {
    each?.(now);
    people.sample(now);
    xs.push(people.x[0]!);
  }
  return xs;
}

/** Someone walking along x at `pace` m/s, heard of every `every` ms from t = 0 to `until`. */
function walker(people: People, every: number, until: number, pace = 1.4, start = 0) {
  people.join(start, 1, 'A', OUTFIT, state(0, 0, pace));
  let next = start + every;
  return frames(people, start, until, (now) => {
    while (next <= now) {
      people.move(next, 1, stride(((next - start) / 1000) * pace, 0, pace));
      next += every;
    }
  });
}

const steps = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]!);

/** A coarse frame listing `list`, as [id, x, z]. */
function frame(people: People, now: number, list: [number, number, number][]) {
  people.beginCoarse();
  for (const [id, x, z] of list) people.coarse(now, id, x, z, 0x00ff00, 1);
  people.endCoarse(now);
}

describe('people', () => {
  test('someone new is there at once, fades in, and is known in full', () => {
    const people = createPeople();
    people.join(0, 7, 'Ann', OUTFIT, state(10, 20));
    people.sample(0);
    expect(people.count).toBe(1);
    expect(people.slotOf(7)).toBe(0);
    expect(people.who(0)?.name).toBe('Ann');
    expect(people.colour[0]).toBe(OUTFIT.shirt);
    expect(people.flags[0]! & FINE).toBe(FINE);
    expect([people.x[0], people.z[0]]).toEqual([10, 20]);
    expect(people.fade[0]).toBe(0);
    people.sample(110);
    expect(people.fade[0]).toBeCloseTo(0.5, 5);
    expect(people.sample(400)).toBe(true); // still in stride, for a moment
    expect(people.fade[0]).toBe(1);
  });

  test('at ten updates a second a walker goes evenly, always forwards', () => {
    const people = createPeople();
    const xs = walker(people, 100, 3000);
    const moving = steps(xs).slice(30);
    for (const step of moving) expect(step).toBeGreaterThanOrEqual(0);
    const expected = (1.4 * 1000) / 60 / 1000;
    expect(Math.max(...moving)).toBeLessThan(expected * 2);
  });

  test('at one update a second too: no leaps, never back, and it gets there', () => {
    const people = createPeople();
    const xs = walker(people, 1000, 12000);
    const moving = steps(xs).slice(30);
    for (const step of moving) expect(step).toBeGreaterThanOrEqual(0);
    const expected = (1.4 * 1000) / 60 / 1000;
    expect(Math.max(...moving)).toBeLessThan(expected * 2.5);
    expect(xs.at(-1)!).toBeGreaterThan(14);
  });

  test('going from ten updates a second to one is no leap', () => {
    const people = createPeople();
    people.join(0, 1, 'A', OUTFIT, state(0));
    let next = 100;
    const xs = frames(people, 0, 8000, (now) => {
      while (next <= now) {
        people.move(next, 1, stride((next / 1000) * 1.4));
        next += next < 3000 ? 100 : 1000;
      }
    });
    for (const step of steps(xs)) {
      expect(step).toBeGreaterThanOrEqual(0);
      expect(step).toBeLessThan(0.07);
    }
  });

  test('someone who stood still sets off without a long creep over the wait', () => {
    const people = createPeople();
    people.join(0, 1, 'A', OUTFIT, state(0, 0, 0));
    people.sample(0);
    people.sample(3000);
    people.move(3000, 1, stride(0.14));
    const xs = frames(people, 3016, 3400);
    expect(xs.at(-1)!).toBeCloseTo(0.14, 3);
  });

  test('they turn the short way round', () => {
    const people = createPeople();
    people.join(0, 1, 'A', OUTFIT, { ...state(0), heading: 3 });
    people.move(100, 1, { ...stride(0.14), heading: -3 });
    people.sample(0);
    people.sample(150);
    expect(Math.abs(people.heading[0]!)).toBeGreaterThan(3);
  });

  test('a leap too long to have been walked starts them over there', () => {
    const people = createPeople();
    people.join(0, 1, 'A', OUTFIT, state(0));
    people.sample(0);
    people.move(100, 1, stride(100));
    people.sample(116);
    expect(people.x[0]).toBe(100);
  });

  test('a door takes them there at once, and says which room', () => {
    const people = createPeople();
    people.join(0, 1, 'A', OUTFIT, state(0));
    people.sample(0);
    people.jump(50, 1, { ...state(2), place: 'town-hall', floor: 1 });
    people.sample(66);
    expect(people.x[0]).toBe(2);
    expect(people.place(0)).toBe('town-hall');
    expect(people.floor(0)).toBe(1);
    expect(people.flags[0]! & INDOORS).toBe(INDOORS);
    people.jump(100, 1, state(3));
    expect(people.flags[0]! & INDOORS).toBe(0);
    people.jump(100, 99, state(3)); // unknown
    expect(people.slotOf(99)).toBe(-1);
  });

  test('going fades them out, then frees the slot and moves the last one in', () => {
    const people = createPeople();
    people.join(0, 1, 'A', OUTFIT, state(1));
    people.join(0, 2, 'B', OUTFIT, state(2));
    people.join(0, 3, 'C', OUTFIT, state(3));
    people.sample(0);
    people.sample(500);
    const version = people.version;
    people.leave(500, 1);
    people.leave(500, 42); // unknown
    people.sample(610);
    expect(people.fade[0]).toBeCloseTo(0.5, 5);
    expect(people.count).toBe(3);
    people.sample(800);
    expect(people.count).toBe(2);
    expect(people.version).not.toBe(version);
    expect(people.slotOf(1)).toBe(-1);
    expect(people.slotOf(3)).toBe(0);
    expect(people.x[0]).toBe(3);
    expect(people.who(0)?.name).toBe('C');
    people.leave(800, 3);
    people.sample(900);
    people.sample(1100);
    expect(people.count).toBe(1);
    expect(people.who(0)?.name).toBe('B');
    people.leave(1100, 2); // the last slot
    people.sample(1200);
    people.sample(1400);
    expect(people.count).toBe(0);
    expect(people.who(0)).toBeNull();
    expect(people.place(0)).toBe('');
    expect(people.floor(0)).toBe(0);
  });

  test('an id handed on while its last holder fades is someone new', () => {
    const people = createPeople();
    people.join(0, 1, 'A', OUTFIT, state(1));
    people.sample(0);
    people.sample(400);
    people.leave(400, 1);
    people.join(410, 1, 'B', OUTFIT, state(50));
    people.sample(420);
    expect(people.who(0)?.name).toBe('B');
    expect(people.x[0]).toBe(50);
    expect(people.fade[0]).toBeLessThan(0.2);
  });

  test('a fade goes by the clock, however seldom anyone looks', () => {
    const people = createPeople();
    people.join(0, 1, 'A', OUTFIT, state(0));
    people.sample(0);
    people.sample(5000); // an idle view: nobody asked for a while
    people.join(5000, 2, 'B', OUTFIT, state(9));
    people.sample(5110);
    expect(people.fade[people.slotOf(2)]).toBeCloseTo(0.5, 5);
    people.leave(5110, 2);
    people.sample(5165);
    expect(people.fade[people.slotOf(2)]).toBeCloseTo(0.25, 5);
  });

  test('a floor below the street stays below it', () => {
    const people = createPeople();
    people.join(0, 1, 'A', OUTFIT, { ...state(0), place: 'crypt', floor: -2 });
    expect(people.floor(0)).toBe(-2);
  });

  test('new clothes and names', () => {
    const people = createPeople();
    people.join(0, 1, 'A', OUTFIT, state(1));
    const version = people.version;
    people.restyle(1, { name: 'B', outfit: { ...OUTFIT, shirt: 5 } });
    people.restyle(9, { name: 'nobody' });
    expect(people.who(0)?.name).toBe('B');
    expect(people.colour[0]).toBe(5);
    expect(people.version).not.toBe(version);
  });

  test('bikes', () => {
    const people = createPeople();
    people.join(0, 1, 'A', OUTFIT, { ...state(1), mode: 'bike' });
    expect(people.flags[0]! & BIKE).toBe(BIKE);
    people.move(100, 1, stride(1.1));
    expect(people.flags[0]! & BIKE).toBe(0);
    people.move(200, 1, { ...stride(1.2), mode: 'bike' });
    expect(people.flags[0]! & BIKE).toBe(BIKE);
    people.move(300, 77, stride(0)); // unknown
    expect(people.count).toBe(1);
  });

  describe('coarsely', () => {
    test('someone in a frame appears, and works out how they move', () => {
      const people = createPeople();
      frame(people, 0, [[5, 0, 0]]);
      people.sample(0);
      expect(people.count).toBe(1);
      expect(people.who(0)).toBeNull();
      expect(people.flags[0]! & FINE).toBe(0);
      expect(people.colour[0]).toBe(0x00ff00);
      frame(people, 1000, [[5, 4, 0]]);
      frames(people, 16, 2400);
      expect(people.x[0]).toBeCloseTo(4, 1);
      expect(people.heading[0]).toBeCloseTo(Math.PI / 2, 1);
    });

    test('a step of the grid is standing', () => {
      const people = createPeople();
      frame(people, 0, [[5, 0, 0]]);
      people.sample(0);
      frame(people, 1000, [[5, 0.3, 0]]);
      people.sample(1000);
      people.sample(1600);
      expect(people.speed[0]).toBe(0);
    });

    test('whoever is not in a frame goes', () => {
      const people = createPeople();
      frame(people, 0, [
        [5, 0, 0],
        [6, 0, 0],
      ]);
      people.sample(0);
      people.sample(300);
      frame(people, 1000, [[6, 0, 0]]);
      people.sample(1100);
      people.sample(1400);
      expect(people.count).toBe(1);
      expect(people.slotOf(6)).toBe(0);
    });

    test('someone known coarsely comes back into a frame before they have gone', () => {
      const people = createPeople();
      frame(people, 0, [[5, 0, 0]]);
      people.sample(0);
      people.sample(300);
      frame(people, 1000, []);
      people.sample(1100);
      expect(people.fade[0]).toBeLessThan(1);
      frame(people, 1110, [[5, 0, 0]]);
      people.sample(1400);
      expect(people.fade[0]).toBe(1);
    });

    test('coming in close is the same person at the same spot', () => {
      const people = createPeople();
      frame(people, 0, [[5, 10, 0]]);
      people.sample(0);
      people.sample(400);
      const count = people.count;
      expect(people.fade[0]).toBe(1);
      people.join(500, 5, 'Ann', OUTFIT, state(10.5));
      expect(people.count).toBe(count);
      expect(people.fade[0]).toBe(1);
      people.sample(516);
      expect(people.x[0]).toBeCloseTo(10, 0);
      expect(people.who(0)?.name).toBe('Ann');
      expect(people.colour[0]).toBe(OUTFIT.shirt);
    });

    test('someone fading coarsely is taken back up when heard of in full', () => {
      const people = createPeople();
      frame(people, 0, [[5, 10, 0]]);
      people.sample(0);
      people.sample(400);
      frame(people, 1000, []);
      people.sample(1050);
      people.join(1060, 5, 'Ann', OUTFIT, state(10));
      people.sample(1400);
      expect(people.fade[0]).toBe(1);
      expect(people.count).toBe(1);
    });

    test('going further off, someone stays until a frame says otherwise', () => {
      const people = createPeople();
      people.join(0, 5, 'Ann', OUTFIT, state(10));
      people.sample(0);
      people.sample(400);
      people.demote(5);
      people.demote(404); // unknown
      expect(people.flags[0]! & FINE).toBe(0);
      people.sample(900);
      expect(people.count).toBe(1);
      frame(people, 1000, [[5, 11, 0]]);
      people.sample(1500);
      expect(people.fade[0]).toBe(1);
      frame(people, 2000, []);
      people.sample(2100);
      people.sample(2400);
      expect(people.count).toBe(0);
    });

    test('a frame does not touch someone heard of in full', () => {
      const people = createPeople();
      people.join(0, 5, 'Ann', OUTFIT, state(10));
      people.sample(0);
      frame(people, 500, [[5, 300, 0]]);
      frame(people, 600, []);
      people.sample(700);
      expect(people.x[0]).toBeLessThan(20);
      expect(people.fade[0]).toBeGreaterThan(0);
      expect(people.who(0)?.name).toBe('Ann');
    });

    test('someone stands for those thinned out round them', () => {
      const people = createPeople();
      people.beginCoarse();
      people.coarse(0, 5, 0, 0, 1, 8);
      people.endCoarse(0);
      expect(people.weight[0]).toBe(8);
    });
  });

  test('a recount keeps whoever it mentions, as they are, and lets the rest go', () => {
    const people = createPeople();
    people.join(0, 1, 'A', OUTFIT, state(1));
    people.join(0, 2, 'B', OUTFIT, state(2));
    people.sample(0);
    people.sample(400);
    people.endRecount(400); // none under way
    expect(people.count).toBe(2);
    people.beginRecount();
    people.join(500, 2, 'B', OUTFIT, state(2));
    people.endRecount(500);
    expect(people.fade[people.slotOf(2)]).toBe(1);
    people.sample(600);
    people.sample(900);
    expect(people.count).toBe(1);
    expect(people.who(0)?.name).toBe('B');
  });

  test('forget clears everyone at once', () => {
    const people = createPeople();
    people.join(0, 1, 'A', OUTFIT, state(1));
    const version = people.version;
    people.forget();
    expect(people.count).toBe(0);
    expect(people.slotOf(1)).toBe(-1);
    expect(people.version).not.toBe(version);
    const same = people.version;
    people.forget();
    expect(people.version).toBe(same);
  });

  test('it grows, keeps everyone, and sampling a crowd allocates no objects', () => {
    const people = createPeople();
    for (let id = 1; id <= 1000; id++) people.join(0, id, 'P', OUTFIT, state(id));
    expect(people.count).toBe(1000);
    people.sample(0);
    expect(people.x[people.slotOf(777)]).toBe(777);
    for (let now = 100; now < 2000; now += 100) {
      for (let id = 1; id <= 1000; id++) people.move(now, id, stride(id + now / 1000));
      people.sample(now);
    }
    expect(people.x[people.slotOf(777)]!).toBeGreaterThan(777);
    expect(people.travelled[people.slotOf(777)]!).toBeGreaterThan(0);
  });

  test('a hidden tab comes back level with the others', () => {
    const people = createPeople();
    people.join(0, 1, 'A', OUTFIT, state(0));
    people.sample(0);
    for (let t = 100; t <= 60_000; t += 100) people.move(t, 1, stride((t / 1000) * 1.4));
    people.sample(60_000);
    expect(people.x[0]!).toBeGreaterThan(80);
  });

  test('nothing to do when everyone has stopped and come in', () => {
    const people = createPeople();
    people.join(0, 1, 'A', OUTFIT, state(0, 0, 0));
    people.sample(0);
    expect(people.sample(100)).toBe(true);
    people.sample(300);
    expect(people.sample(400)).toBe(false);
  });
});
