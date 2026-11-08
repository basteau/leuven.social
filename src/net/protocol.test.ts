import { describe, expect, test } from 'bun:test';

import {
  MAX_PLACE_BYTES,
  decodeClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  encodeServerMessage,
  isOutfit,
  moved,
  quantise,
} from './protocol.ts';
import type {
  MoveBaseline,
  MoveDelta,
  MoveEntry,
  Outfit,
  PlayerState,
  ServerMessage,
} from './protocol.ts';

const state: PlayerState = {
  x: 12.5,
  z: -340.25,
  heading: 1.25,
  speed: 4.2,
  mode: 'bike',
  place: 'sint-pieterskerk',
  floor: 1,
};
const outfit: Outfit = { skin: 0xf0c49c, hair: 0x7a4a2c, shirt: 0xfa8064, shorts: 0xe9dcbf };

function expectNear(got: PlayerState, want: PlayerState): void {
  expect(got.x).toBeCloseTo(want.x, 3);
  expect(got.z).toBeCloseTo(want.z, 3);
  expect(got.heading).toBeCloseTo(want.heading, 3);
  expect(got.speed).toBeCloseTo(want.speed, 5);
  expect({ mode: got.mode, place: got.place, floor: got.floor }).toEqual({
    mode: want.mode,
    place: want.place,
    floor: want.floor,
  });
}

const near = (a: number, b: number, within: number) => expect(Math.abs(a - b)).toBeLessThan(within);
/** A `moves` entry that says the whole move. */
const whole = (entry: MoveEntry | undefined) => {
  if (!entry || 'delta' in entry) throw new Error('not a whole move');
  return entry.state;
};
const fresh = (): MoveBaseline => ({ x: Number.NaN, z: Number.NaN, heading: 0, speed: 0 });
const leaving = (id: number) => encodeServerMessage({ type: 'leaves', ids: [id] });
const movedAs = (m: object) =>
  decodeServerMessage(
    encodeServerMessage({
      type: 'moves',
      cx: 0,
      cz: 0,
      players: [{ id: 1, state: { heading: 0, speed: 99, mode: 'foot', ...m } as never }],
    }),
  );

