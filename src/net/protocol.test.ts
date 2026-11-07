import { describe, expect, test } from 'bun:test';

import {
  MAX_PLACE_BYTES,
  decodeClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  encodeServerMessage,
  isOutfit,
  quantise,
} from './protocol.ts';
import type { Outfit, PlayerState, ServerMessage } from './protocol.ts';

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

describe('client messages', () => {
  test('a state round-trips within its quantisation', () => {
    const bytes = encodeClientMessage({ type: 'state', state });
    expect(bytes.length).toBe(1 + 13 + 1 + state.place.length);
    const message = decodeClientMessage(bytes);
    expect(message?.type).toBe('state');
    expectNear(message!.state, state);
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
    { type: 'join', id: 7, name: 'Marie-Thérèse', outfit, state },
    { type: 'leave', id: 300 },
    { type: 'states', players: [] },
    {
      type: 'states',
      players: [
        { id: 1, state },
        { id: 2, state: { ...state, place: '', floor: -1 } },
      ],
    },
    { type: 'outfit', id: 9, outfit },
  ];

  test.each(messages.map((m) => [m.type, m] as const))('%s round-trips', (_, message) => {
    const back = decodeServerMessage(encodeServerMessage(message));
    expect(back?.type).toBe(message.type);
    if (back?.type === 'join' && message.type === 'join') {
      expect({ ...back, state: undefined }).toEqual({ ...message, state: undefined });
      expectNear(back.state, message.state);
    } else if (back?.type === 'states' && message.type === 'states') {
      expect(back.players.map((p) => p.id)).toEqual(message.players.map((p) => p.id));
      back.players.forEach((p, i) => expectNear(p.state, message.players[i]!.state));
    } else {
      expect(back).toEqual(message);
    }
  });

  test('ids outside u32 and overlong names are refused when encoding', () => {
    expect(() => encodeServerMessage({ type: 'leave', id: -1 })).toThrow(RangeError);
    expect(() => encodeServerMessage({ type: 'leave', id: 2 ** 32 })).toThrow(RangeError);
    expect(() => encodeServerMessage({ type: 'leave', id: 1.5 })).toThrow(RangeError);
    expect(() =>
      encodeServerMessage({ type: 'join', id: 1, name: 'n'.repeat(65), outfit, state }),
    ).toThrow(RangeError);
  });
});

describe('malformed frames decode to null', () => {
  const good = encodeServerMessage({ type: 'join', id: 7, name: 'Bram', outfit, state });

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
    expect(patch(11, 255)?.state.speed).toBe(25.5); // the most a byte holds
    expect(patch(15, 0xff)).toBeNull(); // invalid UTF-8 in the place
    expect(patch(14, MAX_PLACE_BYTES + 1)).toBeNull(); // the place's length
  });

  test('a lying player count and an overlong id', () => {
    expect(decodeServerMessage(new Uint8Array([13, 50, 1]))).toBeNull();
    expect(decodeServerMessage(new Uint8Array([12, 0x80, 0x80, 0x80, 0x80, 0x10]))).toBeNull();
    expect(decodeServerMessage(new Uint8Array([12, ...Array(11).fill(0x80)]))).toBeNull();
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
