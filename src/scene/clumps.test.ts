import { describe, expect, test } from 'bun:test';

import { createPeople } from '../net/people.ts';
import type { Marks } from './clumps.ts';
import { createClumper } from './clumps.ts';

/** Fades in, so `fade` is 1 at the end of `fill` and alpha shows only what's asked of it. */
function fill(people: ReturnType<typeof createPeople>, at = 0): void {
  people.sample(at + 1000);
  people.sample(at + 2000);
}

/** A person known coarsely. */
function add(
  people: ReturnType<typeof createPeople>,
  id: number,
  x: number,
  z: number,
  colour = 0x112233,
  weight = 1,
): void {
  people.coarse(0, id, x, z, colour, weight);
}

const options = (extra: object = {}) => ({
  pxPerMetre: 1,
  x0: -500,
  z0: -500,
  x1: 500,
  z1: 500,
  place: '',
  floor: 0,
  ...extra,
});

const total = (marks: Marks) => {
  let sum = 0;
  for (let i = 0; i < marks.count; i++) sum += marks.n[i]!;
  return sum;
};

/** At 1 px/m a cell is 20 m (20 px), so anyone here is in the cell from 0 to 20. */
const inCell = (i: number) => 2 + i;

describe('clumping', () => {
  test('four in a cell are one clump, counted and at their centroid', () => {
    const people = createPeople();
    for (let i = 0; i < 4; i++) add(people, i + 1, inCell(i), 10);
    fill(people);
    const clumper = createClumper(() => 0);
    const marks = clumper.clump(people, options());
    expect(marks.count).toBe(1);
    expect(marks.n[0]).toBe(4);
    expect(marks.x[0]).toBeCloseTo(3.5, 3);
    expect(marks.z[0]).toBeCloseTo(10, 3);
    expect(marks.radius[0]).toBeCloseTo(3.5 * 1.7, 2);
  });

  test('three are dots each, not a clump', () => {
    const people = createPeople();
    for (let i = 0; i < 3; i++) add(people, i + 1, inCell(i), 10);
    fill(people);
    const marks = createClumper(() => 0).clump(people, options());
    expect(marks.count).toBe(3);
    expect(marks.radius[0]).toBeCloseTo(3.5, 3);
    expect(total(marks)).toBe(3);
  });

  test('a crowd thinned by weight counts everyone it stands for', () => {
    const people = createPeople();
    add(people, 1, 5, 5, 0xff0000, 16);
    add(people, 2, 6, 5, 0xff0000, 16);
    add(people, 3, 7, 5, 0xff0000, 16);
    fill(people);
    const marks = createClumper(() => 0).clump(people, options());
    expect(marks.count).toBe(1);
    expect(marks.n[0]).toBe(48);
    expect(marks.radius[0]).toBeCloseTo(Math.min(22, 3.5 * (1 + 0.35 * Math.log2(48))), 2);
  });

  test('one person standing for several is already a crowd', () => {
    const people = createPeople();
    add(people, 1, 5, 5, 0xff0000, 8);
    fill(people);
    const marks = createClumper(() => 0).clump(people, options());
    expect(marks.count).toBe(1);
    expect(marks.n[0]).toBe(8);
    expect(marks.radius[0]).toBeGreaterThan(3.5);
  });

  test('the centroid weighs people by how many they stand for', () => {
    const people = createPeople();
    add(people, 1, 2, 5, 0xff0000, 3);
    add(people, 2, 18, 5, 0xff0000, 1);
    fill(people);
    const marks = createClumper(() => 0).clump(people, options());
    expect(marks.n[0]).toBe(4);
    expect(marks.x[0]).toBeCloseTo((2 * 3 + 18) / 4, 3);
  });

  test('a big crowd stops growing at the largest disc', () => {
    const people = createPeople();
    add(people, 1, 5, 5, 0xff0000, 1024);
    fill(people);
    const marks = createClumper(() => 0).clump(people, options());
    expect(marks.radius[0]).toBeCloseTo(3.5 * (1 + 0.35 * 10), 3);
    const twice = createPeople();
    add(twice, 1, 5, 5, 0xff0000, 65535);
    add(twice, 2, 6, 5, 0xff0000, 65535);
    add(twice, 3, 7, 5, 0xff0000, 65535);
    fill(twice);
    expect(createClumper(() => 0).clump(twice, options()).radius[0]).toBe(22);
  });

  test('a small drawing can ask for a smaller largest', () => {
    const people = createPeople();
    add(people, 1, 5, 5, 0xff0000, 1024);
    fill(people);
    const marks = createClumper(() => 0).clump(people, options({ largest: 9 }));
    expect(marks.radius[0]).toBe(9);
  });

  test('its colour is its lowest id and only that one leaving changes it', () => {
    const people = createPeople();
    add(people, 20, 2, 5, 0x00ff00);
    add(people, 5, 3, 5, 0xabcdef);
    add(people, 30, 4, 5, 0x0000ff);
    add(people, 9, 5, 5, 0x123456);
    add(people, 40, 6, 5, 0xeeeeee);
    fill(people);
    let now = 0;
    const clumper = createClumper(() => now);
    expect(clumper.clump(people, options()).colour[0]).toBe(0xabcdef);

    // Others come and go and it stays.
    now += 1000;
    people.leave(now, 30);
    people.coarse(now, 77, 6, 5, 0x777777, 1);
    people.sample(now + 1000);
    people.sample(now + 2000);
    expect(people.slotOf(30)).toBe(-1);
    expect(clumper.clump(people, options()).colour[0]).toBe(0xabcdef);

    // Its lowest leaves: the next lowest takes over.
    now += 1000;
    people.leave(now, 5);
    people.sample(now + 1000);
    people.sample(now + 2000);
    expect(clumper.clump(people, options()).colour[0]).toBe(0x123456);
  });

  test('someone off the ground being drawn is left out', () => {
    const people = createPeople();
    add(people, 1, 5, 5);
    add(people, 2, 600, 5);
    add(people, 3, 5, -600);
    fill(people);
    const marks = createClumper(() => 0).clump(people, options());
    expect(total(marks)).toBe(1);
    expect(marks.x[0]).toBeCloseTo(5, 3);
  });

  test('the edges of the ground are inside it', () => {
    const people = createPeople();
    add(people, 1, -10, -10);
    add(people, 2, 10, 10);
    fill(people);
    const marks = createClumper(() => 0).clump(
      people,
      options({ x0: -10, z0: -10, x1: 10, z1: 10 }),
    );
    expect(total(marks)).toBe(2);
  });

  test('those indoors show only on a drawing of their room and floor', () => {
    const people = createPeople();
    people.join(
      0,
      1,
      'in',
      { shirt: 1 } as never,
      {
        x: 5,
        z: 5,
        heading: 0,
        speed: 0,
        mode: 'walk',
        place: 'hall',
        floor: 1,
      } as never,
    );
    add(people, 2, 8, 5);
    fill(people);
    const clumper = createClumper(() => 0);
    expect(total(clumper.clump(people, options()))).toBe(1);
    expect(total(clumper.clump(people, options({ place: 'hall', floor: 0 })))).toBe(1);
    expect(total(clumper.clump(people, options({ place: 'hall', floor: 1 })))).toBe(2);
  });

  test('the alpha per slot multiplies, and 0 leaves someone out', () => {
    const people = createPeople();
    add(people, 1, 5, 5);
    add(people, 2, 30, 5);
    fill(people);
    const alpha = new Float32Array(people.count);
    alpha[people.slotOf(1)] = 0.5;
    const marks = createClumper(() => 0).clump(people, options({ alpha }));
    expect(marks.count).toBe(1);
    expect(marks.alpha[0]).toBeCloseTo(0.5, 3);
    expect(marks.x[0]).toBeCloseTo(5, 3);
  });

  test('a clump is its members mean alpha, and someone just come is faint', () => {
    const people = createPeople();
    for (let i = 0; i < 4; i++) add(people, i + 1, inCell(i), 10);
    fill(people);
    const alpha = new Float32Array(people.count).fill(1);
    alpha[0] = alpha[1] = 0.5;
    const marks = createClumper(() => 0).clump(people, options({ alpha }));
    expect(marks.alpha[0]).toBeCloseTo(0.75, 3);
  });

  test('clumps are drawn before dots, so a dot stays on top of a crowd beside it', () => {
    const people = createPeople();
    add(people, 1, 25, 5); // alone first, in the next cell
    for (let i = 0; i < 4; i++) add(people, i + 2, inCell(i), 5);
    fill(people);
    const marks = createClumper(() => 0).clump(people, options());
    expect(marks.count).toBe(2);
    expect(marks.n[0]).toBe(4);
    expect(marks.n[1]).toBe(1);
  });
});

