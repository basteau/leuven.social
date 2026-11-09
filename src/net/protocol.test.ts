import { describe, expect, test } from 'bun:test';

import {
  MAX_PLACE_BYTES,
  cacheJoin,
  createOutput,
  decodeClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  encodeServerMessage,
  freshenJoin,
  isOutfit,
  putCachedJoin,
  quantise,
  readCoarse,
  readTick,
  rgb565,
  rgb888,
} from './protocol.ts';
import type {
  CoarseSink,
  Move,
  MoveBaseline,
  MoveDelta,
  MoveEntry,
  Outfit,
  PlayerState,
  ServerMessage,
  TickMessage,
  TickSink,
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
/** A tick that says just this: everything else empty. */
const tickOf = (message: Partial<TickMessage>): TickMessage => ({
  type: 'tick',
  leaves: [],
  demotes: [],
  joins: [],
  cx: 0,
  cz: 0,
  near: [],
  far: [],
  ...message,
});
const leaving = (id: number) => encodeServerMessage(tickOf({ leaves: [id] }));
const movedAs = (m: object) =>
  decodeServerMessage(
    encodeServerMessage(
      tickOf({ near: [{ id: 1, state: { heading: 0, speed: 99, mode: 'foot', ...m } as never }] }),
    ),
  );
const nearOf = (bytes: Uint8Array) => (decodeServerMessage(bytes) as TickMessage).near;
/** A delta's result applied to a move, as a client would. */
const moved = (from: Move, d: MoveDelta): Move => ({
  x: from.x + d.dx,
  z: from.z + d.dz,
  heading: d.heading ?? from.heading,
  speed: d.speed ?? from.speed,
  mode: d.mode ?? from.mode,
});

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
    { type: 'identity', guest: true, unseen: false, name: 'Sunny Otter', outfit },
    { type: 'identity', guest: true, unseen: true, name: 'Sunny Otter 2', outfit },
    { type: 'identity', guest: false, unseen: false, name: 'Bram', outfit },
    { type: 'renamed', id: 12, name: 'Bram', outfit },
    { type: 'driving', on: true },
    { type: 'driving', on: false },
    { type: 'outfit', id: 9, outfit },
    { type: 'online', count: 1234 },
  ];

  test.each(messages.map((m) => [m.type, m] as const))('%s round-trips', (_, message) => {
    expect(decodeServerMessage(encodeServerMessage(message))).toEqual(message);
  });

  test('a tick carries who left, was demoted, joined, and who moved, in that order', () => {
    const frame = encodeServerMessage(
      tickOf({
        beginsRecount: true,
        endsRecount: true,
        leaves: [300, 1],
        demotes: [7],
        joins: [{ id: 8, name: 'Marie-Thérèse', outfit, state }],
        cx: 1,
        cz: -2,
        near: [{ id: 9, state: { x: 400, z: -700, heading: 2, speed: 4, mode: 'foot' } }],
        far: [
          {
            cx: -3,
            cz: 2,
            moves: [{ id: 10, state: { x: -900, z: 800, heading: 1, speed: 2, mode: 'bike' } }],
          },
        ],
      }),
    );
    const heard: string[] = [];
    const sink: TickSink = {
      beginRecount: () => heard.push('begin'),
      endRecount: () => heard.push('end'),
      left: (id) => heard.push(`left ${id}`),
      demoted: (id) => heard.push(`demoted ${id}`),
      joined: (id, name) => heard.push(`joined ${id} ${name}`),
      whole: (id) => heard.push(`whole ${id}`),
      delta: (id) => heard.push(`delta ${id}`),
    };
    expect(readTick(frame, sink)).toBe(true);
    expect(heard).toEqual([
      'begin',
      'left 300',
      'left 1',
      'demoted 7',
      'joined 8 Marie-Thérèse',
      'whole 9',
      'whole 10',
      'end',
    ]);
    const back = decodeServerMessage(frame) as TickMessage;
    expect(back).toMatchObject({ beginsRecount: true, endsRecount: true, cx: 1, cz: -2 });
    expect(back.leaves).toEqual([300, 1]);
    expect(back.demotes).toEqual([7]);
    expectNear(back.joins[0]!.state, state);
    near(whole(back.near[0]).x, 400, 0.02);
    expect(back.far[0]).toMatchObject({ cx: -3, cz: 2 });
    near(back.far[0]!.moves[0]!.state.x, -900, 0.02);
    near(back.far[0]!.moves[0]!.state.z, 800, 0.02);
    expect(back.far[0]!.moves[0]!.state.mode).toBe('bike');
  });

  test('readTick says so on a broken frame, never throws, and an empty tick is fine', () => {
    const sink: TickSink = {
      beginRecount() {},
      endRecount() {},
      left() {},
      demoted() {},
      joined() {},
      whole() {},
      delta() {},
    };
    const good = encodeServerMessage(tickOf({ leaves: [1] }));
    expect(readTick(good, sink)).toBe(true);
    expect(readTick(new Uint8Array([24, 4]), sink)).toBe(false); // flags it never has
    expect(readTick(good.subarray(0, good.length - 1), sink)).toBe(false);
    expect(readTick(new Uint8Array([99]), sink)).toBe(false);
    expect(readTick(new Uint8Array(), sink)).toBe(false);
    expect(decodeServerMessage(encodeServerMessage(tickOf({})))).toMatchObject(tickOf({}));
  });

  test('a coarse frame says every cell, thinned by id, in 256ths of a cell', () => {
    const frame = encodeServerMessage({
      type: 'coarse',
      first: true,
      last: false,
      cells: [
        {
          cx: -2,
          cz: 3,
          total: 12,
          weight: 2,
          people: [{ id: 300, x: -2 * 350 + 100.2, z: 3 * 350 + 349, colour: 0xfa8064 }],
        },
      ],
    });
    const back = decodeServerMessage(frame);
    if (back?.type !== 'coarse') throw new Error('no coarse');
    expect(back).toMatchObject({ first: true, last: false });
    expect(back.cells[0]).toMatchObject({ cx: -2, cz: 3, total: 12, weight: 2 });
    const person = back.cells[0]!.people[0]!;
    near(person.x, -2 * 350 + 100.2, 1.4);
    near(person.z, 3 * 350 + 349, 1.4);
    expect(person.colour).toBe(rgb888(rgb565(0xfa8064)));
    expect(person.id).toBe(300);

    const sinkCalls: unknown[] = [];
    const sink: CoarseSink = {
      begin: () => sinkCalls.push('begin'),
      person: (id, _x, _z, _colour, weight) => sinkCalls.push([id, weight]),
      end: () => sinkCalls.push('end'),
    };
    expect(readCoarse(frame, sink)).toBe(true);
    expect(sinkCalls).toEqual(['begin', [300, 2]]);
    const last = encodeServerMessage({ type: 'coarse', first: false, last: true, cells: [] });
    expect(readCoarse(last, sink)).toBe(true);
    expect(sinkCalls.at(-1)).toBe('end');
    expect(readCoarse(new Uint8Array([25, 4]), sink)).toBe(false);
    expect(readCoarse(frame.subarray(0, frame.length - 1), sink)).toBe(false);
  });

  test('a shirt is nearly the same after RGB565 and stays pure if it was', () => {
    expect(rgb888(rgb565(0xffffff))).toBe(0xffffff);
    expect(rgb888(rgb565(0x000000))).toBe(0x000000);
    const back = rgb888(rgb565(0xfa8064));
    expect(Math.abs((back >> 16) - 0xfa)).toBeLessThan(8);
  });

  test('a move is 9 bytes, to under 2 cm, across the cells round its frame', () => {
    const move = { x: 400.123, z: -100.456, heading: 1.25, speed: 4.2, mode: 'bike' } as const;
    const bytes = encodeServerMessage(tickOf({ cx: 1, cz: -1, near: [{ id: 300, state: move }] }));
    // Tag, flags, empty leaves, demotes and joins, near of one with its cell, empty far: 11.
    expect(bytes.length).toBe(11 + 9);
    const back = decodeServerMessage(bytes);
    if (back?.type !== 'tick') throw new Error('no tick');
    expect([back.cx, back.cz]).toEqual([1, -1]);
    expect(back.near[0]?.id).toBe(300);
    const got = whole(back.near[0]);
    near(got.x, move.x, 0.02);
    near(got.z, move.z, 0.02);
    near(got.heading, move.heading, 0.001);
    near(got.speed, move.speed, 0.11);
    expect(got.mode).toBe('bike');
  });

  test('a move keeps its mode and clamps to its frame', () => {
    const clamped = movedAs({ x: 1e6, z: -1e6 });
    if (clamped?.type !== 'tick') throw new Error('no tick');
    const move = whole(clamped.near[0]);
    expect(Math.abs(move.x - 700)).toBeLessThan(0.02);
    expect(Math.abs(move.z + 350)).toBeLessThan(0.02);
    expect(move.mode).toBe('foot');
    expect(move.speed).toBeCloseTo(25.4);
  });

  describe('deltas', () => {
    const start = { x: 100, z: 200, heading: 1, speed: 4, mode: 'foot' } as const;
    const send = (move: object, base: MoveBaseline) =>
      encodeServerMessage(
        tickOf({ near: [{ id: 300, state: move as typeof start }], bases: [base] }),
      );
    test('the first move goes whole, the next a delta of 5 bytes', () => {
      const base = fresh();
      expect(send(start, base).length).toBe(11 + 9);
      const next = send({ ...start, x: 100.5, z: 200.25 }, base);
      expect(next.length).toBe(11 + 5);
      const entry = nearOf(next)[0]!;
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
      expect(bytes.length).toBe(11 + 5 + 2 + 1);
      const delta = (nearOf(bytes)[0] as { delta: MoveDelta }).delta;
      near(delta.heading!, 1.5, 0.001);
      near(delta.speed!, 9, 0.11);
      expect(delta.mode).toBe('bike');
      expect(moved(start, delta)).toMatchObject({ mode: 'bike' });
    });

    test('a step too long for a delta goes whole, and the deltas go on from it', () => {
      const base = fresh();
      send(start, base);
      expect(send({ ...start, x: 110 }, base).length).toBe(11 + 9);
      expect(send({ ...start, x: 110.5 }, base).length).toBe(11 + 5);
    });

    test('many deltas add up to where the figure is, to within a step', () => {
      const base = fresh();
      let x = 100;
      let at = whole(nearOf(send(start, base))[0]).x;
      for (let i = 0; i < 500; i++) {
        x += 0.5 + Math.sin(i) * 0.3;
        const entry = nearOf(send({ ...start, x }, base))[0] as { delta: MoveDelta };
        at = moved({ ...start, x: at }, entry.delta).x;
      }
      near(at, x, 0.02);
    });

    test('a delta can’t be asked for, and a frame with bits no entry has is refused', () => {
      expect(() =>
        encodeServerMessage(tickOf({ near: [{ id: 1, delta: { dx: 0, dz: 0 } }] })),
      ).toThrow(RangeError);
      // near of one at cell 0,0: id×2+1 = 3, dx, dz, then changes 0xff.
      const bad = new Uint8Array([24, 0, 0, 0, 0, 1, 0, 0, 0, 0, 3, 0, 0, 0xff, 0]);
      expect(decodeServerMessage(bad)).toBeNull();
    });
  });

  test('a door keeps the whole state', () => {
    const back = decodeServerMessage(encodeServerMessage({ type: 'placed', id: 5, state }));
    if (back?.type !== 'placed') throw new Error('no placed');
    expect(back.id).toBe(5);
    expectNear(back.state, state);
  });

  test('ids outside u32 and overlong names are refused when encoding', () => {
    expect(() => leaving(-1)).toThrow(RangeError);
    expect(() => leaving(2 ** 32)).toThrow(RangeError);
    expect(() => leaving(1.5)).toThrow(RangeError);
    expect(() =>
      encodeServerMessage(tickOf({ joins: [{ id: 1, name: 'n'.repeat(65), outfit, state }] })),
    ).toThrow(RangeError);
  });
});