describe('client messages', () => {
  test('a state round-trips within its quantisation', () => {
    const bytes = encodeClientMessage({ type: 'state', state });
    expect(bytes.length).toBe(1 + 13 + 1 + state.place.length);
    const message = decodeClientMessage(bytes);
    if (message?.type !== 'state') throw new Error('no state');
    expectNear(message.state, state);
  });

  test('headings wrap into one turn and speeds clamp to the wire range', () => {
    const q = quantise({ ...state, heading: -Math.PI / 2, speed: 99, floor: 2.6 });
    expect(q.heading).toBeCloseTo((3 * Math.PI) / 2, 3);
    expect(q.speed).toBe(25.5);
    expect(q.floor).toBe(3);
    expect(quantise({ ...state, heading: Number.NaN, speed: -1 })).toMatchObject({
      heading: 0,
      speed: 0,
    });
    expect(quantise({ ...state, heading: Math.PI * 2 - 1e-7 }).heading).toBe(0);
  });

  test('a street state has an empty place', () => {
    expect(quantise({ ...state, place: '', mode: 'foot' })).toMatchObject({
      place: '',
      mode: 'foot',
    });
  });

  test('a place too long for the format is refused when encoding', () => {
    expect(() =>
      encodeClientMessage({ type: 'state', state: { ...state, place: 'x'.repeat(65) } }),
    ).toThrow(RangeError);
  });

  test('quantise refuses a state the format cannot carry', () => {
    expect(() => quantise({ ...state, x: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});

describe('server messages', () => {
  const messages: ServerMessage[] = [
    { type: 'welcome', you: 0 },
    { type: 'welcome', you: 0xffff_ffff },
    { type: 'joins', players: [] },
    { type: 'joins', players: [{ id: 7, name: 'Marie-Thérèse', outfit, state }] },
    { type: 'leaves', ids: [] },
    { type: 'leaves', ids: [300, 1] },
    { type: 'outfit', id: 9, outfit },
    { type: 'online', count: 1234 },
    { type: 'dots', players: [] },
  ];

  test.each(messages.map((m) => [m.type, m] as const))('%s round-trips', (_, message) => {
    const back = decodeServerMessage(encodeServerMessage(message));
    expect(back?.type).toBe(message.type);
    if (back?.type === 'joins' && message.type === 'joins') {
      const strip = (p: (typeof back.players)[number]) => ({ ...p, state: undefined });
      expect(back.players.map(strip)).toEqual(message.players.map(strip));
      back.players.forEach((p, i) => expectNear(p.state, message.players[i]!.state));
    } else {
      expect(back).toEqual(message);
    }
  });

  test('a move is 9 bytes, to under 2 cm, across the cells round its frame', () => {
    const move = { x: 400.123, z: -100.456, heading: 1.25, speed: 4.2, mode: 'bike' } as const;
    const bytes = encodeServerMessage({
      type: 'moves',
      cx: 1,
      cz: -1,
      players: [{ id: 300, state: move }],
    });
    // Tag, the cell, a count of one: 6 bytes; a two-byte id and its seven.
    expect(bytes.length).toBe(6 + 9);
    const back = decodeServerMessage(bytes);
    if (back?.type !== 'moves') throw new Error('no moves');
    expect([back.cx, back.cz]).toEqual([1, -1]);
    expect(back.players[0]?.id).toBe(300);
    const got = whole(back.players[0]);
    near(got.x, move.x, 0.02);
    near(got.z, move.z, 0.02);
    near(got.heading, move.heading, 0.001);
    near(got.speed, move.speed, 0.11);
    expect(got.mode).toBe('bike');
  });

  test('a move keeps its mode and clamps to its frame', () => {
    const clamped = movedAs({ x: 1e6, z: -1e6 });
    if (clamped?.type !== 'moves') throw new Error('no moves');
    const move = whole(clamped.players[0]);
    expect(Math.abs(move.x - 700)).toBeLessThan(0.02);
    expect(Math.abs(move.z + 350)).toBeLessThan(0.02);
    expect(move.mode).toBe('foot');
    expect(move.speed).toBeCloseTo(25.4);
  });

  describe('deltas', () => {
    const start = { x: 100, z: 200, heading: 1, speed: 4, mode: 'foot' } as const;
    const send = (move: object, base: MoveBaseline) =>
      encodeServerMessage({
        type: 'moves',
        cx: 0,
        cz: 0,
        players: [{ id: 300, state: move as typeof start }],
        bases: [base],
      });

    test('the first move goes whole, the next a delta of 5 bytes', () => {
      const base = fresh();
      expect(send(start, base).length).toBe(6 + 9);
      const next = send({ ...start, x: 100.5, z: 200.25 }, base);
      expect(next.length).toBe(6 + 5);
      const back = decodeServerMessage(next);
      if (back?.type !== 'moves') throw new Error('no moves');
      const entry = back.players[0]!;
      if (!('delta' in entry)) throw new Error('no delta');
      expect(entry.id).toBe(300);
      expect(Math.abs(entry.delta.dx - 0.5)).toBeLessThan(0.02);
      expect(Math.abs(entry.delta.dz - 0.25)).toBeLessThan(0.02);
      expect(entry.delta.heading).toBeUndefined();
      expect(entry.delta.speed).toBeUndefined();
    });

    test('a new heading and pace travel along, and only when they change', () => {
      const base = fresh();
      send(start, base);
      const bytes = send({ ...start, x: 100.1, heading: 1.5, speed: 9, mode: 'bike' }, base);
      expect(bytes.length).toBe(6 + 5 + 2 + 1);
      const back = decodeServerMessage(bytes);
      if (back?.type !== 'moves') throw new Error('no moves');
      const delta = (back.players[0] as { delta: MoveDelta }).delta;
      near(delta.heading!, 1.5, 0.001);
      near(delta.speed!, 9, 0.11);
      expect(delta.mode).toBe('bike');
      expect(moved(start, delta)).toMatchObject({ mode: 'bike' });
    });

    test('a step too long for a delta goes whole, and the deltas go on from it', () => {
      const base = fresh();
      send(start, base);
      expect(send({ ...start, x: 110 }, base).length).toBe(6 + 9);
      expect(send({ ...start, x: 110.5 }, base).length).toBe(6 + 5);
    });

    test('many deltas add up to where the figure is, to within a step', () => {
      const base = fresh();
      let x = 100;
      let at = whole(
        (decodeServerMessage(send(start, base)) as { players: MoveEntry[] }).players[0],
      ).x;
      for (let i = 0; i < 500; i++) {
        x += 0.5 + Math.sin(i) * 0.3;
        const back = decodeServerMessage(send({ ...start, x }, base)) as { players: MoveEntry[] };
        at = moved({ ...start, x: at }, (back.players[0] as { delta: MoveDelta }).delta).x;
      }
      near(at, x, 0.02);
    });

    test('a delta can’t be asked for, and a frame with bits no entry has is refused', () => {
      expect(() =>
        encodeServerMessage({
          type: 'moves',
          cx: 0,
          cz: 0,
          players: [{ id: 1, delta: { dx: 0, dz: 0 } }],
        }),
      ).toThrow(RangeError);
      expect(decodeServerMessage(new Uint8Array([17, 0, 0, 0, 0, 1, 3, 0, 0, 0xff]))).toBeNull();
    });
  });

  test('a door keeps the whole state', () => {
    const back = decodeServerMessage(encodeServerMessage({ type: 'placed', id: 5, state }));
    if (back?.type !== 'placed') throw new Error('no placed');
    expect(back.id).toBe(5);
    expectNear(back.state, state);
  });

  test('dots land within half a metre, with their colours', () => {
    const back = decodeServerMessage(
      encodeServerMessage({
        type: 'dots',
        players: [{ id: 3, x: -1234.5, z: 1999, colour: 0xfa8064 }],
      }),
    );
    if (back?.type !== 'dots') throw new Error('no dots');
    expect(back.players[0]).toMatchObject({ id: 3, colour: 0xfa8064 });
    near(back.players[0]!.x, -1234.5, 0.5);
    near(back.players[0]!.z, 1999, 0.5);
  });

  test('ids outside u32 and overlong names are refused when encoding', () => {
    expect(() => leaving(-1)).toThrow(RangeError);
    expect(() => leaving(2 ** 32)).toThrow(RangeError);
    expect(() => leaving(1.5)).toThrow(RangeError);
    expect(() =>
      encodeServerMessage({
        type: 'joins',
        players: [{ id: 1, name: 'n'.repeat(65), outfit, state }],
      }),
    ).toThrow(RangeError);
  });
});

describe('what the client says about its view', () => {
  test('where the map looks and whether the full map is open', () => {
    expect(decodeClientMessage(encodeClientMessage({ type: 'view', x: 12.5, z: -3.25 }))).toEqual({
      type: 'view',
      x: 12.5,
      z: -3.25,
    });
    for (const on of [true, false]) {
      expect(decodeClientMessage(encodeClientMessage({ type: 'dots', on }))).toEqual({
        type: 'dots',
        on,
      });
    }
  });

  test('a view off the number line is refused', () => {
    const frame = encodeClientMessage({ type: 'view', x: 0, z: 0 });
    frame.set([0x7f, 0xc0, 0, 0], 1);
    expect(decodeClientMessage(frame)).toBeNull();
  });
});

describe('malformed frames decode to null', () => {
  const good = encodeServerMessage({
    type: 'joins',
    players: [{ id: 7, name: 'Bram', outfit, state }],
  });

  test('empty, unknown tags and the wrong direction', () => {
    expect(decodeServerMessage(new Uint8Array())).toBeNull();
    expect(decodeClientMessage(new Uint8Array())).toBeNull();
    expect(decodeServerMessage(new Uint8Array([99]))).toBeNull();
    expect(decodeClientMessage(good)).toBeNull();
    expect(decodeServerMessage(encodeClientMessage({ type: 'state', state }))).toBeNull();
  });

  test('every truncation of a valid frame', () => {
    for (let n = 0; n < good.length; n++)
      expect(decodeServerMessage(good.subarray(0, n))).toBeNull();
  });

  test('trailing bytes', () => {
    const longer = new Uint8Array(good.length + 1);
    longer.set(good);
    expect(decodeServerMessage(longer)).toBeNull();
  });

  test('a mode, a position, a speed or a string out of range', () => {
    const frame = encodeClientMessage({ type: 'state', state });
    const patch = (offset: number, ...bytes: number[]) => {
      const copy = frame.slice();
      copy.set(bytes, offset);
      return decodeClientMessage(copy);
    };
    expect(patch(12, 2)).toBeNull(); // mode
    expect(patch(1, 0x7f, 0xc0, 0, 0)).toBeNull(); // x = NaN
    expect(patch(5, 0x7f, 0x80, 0, 0)).toBeNull(); // z = Infinity
    expect(patch(11, 255)).toMatchObject({ state: { speed: 25.5 } }); // the most a byte holds
    expect(patch(15, 0xff)).toBeNull(); // invalid UTF-8 in the place
    expect(patch(14, MAX_PLACE_BYTES + 1)).toBeNull(); // the place's length
  });

  test('a lying player count and an overlong id', () => {
    expect(decodeServerMessage(new Uint8Array([15, 50, 1]))).toBeNull(); // joins
    expect(decodeServerMessage(new Uint8Array([16, 50, 1]))).toBeNull(); // leaves
    expect(decodeServerMessage(new Uint8Array([17, 0, 0, 0, 0, 50, 1]))).toBeNull(); // moves
    expect(decodeServerMessage(new Uint8Array([20, 50, 1]))).toBeNull(); // dots
    const longId = [14, 0x80, 0x80, 0x80, 0x80, 0x10, ...Array(12).fill(0)];
    expect(decodeServerMessage(new Uint8Array(longId))).toBeNull();
    expect(decodeServerMessage(new Uint8Array([14, ...Array(11).fill(0x80)]))).toBeNull();
  });

  test('random bytes never throw', () => {
    let seed = 1;
    const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 256;
    for (let i = 0; i < 2000; i++) {
      const bytes = Uint8Array.from({ length: 1 + (i % 40) }, random);
      expect(() => decodeServerMessage(bytes)).not.toThrow();
      expect(() => decodeClientMessage(bytes)).not.toThrow();
    }
  });
});

describe('isOutfit', () => {
  test('four 24-bit colours and nothing else', () => {
    expect(isOutfit(outfit)).toBe(true);
    expect(isOutfit({ ...outfit, hat: 1 })).toBe(false);
    expect(isOutfit({ ...outfit, skin: 0x1000000 })).toBe(false);
    expect(isOutfit({ ...outfit, hair: -1 })).toBe(false);
    expect(isOutfit({ ...outfit, shirt: 1.5 })).toBe(false);
    expect(isOutfit({ ...outfit, shorts: '#fff' })).toBe(false);
    expect(isOutfit(null)).toBe(false);
    expect(isOutfit('outfit')).toBe(false);
  });
});