/** Three in a cell, and a clumper whose clock the test moves. */
function three() {
  const people = createPeople();
  for (let i = 0; i < 3; i++) add(people, i + 1, inCell(i), 10);
  fill(people);
  let time = 0;
  const clumper = createClumper(() => time);
  clumper.clump(people, options());
  return {
    people,
    clumper,
    tick: (ms: number) => {
      time += ms;
      return clumper.clump(people, options());
    },
  };
}

const clumpAlpha = (marks: Marks) => {
  for (let i = 0; i < marks.count; i++) if (marks.n[i]! > 1) return marks.alpha[i]!;
  return 0;
};
const dotAlpha = (marks: Marks) => {
  for (let i = 0; i < marks.count; i++) if (marks.n[i] === 1) return marks.alpha[i]!;
  return 0;
};

describe('a clump forming and dissolving', () => {
  test('eases from dots to one disc over about 200 ms, then stops asking', () => {
    const { people, tick } = three();
    add(people, 4, inCell(4), 10);
    people.sample(3000);
    people.sample(4000);
    const started = tick(16);
    expect(clumpAlpha(started)).toBeCloseTo(0.08, 2);
    expect(dotAlpha(started)).toBeCloseTo(0.92, 2);
    expect(started.settling).toBe(true);

    const half = tick(84);
    expect(clumpAlpha(half)).toBeCloseTo(0.5, 2);
    expect(dotAlpha(half)).toBeCloseTo(0.5, 2);
    expect(half.settling).toBe(true);

    const done = tick(120);
    expect(done.count).toBe(1);
    expect(clumpAlpha(done)).toBe(1);
    expect(done.settling).toBe(false);
  });

  test('someone leaving dissolves the clump the same way', () => {
    const { people, tick } = three();
    add(people, 4, inCell(4), 10);
    people.sample(3000);
    people.sample(4000);
    tick(1000);
    people.leave(5000, 4);
    people.sample(6000);
    people.sample(7000);

    const half = tick(100);
    expect(clumpAlpha(half)).toBeCloseTo(0.5, 2);
    expect(half.n[0]).toBe(3); // the clump's count follows, while it goes
    expect(dotAlpha(half)).toBeCloseTo(0.5, 2);
    const gone = tick(100);
    expect(clumpAlpha(gone)).toBe(0);
    expect(gone.count).toBe(3);
  });

  test('a repaint at the same moment changes nothing', () => {
    const { people, tick } = three();
    add(people, 4, inCell(4), 10);
    people.sample(3000);
    people.sample(4000);
    const first = clumpAlpha(tick(50));
    expect(clumpAlpha(tick(0))).toBeCloseTo(first, 5);
  });

  test('a cell first seen as a crowd is simply there', () => {
    const people = createPeople();
    for (let i = 0; i < 6; i++) add(people, i + 1, inCell(i), 10);
    fill(people);
    let time = 100;
    const clumper = createClumper(() => time);
    clumper.clump(people, options({ x0: 900, x1: 950 }));
    time += 1;
    const marks = clumper.clump(people, options());
    expect(marks.count).toBe(1);
    expect(marks.alpha[0]).toBe(1);
    expect(marks.settling).toBe(false);
  });

  test('a clump settles on where it has moved to, instead of jumping', () => {
    const { people, tick } = three();
    add(people, 4, 3, 10);
    people.sample(3000);
    people.sample(4000);
    tick(1000);
    const before = tick(1000).x[0]!;
    // Someone at the far side of the cell joins: the centroid jumps by a pixel or two.
    add(people, 5, 19, 10);
    people.sample(5000);
    people.sample(6000);
    const after = tick(16).x[0]!;
    const target = (2 + 3 + 4 + 3 + 19) / 5;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThan(target);
    expect(tick(1000).x[0]).toBeCloseTo(target, 3);
  });
});