describe('what the client says about its view', () => {
  test('drive is one byte, and asks for nothing else', () => {
    const bytes = encodeClientMessage({ type: 'drive' });
    expect(bytes.length).toBe(1);
    expect(decodeClientMessage(bytes)).toEqual({ type: 'drive' });
    expect(decodeClientMessage(new Uint8Array([...bytes, 0]))).toBeNull();
  });

  test('where the map looks and how far it reaches', () => {
    expect(
      decodeClientMessage(encodeClientMessage({ type: 'view', x: 12.5, z: -3.25, reach: 800 })),
    ).toEqual({ type: 'view', x: 12.5, z: -3.25, reach: 800 });
    // Past what 16 bits hold it says as far as it can.
    const far = encodeClientMessage({ type: 'view', x: 0, z: 0, reach: 1e6 });
    expect(decodeClientMessage(far)).toMatchObject({ reach: 0xffff });
    // A hidden tab asks for nobody.
    expect(
      decodeClientMessage(encodeClientMessage({ type: 'view', x: 0, z: 0, reach: 0 })),
    ).toMatchObject({ reach: 0 });
  });

  test('a view from before reach reads as looking at a street', () => {
    const old = new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(decodeClientMessage(old)).toEqual({ type: 'view', x: 0, z: 0, reach: 350 });
  });

  test('a view off the number line is refused', () => {
    const frame = encodeClientMessage({ type: 'view', x: 0, z: 0, reach: 100 });
    frame.set([0x7f, 0xc0, 0, 0], 1);
    expect(decodeClientMessage(frame)).toBeNull();
  });
});

