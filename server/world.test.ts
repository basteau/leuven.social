import { describe, expect, test } from 'bun:test';

import {
  CLOSE_REPLACED,
  decodeServerMessage,
  encodeClientMessage,
  quantise,
} from '../src/net/protocol.ts';
import type { Outfit, PlayerState, ServerMessage } from '../src/net/protocol.ts';
import { CLOSE_SIGNED_OUT, createWorld, sanitise } from './world.ts';
import type { WorldOptions } from './world.ts';

const outfit: Outfit = { skin: 1, hair: 2, shirt: 3, shorts: 4 };
// As it comes off the wire, so what the world keeps compares equal.
const here: PlayerState = quantise({
  x: 10,
  z: 20,
  heading: 1,
  speed: 1.5,
  mode: 'foot',
  place: '',
  floor: 0,
});

class FakeConnection {
  messages: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  send(frame: Uint8Array) {
    const message = decodeServerMessage(frame);
    if (!message) throw new Error('the world sent a malformed frame');
    this.messages.push(message);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
  take(): ServerMessage[] {
    const taken = this.messages;
    this.messages = [];
    return taken;
  }
}

function setup(options: WorldOptions = {}) {
  let time = 0;
  const saved: [string, PlayerState][] = [];
  const world = createWorld({
    now: () => time,
    save: (userId, state) => saved.push([userId, state]),
    ...options,
  });
  const join = (userId: string | null) => {
    const connection = new FakeConnection();
    const account = userId ? { userId, name: userId.toUpperCase(), outfit } : null;
    const id = world.connect(connection, account);
    return { id, connection };
  };
  const move = (id: number, state: Partial<PlayerState> = {}) =>
    world.receive(id, encodeClientMessage({ type: 'state', state: { ...here, ...state } }));
  return {
    world,
    saved,
    join,
    move,
    advance: (ms: number) => (time += ms),
  };
}

describe('sanitise', () => {
  const area = [
    { minX: 0, minZ: 0, maxX: 100, maxZ: 100 },
    { minX: -50, minZ: 100, maxX: 150, maxZ: 200 },
  ];

  test('keeps a good state as it is', () => {
    expect(sanitise(here, area)).toEqual(here);
  });

  test('pulls a figure outside the map to the nearest edge of the nearest part', () => {
    expect(sanitise({ ...here, x: -10, z: 50 }, area)).toMatchObject({ x: 0, z: 50 });
    expect(sanitise({ ...here, x: -60, z: 150 }, area)).toMatchObject({ x: -50, z: 150 });
    expect(sanitise({ ...here, x: 500, z: 500 }, area)).toMatchObject({ x: 150, z: 200 });
  });

  test('normalises the heading, clamps speed and floor, refuses odd room ids', () => {
    const s = sanitise(
      { ...here, heading: -Math.PI, speed: 99, floor: 99.4, place: 'Stadhuis!' },
      area,
    );
    expect(s.heading).toBeCloseTo(Math.PI);
    // An odd room id is the street, whose one floor is 0.
    expect(s).toMatchObject({ speed: 25.5, floor: 0, place: '' });
    expect(sanitise({ ...here, floor: 99.4, place: 'kerk' }, area).floor).toBe(20);
    expect(sanitise({ ...here, floor: -9, place: 'sint-pieterskerk' }, area)).toMatchObject({
      floor: -4,
      place: 'sint-pieterskerk',
    });
    const odd = sanitise(
      {
        ...here,
        heading: Number.NaN,
        speed: Number.NaN,
        floor: Number.NaN,
        mode: 'boat' as never,
      },
      area,
    );
    expect(odd).toMatchObject({ heading: 0, speed: 0, floor: 0, mode: 'foot' });
  });

  test('every room the map has is a place the server keeps', async () => {
    const rooms = (await Bun.file(
      new URL('../public/data/rooms.json', import.meta.url),
    ).json()) as { id: string }[];
    expect(rooms.length).toBeGreaterThan(0);
    for (const { id } of rooms) expect(sanitise({ ...here, place: id }, area).place).toBe(id);
  });

  test('the street has one floor', () => {
    expect(sanitise({ ...here, floor: 20 }, area).floor).toBe(0);
    expect(sanitise({ ...here, floor: 2, place: 'kerk' }, area).floor).toBe(2);
  });

  test('uses the real map by default', () => {
    expect(sanitise({ ...here, x: 1e6 }).x).toBeLessThan(2000);
  });
});

describe('createWorld', () => {
  test('welcomes a player with their id and a guest with 0', () => {
    const { join, world } = setup();
    const a = join('a');
    const guest = join(null);
    expect(a.connection.take()).toEqual([{ type: 'welcome', you: a.id }]);
    expect(guest.connection.take()).toEqual([{ type: 'welcome', you: 0 }]);
    expect(a.id).not.toBe(guest.id);
    expect(world.size).toBe(2);
  });

  test('announces a player with their first state, to everyone else', async () => {
    const { join, move, world } = setup();
    const a = join('a');
    const b = join('b');
    const guest = join(null);
    for (const c of [a, b, guest]) c.connection.take();
    expect(world.stateOf('a')).toBeNull();
    await move(a.id);
    const joined: ServerMessage = { type: 'join', id: a.id, name: 'A', outfit, state: here };
    expect(b.connection.take()).toEqual([joined]);
    expect(guest.connection.take()).toEqual([joined]);
    expect(a.connection.take()).toEqual([]);
    expect(world.stateOf('a')).toEqual(here);
  });

  test('a newcomer hears about everyone already placed', async () => {
    const { join, move } = setup();
    const a = join('a');
    join('b');
    await move(a.id);
    const c = join(null);
    expect(c.connection.take()).toEqual([
      { type: 'welcome', you: 0 },
      { type: 'join', id: a.id, name: 'A', outfit, state: here },
    ]);
  });

  test('ticks batch only those who moved, to everyone', async () => {
    const { join, move, world } = setup();
    const a = join('a');
    const b = join('b');
    await move(a.id);
    await move(b.id);
    world.tick();
    a.connection.take();
    b.connection.take();
    await move(a.id, { x: 11 });
    await move(a.id, { x: 12 });
    world.tick();
    const update: ServerMessage = {
      type: 'states',
      players: [{ id: a.id, state: { ...here, x: 12 } }],
    };
    expect(a.connection.take()).toEqual([update]);
    expect(b.connection.take()).toEqual([update]);
    // The same state again (a heartbeat) is not news.
    await move(a.id, { x: 12 });
    world.tick();
    expect(b.connection.take()).toEqual([]);
  });

  test('guests and text frames are not heard', async () => {
    const { join, move, world } = setup();
    const a = join('a');
    const guest = join(null);
    await move(guest.id);
    await world.receive(a.id, 'hello');
    await world.receive(a.id, new Uint8Array([1, 2, 3]));
    await world.receive(999, encodeClientMessage({ type: 'state', state: here }));
    world.tick();
    expect(a.connection.take()).toEqual([{ type: 'welcome', you: a.id }]);
    expect(world.stateOf('a')).toBeNull();
  });

  test('a state off the map is pulled back onto it', async () => {
    const { join, move, world } = setup({ area: [{ minX: 0, minZ: 0, maxX: 50, maxZ: 50 }] });
    const a = join('a');
    await move(a.id, { x: 1e5 });
    expect(world.stateOf('a')?.x).toBe(50);
  });

  test('a connection sending too fast is dropped to its allowance', async () => {
    const { join, move, world, advance } = setup({ rate: { limit: 2, period: 1000 } });
    const a = join('a');
    await move(a.id, { x: 1 });
    await move(a.id, { x: 2 });
    await move(a.id, { x: 3 });
    expect(world.stateOf('a')?.x).toBe(2);
    advance(500);
    await move(a.id, { x: 4 });
    expect(world.stateOf('a')?.x).toBe(4);
  });

  test('leaving tells the others, saves the last state, and forgets the player', async () => {
    const { join, move, world, saved } = setup();
    const a = join('a');
    const b = join('b');
    const quiet = join('quiet');
    await move(a.id, { x: 30 });
    b.connection.take();
    world.disconnect(a.id);
    world.disconnect(quiet.id);
    world.disconnect(a.id);
    expect(b.connection.take()).toEqual([{ type: 'leave', id: a.id }]);
    expect(saved).toEqual([['a', { ...here, x: 30 }]]);
    expect(world.stateOf('a')).toBeNull();
    expect(world.size).toBe(1);
  });

  test('a message that lands after its connection left is dropped', async () => {
    const { join, move, world } = setup();
    const a = join('a');
    const pending = move(a.id);
    world.disconnect(a.id);
    await pending;
    expect(world.stateOf('a')).toBeNull();
  });

  test('saves a moving player every so often, and not when nothing changed', async () => {
    const { join, move, world, saved, advance } = setup({ saveEvery: 1000 });
    const a = join('a');
    await move(a.id, { x: 1 });
    world.tick();
    expect(saved).toEqual([]);
    advance(1000);
    world.tick();
    expect(saved).toEqual([['a', { ...here, x: 1 }]]);
    advance(1000);
    world.tick();
    expect(saved.length).toBe(1);
    await move(a.id, { x: 2 });
    advance(1000);
    world.tick();
    expect(saved.length).toBe(2);
  });

  test('flush saves everyone with unsaved moves', async () => {
    const { join, move, world, saved } = setup();
    const a = join('a');
    join(null);
    await move(a.id, { x: 5 });
    world.flush();
    world.flush();
    expect(saved).toEqual([['a', { ...here, x: 5 }]]);
  });

  test('signing in again replaces the old connection', async () => {
    const { join, move, world, saved } = setup();
    const watcher = join(null);
    const first = join('a');
    await move(first.id, { x: 7 });
    watcher.connection.take();
    const second = join('a');
    expect(first.connection.closed).toEqual({
      code: CLOSE_REPLACED,
      reason: 'Signed in somewhere else',
    });
    expect(watcher.connection.take()).toEqual([{ type: 'leave', id: first.id }]);
    expect(saved).toEqual([['a', { ...here, x: 7 }]]);
    // The old socket's close event comes later and must not unseat the new one.
    world.disconnect(first.id);
    await move(second.id, { x: 8 });
    expect(world.stateOf('a')?.x).toBe(8);
    await move(first.id, { x: 9 });
    expect(world.stateOf('a')?.x).toBe(8);
  });

  test('a session that ended takes its player off the map, free to come back as a guest', async () => {
    const { world, join, move } = setup();
    const ana = join('ana');
    const bo = join('bo');
    await move(ana.id);
    bo.connection.take();
    world.drop('ana');
    expect(ana.connection.closed).toEqual({ code: CLOSE_SIGNED_OUT, reason: 'Signed out' });
    expect(bo.connection.take()).toEqual([{ type: 'leave', id: ana.id }]);
    expect(world.stateOf('ana')).toBeNull();
    // Nobody online by that name: nothing to do.
    world.drop('nobody');
  });

  test('a new outfit reaches everyone', async () => {
    const { join, move, world } = setup();
    const a = join('a');
    const b = join('b');
    await move(a.id);
    a.connection.take();
    b.connection.take();
    const red = { ...outfit, shirt: 0xff0000 };
    world.setOutfit('a', red);
    world.setOutfit('nobody', red);
    expect(b.connection.take()).toEqual([{ type: 'outfit', id: a.id, outfit: red }]);
    expect(a.connection.take()).toEqual([{ type: 'outfit', id: a.id, outfit: red }]);
    const c = join(null);
    expect(c.connection.take()[1]).toMatchObject({ type: 'join', outfit: red });
  });

  test('a connection that throws on send does not stop the others', async () => {
    const { join, move } = setup();
    const broken = join('broken');
    broken.connection.send = () => {
      throw new Error('closed');
    };
    const b = join('b');
    b.connection.take();
    await move(broken.id);
    const c = join('c');
    await move(c.id);
    expect(b.connection.take().map((m) => m.type)).toEqual(['join', 'join']);
  });

  test('runs on its defaults: the real clock and map, saving nowhere', async () => {
    const world = createWorld();
    const connection = new FakeConnection();
    const id = world.connect(connection, { userId: 'a', name: 'A', outfit });
    await world.receive(id, encodeClientMessage({ type: 'state', state: here }));
    world.disconnect(id);
    expect(world.size).toBe(0);
  });
});