describe('the grid', () => {
  test('is square, 5 m times a power of two, 18 to 36 px', () => {
    // A pair 5 m apart in the same cell at any zoom this far out, and a pair across a cell line.
    for (const pxPerMetre of [0.12, 0.3, 0.5, 1, 2.4]) {
      const people = createPeople();
      for (let i = 0; i < 4; i++) add(people, i + 1, 0.5 + i / 100, 0.5);
      fill(people);
      const marks = createClumper(() => 0).clump(people, options({ pxPerMetre }));
      expect(marks.n[0]).toBe(4);
    }
    // At 3.6 px/m the 5 m cell covers exactly 18 px: the line at 5 m divides them.
    const people = createPeople();
    add(people, 1, 4.9, 1);
    add(people, 2, 4.9, 2);
    add(people, 3, 5.1, 1);
    add(people, 4, 5.1, 2);
    fill(people);
    const marks = createClumper(() => 0).clump(people, options({ pxPerMetre: 3.6 }));
    expect(marks.count).toBe(4);
  });

  test('stays put as the view pans: the same people make the same clump', () => {
    const people = createPeople();
    for (let i = 0; i < 4; i++) add(people, i + 1, inCell(i), 10);
    fill(people);
    const clumper = createClumper(() => 0);
    const here = clumper.clump(people, options());
    const [x, z] = [here.x[0]!, here.z[0]!];
    const there = clumper.clump(people, options({ x0: -200, x1: 200, z0: -220, z1: 180 }));
    expect(there.x[0]).toBeCloseTo(x, 3);
    expect(there.z[0]).toBeCloseTo(z, 3);
    expect(there.n[0]).toBe(4);
  });

  test('crossfades levels over the last fifth of an octave, shares summing to one', () => {
    // 20 m cells at 1 px/m is 20 px: 18·2^0.1 — no crossfade.
    const people = createPeople();
    for (let i = 0; i < 4; i++) add(people, i + 1, 12 + i, 12);
    fill(people);
    expect(createClumper(() => 0).clump(people, options({ pxPerMetre: 1 })).alpha[0]).toBe(1);

    // Near the top of the octave: 34 px cells. Crowds of both levels, at shares of 1 in all.
    const near = createClumper(() => 0).clump(people, options({ pxPerMetre: 1.7 }));
    expect(near.count).toBe(2);
    const shares = near.alpha[0]! + near.alpha[1]!;
    expect(shares).toBeCloseTo(1, 3);
  });

  test('someone alone at both levels is one dot at full strength, not two faint ones', () => {
    const people = createPeople();
    add(people, 1, 12, 12);
    fill(people);
    const marks = createClumper(() => 0).clump(people, options({ pxPerMetre: 1.7 }));
    expect(marks.count).toBe(1);
    expect(marks.alpha[0]).toBe(1);
  });

  test('during a crossfade, a crowd on the coarse level and dots on the fine one both fade', () => {
    const people = createPeople();
    // In one coarse cell, spread over four fine cells, one each: dots on the fine level alone.
    add(people, 1, 2, 2);
    add(people, 2, 12, 2);
    add(people, 3, 2, 12);
    add(people, 4, 12, 12);
    fill(people);
    const marks = createClumper(() => 0).clump(people, options({ pxPerMetre: 1.7 }));
    expect(marks.count).toBe(5);
    expect(marks.n[0]).toBe(4);
    for (let i = 1; i < 5; i++) expect(marks.alpha[i]! + marks.alpha[0]!).toBeCloseTo(1, 3);
  });
});