describe('malformed frames decode to null', () => {
  const good = encodeServerMessage(tickOf({ joins: [{ id: 7, name: 'Bram', outfit, state }] }));

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

  test('an identity with flags it never has is refused', () => {
    const fine = encodeServerMessage({
      type: 'identity',
      guest: true,
      unseen: false,
      name: 'a',
      outfit,
    });
    const odd = fine.slice();
    odd[1] = 4;
    expect(decodeServerMessage(fine)).not.toBeNull();
    expect(decodeServerMessage(odd)).toBeNull();
  });

  test('a lying player count and an overlong id', () => {
    expect(decodeServerMessage(new Uint8Array([24, 0, 50, 1]))).toBeNull(); // leaves
    expect(decodeServerMessage(new Uint8Array([24, 0, 0, 50, 1]))).toBeNull(); // demotes
    expect(decodeServerMessage(new Uint8Array([24, 0, 0, 0, 50, 1]))).toBeNull(); // joins
    expect(decodeServerMessage(new Uint8Array([24, 0, 0, 0, 0, 50, 0, 0, 0, 0]))).toBeNull(); // near
    expect(decodeServerMessage(new Uint8Array([24, 0, 0, 0, 0, 0, 50, 1]))).toBeNull(); // far blocks
    const longId = [14, 0x80, 0x80, 0x80, 0x80, 0x10, ...Array(12).fill(0)];
    expect(decodeServerMessage(new Uint8Array(longId))).toBeNull();
    expect(decodeServerMessage(new Uint8Array([14, ...Array(11).fill(0x80)]))).toBeNull();
  });

  test('a coarse frame that lies about its count or weight is refused', () => {
    expect(decodeServerMessage(new Uint8Array([25, 1, 0, 0, 1, 0, 50, 1]))).toBeNull(); // count
    expect(decodeServerMessage(new Uint8Array([25, 1, 0, 0, 1, 0, 0]))).toBeNull(); // no weight
    expect(decodeServerMessage(new Uint8Array([25, 4]))).toBeNull(); // flags it never has
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

describe('a cached join', () => {
  const who = { id: 300, name: 'Sunny Otter', outfit: { skin: 1, hair: 2, shirt: 3, shorts: 4 } };

  test('is the bytes of the ordinary join, and only the numbers move', () => {
    const join = { ...who, state: quantise(state) };
    const cached = cacheJoin(join);
    const out = createOutput(8);
    const end = putCachedJoin(out, 2, cached);
    expect(end).toBe(2 + cached.bytes.length);
    const frame = encodeServerMessage({
      type: 'tick',
      flags: 0,
      leaves: [],
      demotes: [],
      joins: [join],
      near: [],
      far: [],
      cx: 0,
      cz: 0,
    } as ServerMessage);
    // The join sits in the frame after its flags and the empty lists before it.
    expect([...frame.subarray(5, 5 + cached.bytes.length)]).toEqual([...cached.bytes]);

    const there = quantise({ ...state, x: 99.5, z: -40.25, heading: 2, speed: 3, mode: 'bike' });
    freshenJoin(cached, there);
    expect([...cached.bytes]).toEqual([...cacheJoin({ ...who, state: there }).bytes]);
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
