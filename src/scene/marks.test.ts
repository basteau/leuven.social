import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { Marks } from './clumps.ts';
import { crowdLabel, drawMarks } from './marks.ts';

const made: { width: number; fill: string; stroke: string; radius: number }[] = [];

beforeAll(() => {
  (globalThis as { document?: unknown }).document = {
    createElement: () => {
      const canvas = {
        width: 0,
        height: 0,
        record: { width: 0, fill: '', stroke: '', radius: 0 },
        getContext: () => ({
          scale: () => {},
          beginPath: () => {},
          arc: (_x: number, _y: number, r: number) => {
            canvas.record.radius = r;
          },
          fill() {
            canvas.record.fill = String(this.fillStyle);
          },
          stroke() {
            canvas.record.stroke = String(this.strokeStyle);
          },
          fillStyle: '',
          strokeStyle: '',
          lineWidth: 0,
        }),
      };
      made.push(canvas.record);
      return canvas;
    },
  };
});

afterAll(() => {
  delete (globalThis as { document?: unknown }).document;
});

function marksOf(
  list: { x?: number; z?: number; colour?: number; radius?: number; alpha?: number }[],
) {
  const marks: Marks = {
    count: list.length,
    x: Float32Array.from(list, (m) => m.x ?? 0),
    z: Float32Array.from(list, (m) => m.z ?? 0),
    n: Uint32Array.from(list, () => 1),
    colour: Int32Array.from(list, (m) => m.colour ?? 0xff0000),
    radius: Float32Array.from(list, (m) => m.radius ?? 3.5),
    alpha: Float32Array.from(list, (m) => m.alpha ?? 1),
    settling: false,
  };
  return marks;
}

function pen() {
  const stamps: { at: number[]; alpha: number; image: unknown }[] = [];
  const context = {
    globalAlpha: 1,
    drawImage: (image: unknown, ...at: number[]) =>
      stamps.push({ at, alpha: context.globalAlpha, image }),
  };
  return { context: context as unknown as CanvasRenderingContext2D, stamps };
}

const flat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** A shirt of its own, in 5-6-5, for each number: more of them than the sprites kept. */
const shirt = (i: number) => ((i & 31) << 19) | (((i >> 5) & 63) << 10) | (((i >> 11) & 31) << 3);

describe('drawMarks', () => {
  test('stamps each mark where the frame says, centred on it', () => {
    const { context, stamps } = pen();
    const frame = { a: 2, b: 0, c: 0, d: 2, e: 10, f: 20 };
    drawMarks(context, marksOf([{ x: 5, z: 7, radius: 4 }]), frame, 1);
    const [left, top, width, height] = stamps[0]!.at;
    expect(left! + width! / 2).toBeCloseTo(20, 3);
    expect(top! + height! / 2).toBeCloseTo(34, 3);
  });

  test('a turned frame turns where marks go, and lift raises them', () => {
    const { context, stamps } = pen();
    const frame = { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0, lift: (x: number) => x / 2 };
    drawMarks(context, marksOf([{ x: 4, z: 2, radius: 4 }]), frame, 1);
    const [left, top, width, height] = stamps[0]!.at;
    expect(left! + width! / 2).toBeCloseTo(-2, 3);
    expect(top! + height! / 2).toBeCloseTo(4 - 2, 3);
  });

  test('alpha is per mark and the pen gets back the alpha it came with', () => {
    const { context, stamps } = pen();
    context.globalAlpha = 0.5;
    drawMarks(context, marksOf([{ alpha: 0.5 }, { alpha: 1 }]), flat, 1);
    expect(stamps.map((s) => s.alpha)).toEqual([0.25, 0.5]);
    expect(context.globalAlpha).toBe(0.5);
  });

  test('the same shirt and size is one sprite, however many stamp it', () => {
    const { context, stamps } = pen();
    const before = made.length;
    const many = Array.from({ length: 1000 }, (_, i) => ({ x: i, colour: 0x4488cc, radius: 3.5 }));
    drawMarks(context, marksOf(many), flat, 1);
    expect(made.length - before).toBe(1);
    expect(new Set(stamps.map((s) => s.image)).size).toBe(1);
    expect(stamps).toHaveLength(1000);
  });

  test('a shirt in ink: filled in its colour, ringed thin, at the size asked', () => {
    const { context } = pen();
    const before = made.length;
    drawMarks(context, marksOf([{ colour: 0xff0000, radius: 6 }]), flat, 2);
    const sprite = made[before]!;
    expect(sprite.fill).toBe('#ff0000');
    expect(sprite.stroke).toBe('#2b2420');
    expect(sprite.radius).toBe(6);
  });

  test('sprites come in half pixels and near-identical shirts share one', () => {
    const { context } = pen();
    const before = made.length;
    drawMarks(
      context,
      marksOf([
        { colour: 0x4080c0, radius: 5.01 },
        { colour: 0x4182c1, radius: 5.04 },
        { colour: 0x4080c0, radius: 5.5 },
      ]),
      flat,
      3,
    );
    // The first two land on one sprite; a half pixel more is another.
    expect(made.length - before).toBe(2);
  });

  test('a new screen density draws its sprites afresh', () => {
    const { context } = pen();
    drawMarks(context, marksOf([{ colour: 0x0000ff, radius: 4 }]), flat, 1);
    const before = made.length;
    drawMarks(context, marksOf([{ colour: 0x0000ff, radius: 4 }]), flat, 2);
    expect(made.length - before).toBe(1);
  });

  test('a stranger mix of shirts starts the sprites over instead of growing for ever', () => {
    const { context } = pen();
    const before = made.length;
    const rainbow = Array.from({ length: 2500 }, (_, i) => ({ colour: shirt(i), radius: 4 }));
    drawMarks(context, marksOf(rainbow), flat, 1);
    expect(made.length - before).toBe(2500);
    // The first went when the cache started over, so it is drawn afresh.
    const after = made.length;
    drawMarks(context, marksOf([{ colour: shirt(0), radius: 4 }]), flat, 1);
    expect(made.length - after).toBe(1);
  });
});

describe('crowdLabel', () => {
  test('says a crowd as short as it can', () => {
    expect(crowdLabel(14)).toBe('14');
    expect(crowdLabel(999)).toBe('999');
    expect(crowdLabel(1000)).toBe('1k');
    expect(crowdLabel(1240)).toBe('1.2k');
    expect(crowdLabel(9949)).toBe('9.9k');
    expect(crowdLabel(12400)).toBe('12k');
  });
});