function crowd(size: number) {
  const people = createPeople();
  for (let i = 0; i < size; i++) add(people, i + 1, (i * 7) % 900, (i * 13) % 900);
  fill(people);
  return people;
}

describe('the allocation', () => {
  test('the clock defaults to the page clock', () => {
    const people = crowd(4);
    expect(createClumper().clump(people, options()).count).toBeGreaterThan(0);
  });

  test('a call makes no new typed array once it has grown to the crowd', () => {
    const people = crowd(800);
    const clumper = createClumper(() => 0);
    const opts = options({ x0: -1000, z0: -1000, x1: 1000, z1: 1000, pxPerMetre: 0.5 });
    clumper.clump(people, opts);
    clumper.clump(people, opts);

    const made: string[] = [];
    const real = {
      Float32Array,
      Float64Array,
      Int32Array,
      Uint32Array,
    };
    const count = (name: keyof typeof real) =>
      new Proxy(real[name], {
        construct(target, args) {
          made.push(name);
          return Reflect.construct(target, args);
        },
      });
    const global = globalThis as unknown as Record<keyof typeof real, unknown>;
    for (const name of Object.keys(real) as (keyof typeof real)[]) global[name] = count(name);
    try {
      for (let i = 0; i < 200; i++) clumper.clump(people, opts);
    } finally {
      for (const name of Object.keys(real) as (keyof typeof real)[]) global[name] = real[name];
    }
    expect(made).toEqual([]);
  });

  test('marks and arrays keep their identity while the crowd fits', () => {
    const people = crowd(100);
    const clumper = createClumper(() => 0);
    const first = clumper.clump(people, options());
    const [x, colour] = [first.x, first.colour];
    const second = clumper.clump(people, options());
    expect(second).toBe(first);
    expect(second.x).toBe(x);
    expect(second.colour).toBe(colour);
  });

  test('a crowd far bigger than the arrays began fits, at any spread', () => {
    const people = crowd(6000);
    const clumper = createClumper(() => 0);
    const marks = clumper.clump(
      people,
      options({ pxPerMetre: 2.4, x0: -2000, z0: -2000, x1: 2000, z1: 2000 }),
    );
    expect(total(marks)).toBe(6000);
  });
});
