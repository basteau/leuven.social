import { describe, expect, test } from 'bun:test';

import { decodeServerMessage, encodeClientMessage, quantise } from '../src/net/protocol.ts';
import type { Move, MoveEntry, Outfit, PlayerState, ServerMessage } from '../src/net/protocol.ts';
import { CELL_SIZE } from '../src/data/grid.ts';
import { CLOSE_SIGNED_OUT, createWorld, sanitise, withinReach } from './world.ts';
import type { Account, ConnectOptions, WorldOptions } from './world.ts';

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
  queued = 0;
  dropping = false;
  buffered() {
    return this.queued;
  }
  send(frame: Uint8Array): number | void {
    if (this.dropping) return 0;
    const message = decodeServerMessage(frame);
    if (!message) throw new Error('the world sent a malformed frame');
    this.messages.push(message);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
  /** What it heard, leaving aside who it is and whether it drives: tests of those read `messages`. */
  take(): ServerMessage[] {
    const taken = this.messages;
    this.messages = [];
    return taken.filter((m) => m.type !== 'identity' && m.type !== 'driving');
  }
}

function setup(options: WorldOptions = {}) {
  let time = 0;
  const saved: [string, PlayerState][] = [];
  const world = createWorld({
    now: () => time,
    save: (saves) => saved.push(...saves.map((s): [string, PlayerState] => [s.userId, s.state])),
    ...options,
  });
  let guests = 0;
  const join = (userId: string | null, connectOptions: ConnectOptions = {}) => {
    const connection = new FakeConnection();
    const account: Account = userId
      ? { userId, name: userId.toUpperCase(), outfit }
      : { userId: `guest:${++guests}`, name: `Guest ${guests}`, outfit, guest: true };
    const id = world.connect(connection, account, connectOptions);
    const welcome = connection.messages[0];
    return { id, you: welcome?.type === 'welcome' ? welcome.you : 0, connection, account };
  };
  const move = (id: number, state: Partial<PlayerState> = {}) =>
    world.receive(id, encodeClientMessage({ type: 'state', state: { ...here, ...state } }));
  const look = (id: number, x: number, z: number) =>
    world.receive(id, encodeClientMessage({ type: 'view', x, z }));
  return {
    world,
    saved,
    join,
    move,
    look,
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

/** A `moves` entry that says the whole move. */
const whole = (entry: MoveEntry | { id: number; state: Move } | undefined) => {
  if (!entry || 'delta' in entry) throw new Error('not a whole move');
  return entry.state;
};

const ofType = <T extends ServerMessage['type']>(messages: ServerMessage[], type: T) =>
  messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
const joinedIds = (messages: ServerMessage[]) =>
  ofType(messages, 'joins').flatMap((m) => m.players.map((p) => p.id));
const leftIds = (messages: ServerMessage[]) => ofType(messages, 'leaves').flatMap((m) => m.ids);
const movedIds = (messages: ServerMessage[]) =>
  ofType(messages, 'moves').flatMap((m) => m.players.map((p) => p.id));

describe('withinReach', () => {
  const from = { ...here, x: 0, z: 0 };

  test('lets a figure go as far as top speed allows', () => {
    const next = { ...from, x: 30 };
    expect(withinReach(from, next, 1)).toBe(next);
  });

  test('stops a teleport at the edge of what the time allows', () => {
    const got = withinReach(from, { ...from, x: 10_000 }, 1);
    expect(got.x).toBeCloseTo(38);
    expect(got.z).toBe(0);
  });

  test('a long pause does not earn a long jump', () => {
    expect(withinReach(from, { ...from, x: 10_000 }, 3600).x).toBeCloseTo(158);
  });

  test('a door moves a figure at once', () => {
    const inside = { ...from, x: 10_000, place: 'stadhuis' };
    expect(withinReach(from, inside, 0)).toBe(inside);
    const upstairs = { ...inside, floor: 1 };
    expect(withinReach(inside, upstairs, 0)).toBe(upstairs);
  });
});

const drive = (world: ReturnType<typeof setup>['world'], id: number) =>
  world.receive(id, encodeClientMessage({ type: 'drive' }));
const named = (c: FakeConnection) => ofType(c.messages, 'identity')[0]?.name;
const guestAccount = (n: number): Account => ({
  userId: `guest:g${n}`,
  name: 'Sunny Otter',
  outfit,
  guest: true,
});
/** Another tab of someone already on the map. */
const joinTab = (world: ReturnType<typeof setup>['world'], guest: { account: Account }) => {
  const connection = new FakeConnection();
  return { id: world.connect(connection, guest.account), connection };
};

describe('createWorld', () => {
  test('welcomes a player and a guest alike, with the id of their figure', () => {
    const { join, world } = setup();
    const a = join('a');
    const guest = join(null);
    expect(a.connection.take()).toEqual([{ type: 'welcome', you: a.you }]);
    expect(guest.connection.take()).toEqual([{ type: 'welcome', you: guest.you }]);
    expect(a.you).not.toBe(guest.you);
    expect(guest.you).toBeGreaterThan(0);
    expect(world.size).toBe(2);
  });

  test('a player appears with their first state, to those nearby, at the next tick', async () => {
    const { join, move, world } = setup();
    const a = join('a');
    const b = join('b');
    const guest = join(null);
    await move(b.id);
    world.tick();
    for (const c of [a, b, guest]) c.connection.take();
    expect(world.stateOf('a')).toBeNull();
    await move(a.id);
    expect(guest.connection.take()).toEqual([]);
    world.tick();
    const joins: ServerMessage = {
      type: 'joins',
      players: [{ id: a.you, name: 'A', outfit, state: here }],
    };
    expect(b.connection.take()).toEqual([joins]);
    expect(guest.connection.take()).toEqual([joins]);
    expect(a.connection.take()).toEqual([]);
    expect(world.stateOf('a')).toEqual(here);
  });

  test('a newcomer hears of everyone placed nearby in one frame', async () => {
    const { join, move, world } = setup();
    const a = join('a');
    const b = join('b');
    const c = join('c');
    await Promise.all([move(a.id), move(b.id), move(c.id)]);
    world.tick();
    const late = join(null);
    world.tick();
    const heard = late.connection.take();
    expect(heard[0]).toEqual({ type: 'welcome', you: late.you });
    expect(heard.length).toBe(2);
    expect(joinedIds(heard).toSorted()).toEqual([a.you, b.you, c.you].toSorted());
  });

  test('a far-off player is not heard of at all', async () => {
    const { join, move, world } = setup();
    const near = join('near');
    const far = join('far');
    await move(near.id, { x: 10, z: 20 });
    await move(far.id, { x: CELL_SIZE * 3 + 10, z: 20 });
    world.tick();
    near.connection.take();
    far.connection.take();
    await move(far.id, { x: CELL_SIZE * 3 + 15, z: 20 });
    world.tick();
    expect(near.connection.take()).toEqual([]);
    expect(far.connection.take()).toEqual([]);
  });

  test('walking across a cell edge brings people into view and takes them out', async () => {
    const { join, move, world, advance } = setup();
    const west = join('west');
    const east = join('east');
    const walker = join('walker');
    await move(west.id, { x: -CELL_SIZE + 10, z: 20 });
    await move(east.id, { x: CELL_SIZE * 2 + 10, z: 20 });
    await move(walker.id, { x: CELL_SIZE - 1, z: 20 });
    world.tick();
    expect(joinedIds(walker.connection.take())).toEqual([west.you]);
    for (const c of [west, east]) c.connection.take();
    // It stepped from cell 0 into cell 1: east comes into view, west goes out of it.
    advance(1000);
    await move(walker.id, { x: CELL_SIZE + 1, z: 20 });
    world.tick();
    const heard = walker.connection.take();
    expect(joinedIds(heard)).toEqual([east.you]);
    expect(leftIds(heard)).toEqual([west.you]);
    expect(joinedIds(east.connection.take())).toEqual([walker.you]);
    expect(leftIds(west.connection.take())).toEqual([walker.you]);
    // And out the other way.
    advance(1000);
    await move(walker.id, { x: CELL_SIZE - 1, z: 20 });
    world.tick();
    expect(leftIds(walker.connection.take())).toEqual([east.you]);
    expect(leftIds(east.connection.take())).toEqual([walker.you]);
  });

  test('a client hears of what its map looks at, whatever its figure does', async () => {
    const { join, move, look, world, advance } = setup();
    const here1 = join('here1');
    const there = join('there');
    const guest = join(null);
    await move(here1.id, { x: 10, z: 20 });
    await move(there.id, { x: CELL_SIZE * 4 + 10, z: 20 });
    world.tick();
    expect(joinedIds(guest.connection.take())).toEqual([here1.you]);
    advance(250);
    await look(guest.id, CELL_SIZE * 4 + 20, 20);
    world.tick();
    const heard = guest.connection.take();
    expect(leftIds(heard)).toEqual([here1.you]);
    expect(joinedIds(heard)).toEqual([there.you]);
  });

  test('coming into view and going out of it in one tick says nothing', async () => {
    const wide = [{ minX: -1e5, minZ: -1e5, maxX: 1e5, maxZ: 1e5 }];
    const { join, move, look, world, advance } = setup({ area: wide });
    const player = join('player');
    const viewer = join(null);
    await look(viewer.id, 20, 20);
    await move(player.id, { x: CELL_SIZE * 6, z: 20 });
    world.tick();
    expect(joinedIds(viewer.connection.take())).toEqual([]);
    // A door brings the player into what it watches, just as it looks away from there.
    advance(250);
    await move(player.id, { x: 30, z: 20, place: 'stadhuis' });
    await look(viewer.id, CELL_SIZE * 12, 20);
    world.tick();
    expect(viewer.connection.take()).toEqual([]);
    // And out, as it looks back.
    advance(250);
    await look(viewer.id, 20, 20);
    world.tick();
    expect(joinedIds(viewer.connection.take())).toEqual([player.you]);
    advance(250);
    await move(player.id, { x: CELL_SIZE * 6, z: 20, place: '' });
    await look(viewer.id, CELL_SIZE * 12, 20);
    world.tick();
    expect(leftIds(viewer.connection.take())).toEqual([player.you]);
  });

  test('looking somewhere else takes effect at most four times a second', async () => {
    const { join, move, look, world, advance } = setup();
    const here1 = join('here1');
    const guest = join(null);
    await move(here1.id, { x: 10, z: 20 });
    world.tick();
    expect(joinedIds(guest.connection.take())).toEqual([here1.you]);
    // Flipping back and forth inside the window is one look.
    await look(guest.id, CELL_SIZE * 3 + 10, 20);
    world.tick();
    await look(guest.id, 10, 20);
    world.tick();
    expect(guest.connection.take()).toEqual([]);
    await look(guest.id, CELL_SIZE * 3 + 10, 20);
    advance(250);
    world.tick();
    expect(leftIds(guest.connection.take())).toEqual([here1.you]);
  });

  test('a look off the map stays on it, and an empty cell leaves nothing behind', async () => {
    const { join, look, world, advance } = setup();
    const guest = join(null);
    for (let i = 0; i < 40; i++) {
      advance(250);
      // eslint-disable-next-line no-await-in-loop -- ticks follow one another
      await look(guest.id, 1e9 + i * 1050, -1e9);
      world.tick();
    }
    // It watches the map's corner, and hears of nobody off it.
    expect(leftIds(guest.connection.take())).toEqual([]);
    world.disconnect(guest.id);
    world.tick();
    expect(world.size).toBe(0);
  });

  test('ticks batch only those who moved', async () => {
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
    const [moves, ...rest] = b.connection.take();
    expect(rest).toEqual([]);
    expect(moves).toMatchObject({ type: 'moves', cx: 0, cz: 0 });
    expect(moves?.type === 'moves' && moves.players[0]?.id).toBe(a.you);
    expect(moves?.type === 'moves' && whole(moves.players[0]).x).toBeCloseTo(12, 1);
    // Nobody is told about their own step.
    expect(a.connection.take()).toEqual([]);
    // The same state again (a heartbeat) is not news.
    await move(a.id, { x: 12 });
    world.tick();
    expect(b.connection.take()).toEqual([]);
  });

  test('in a crowd the nearest move every tick and the others take turns', async () => {
    const { join, move, world, advance } = setup({ rate: { limit: 1e6, period: 1000 } });
    const viewer = join('viewer');
    await move(viewer.id, { x: 10, z: 10 });
    const crowd = Array.from({ length: 100 }, (_, i) => ({ c: join(`p${i}`), i }));
    await Promise.all(crowd.map(({ c, i }) => move(c.id, { x: 10 + i, z: 10 })));
    world.tick();
    viewer.connection.take();

    const heard = new Map<number, number>();
    for (let t = 0; t < 10; t++) {
      advance(100);
      // eslint-disable-next-line no-await-in-loop -- ticks follow one another
      await Promise.all(
        crowd.map(({ c, i }) => move(c.id, { x: 10 + i + (t % 2 ? 0.1 : 0.2), z: 10 })),
      );
      world.tick();
      const moved = movedIds(viewer.connection.take());
      expect(moved.length).toBeGreaterThanOrEqual(32);
      expect(moved.length).toBeLessThanOrEqual(160);
      for (const id of moved) heard.set(id, (heard.get(id) ?? 0) + 1);
    }
    // Everyone was heard within the second, and the nearest in every tick of it.
    expect(heard.size).toBe(100);
    expect(heard.get(crowd[0]!.c.you)).toBe(10);
    expect(heard.get(crowd[20]!.c.you)).toBe(10);
    expect(heard.get(crowd[99]!.c.you)).toBeLessThan(4);
  });

  test('someone who stops mid-crowd is still heard to have stopped, on their turn', async () => {
    const { join, move, world, advance } = setup({ rate: { limit: 1e6, period: 1000 } });
    const viewer = join('viewer');
    await move(viewer.id, { x: 10, z: 10 });
    const crowd = Array.from({ length: 50 }, (_, i) => join(`p${i}`));
    await Promise.all(crowd.map((c, i) => move(c.id, { x: 12 + i, z: 10 })));
    const last = crowd.at(-1)!;
    world.tick();
    viewer.connection.take();
    // One last step from the far one, during which everyone else keeps it out of the nearest.
    advance(100);
    await Promise.all(crowd.map((c, i) => move(c.id, { x: 12 + i + 0.5, z: 10, speed: 2 })));
    world.tick();
    viewer.connection.take();
    const movedAfter: number[] = [];
    for (let t = 0; t < 12; t++) {
      advance(100);
      // eslint-disable-next-line no-await-in-loop -- ticks follow one another
      await Promise.all(
        crowd.map((c, i) =>
          c === last ? null : move(c.id, { x: 12 + i + (t % 2), z: 10, speed: 2 }),
        ),
      );
      world.tick();
      movedAfter.push(...movedIds(viewer.connection.take()));
    }
    expect(movedAfter).toContain(last.you);
  });

  test('a door goes first, with the full state', async () => {
    const { join, move, world } = setup();
    const a = join('a');
    const b = join('b');
    await move(a.id);
    await move(b.id);
    world.tick();
    b.connection.take();
    await move(a.id, { x: 12, place: 'stadhuis', floor: 1 });
    world.tick();
    const heard = b.connection.take();
    expect(heard[0]).toEqual({
      type: 'placed',
      id: a.you,
      state: { ...here, x: 12, place: 'stadhuis', floor: 1 },
    });
    expect(heard[1]?.type).toBe('moves');
  });

  test('text frames and unknown sockets are not heard', async () => {
    const { join, world } = setup();
    const a = join('a');
    await world.receive(a.id, 'hello');
    await world.receive(a.id, new Uint8Array([1, 2, 3]));
    await world.receive(999, encodeClientMessage({ type: 'state', state: here }));
    world.tick();
    expect(a.connection.take()).toEqual([{ type: 'welcome', you: a.you }]);
    expect(world.stateOf('a')).toBeNull();
  });

  test('a state off the map is pulled back onto it', async () => {
    const { join, move, world } = setup({ area: [{ minX: 0, minZ: 0, maxX: 50, maxZ: 50 }] });
    const a = join('a');
    await move(a.id, { x: 1e5 });
    expect(world.stateOf('a')?.x).toBe(50);
  });

  test('a figure cannot jump further than it could have gone', async () => {
    const { join, move, world, advance } = setup();
    const a = join('a');
    await move(a.id, { x: 0, z: 0 });
    advance(1000);
    await move(a.id, { x: 900, z: 0 });
    expect(world.stateOf('a')?.x).toBeCloseTo(38);
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

  test('leaving tells those who saw it, saves the last state, and forgets the player', async () => {
    const { join, move, world, saved } = setup();
    const a = join('a');
    const b = join('b');
    const quiet = join('quiet');
    await move(a.id, { x: 30 });
    world.tick();
    b.connection.take();
    world.disconnect(a.id);
    world.disconnect(quiet.id);
    world.disconnect(a.id);
    world.tick();
    expect(b.connection.take()).toEqual([{ type: 'leaves', ids: [a.you] }]);
    expect(saved).toEqual([['a', { ...here, x: 30 }]]);
    expect(world.stateOf('a')).toBeNull();
    expect(world.size).toBe(1);
  });

  test('a freed id is only used again after everyone has heard it left', async () => {
    const { join, move, world } = setup();
    const a = join('a');
    const b = join('b');
    await move(a.id);
    world.tick();
    b.connection.take();
    world.disconnect(a.id);
    const during = join('during');
    expect(during.you).not.toBe(a.you);
    world.tick();
    expect(leftIds(b.connection.take())).toEqual([a.you]);
    expect(join('after').you).toBe(a.you);
  });

  test('a message that lands after its connection left is dropped', async () => {
    const { join, move, world } = setup();
    const a = join('a');
    const pending = move(a.id);
    world.disconnect(a.id);
    await pending;
    expect(world.stateOf('a')).toBeNull();
  });

  test('saves a moving player every so often, in one batch, and not when nothing changed', async () => {
    const batches: number[] = [];
    let time = 0;
    const world = createWorld({
      now: () => time,
      saveEvery: 1000,
      save: (saves) => batches.push(saves.length),
    });
    const a = new FakeConnection();
    const b = new FakeConnection();
    const ids = [
      world.connect(a, { userId: 'a', name: 'A', outfit }),
      world.connect(b, { userId: 'b', name: 'B', outfit }),
    ];
    await Promise.all(
      ids.map((id) => world.receive(id, encodeClientMessage({ type: 'state', state: here }))),
    );
    world.tick();
    expect(batches).toEqual([]);
    time += 1000;
    world.tick();
    expect(batches).toEqual([2]);
    time += 1000;
    world.tick();
    expect(batches).toEqual([2]);
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

  describe('one figure a person, whichever tab drives it', () => {
    test('a second tab joins the figure instead of being another one', async () => {
      const { join, move, world, saved } = setup();
      const watcher = join(null);
      const first = join('a');
      await move(first.id, { x: 7 });
      world.tick();
      watcher.connection.take();
      const second = join('a');
      expect(second.you).toBe(first.you);
      expect(first.connection.closed).toBeNull();
      expect(ofType(second.connection.messages, 'driving')).toEqual([
        { type: 'driving', on: false },
      ]);
      expect(ofType(second.connection.messages, 'placed')).toEqual([
        { type: 'placed', id: first.you, state: { ...here, x: 7 } },
      ]);
      world.tick();
      expect(ofType(watcher.connection.take(), 'joins')).toEqual([]);
      expect(world.stats()).toMatchObject({ online: 3 });
      // The figure goes only when its last tab does.
      world.disconnect(first.id);
      world.tick();
      expect(leftIds(watcher.connection.take())).toEqual([]);
      expect(saved).toEqual([]);
      world.disconnect(second.id);
      world.tick();
      expect(leftIds(watcher.connection.take())).toEqual([first.you]);
      expect(saved).toEqual([['a', { ...here, x: 7 }]]);
    });

    test('only the tab in use moves the figure; a claim settles it without a fight', async () => {
      const { join, move, world } = setup();
      const first = join('a');
      const second = join('a');
      await move(first.id, { x: 7 });
      await move(second.id, { x: 9 });
      expect(world.stateOf('a')?.x).toBe(7);
      first.connection.take();
      await drive(world, second.id);
      await move(first.id, { x: 8 });
      expect(world.stateOf('a')?.x).toBe(7);
      expect(ofType(first.connection.messages, 'driving')).toEqual([
        { type: 'driving', on: false },
      ]);
      // The claimer hears it too, over the "not you" it was sent on connecting.
      expect(ofType(second.connection.messages, 'driving').at(-1)).toEqual({
        type: 'driving',
        on: true,
      });
      await move(second.id, { x: 9 });
      expect(world.stateOf('a')?.x).toBe(9);
      // Saying so again changes nothing, and nothing is sent back to the other tab to answer.
      const heard = first.connection.messages.length;
      await drive(world, second.id);
      expect(first.connection.messages).toHaveLength(heard);
    });

    test('the tabs that don’t drive follow the figure', async () => {
      const { join, move, world } = setup();
      const first = join('a');
      const second = join('a');
      await move(first.id, { x: 7 });
      await move(first.id, { x: 8 });
      world.tick();
      const followed = ofType(second.connection.take(), 'placed');
      expect(followed.at(-1)).toEqual({ type: 'placed', id: first.you, state: { ...here, x: 8 } });
      expect(ofType(first.connection.take(), 'placed')).toEqual([]);
    });

    test('when the tab in use closes, the newest left takes over', async () => {
      const { join, move, world } = setup();
      const first = join('a');
      const second = join('a');
      const third = join('a');
      await move(first.id, { x: 7 });
      third.connection.take();
      world.disconnect(first.id);
      expect(ofType(third.connection.messages, 'driving')).toEqual([{ type: 'driving', on: true }]);
      expect(second.connection.messages.filter((m) => m.type === 'driving')).toHaveLength(1);
      await move(third.id, { x: 9 });
      expect(world.stateOf('a')?.x).toBe(9);
    });

    test('a person can only keep so many tabs: the next is refused, for good', () => {
      const { join, world } = setup();
      const tabs = Array.from({ length: 16 }, () => join('a'));
      const extra = join('a');
      expect(extra.id).toBe(0);
      expect(extra.connection.closed?.code).toBe(1008);
      expect(tabs[0]!.connection.closed).toBeNull();
      expect(world.size).toBe(16);
    });
  });

  describe('guests', () => {
    test('a guest is on the map, and heard of by everyone, as anybody else', async () => {
      const { join, move, world } = setup();
      const watcher = join('w');
      const guest = join(null);
      await move(guest.id);
      world.tick();
      const joins = ofType(watcher.connection.take(), 'joins');
      expect(joins[0]?.players).toEqual([{ id: guest.you, name: 'Guest 1', outfit, state: here }]);
    });

    test('two guests with the same name are told apart, and the name comes free', () => {
      const world = createWorld({ now: () => 0 });
      const connect = (n: number) => {
        const connection = new FakeConnection();
        return { id: world.connect(connection, guestAccount(n)), connection };
      };
      const first = connect(1);
      const second = connect(2);
      expect(named(first.connection)).toBe('Sunny Otter');
      expect(named(second.connection)).toBe('Sunny Otter 2');
      expect(world.who('guest:g2')?.name).toBe('Sunny Otter 2');
      world.disconnect(first.id);
      expect(named(connect(3).connection)).toBe('Sunny Otter');
    });

    test('nobody saves a guest, but where one left is remembered for a while', async () => {
      const { join, move, world, saved, advance } = setup({ saveEvery: 100 });
      const guest = join(null);
      const key = guest.account.userId;
      await move(guest.id, { x: 5 });
      advance(150);
      world.tick();
      world.disconnect(guest.id);
      world.flush();
      expect(saved).toEqual([]);
      expect(world.stateOf(key)).toMatchObject({ x: 5 });
      advance(10 * 60 * 1000 + 1);
      expect(world.stateOf(key)).toBeNull();
    });

    test('a long-gone guest is cleared out', async () => {
      const { join, move, world, advance } = setup();
      const guest = join(null);
      await move(guest.id, { x: 5 });
      world.disconnect(guest.id);
      advance(11 * 60 * 1000);
      for (let i = 0; i < 301; i++) world.tick();
      // Nothing left to return, and no error from having cleared it.
      expect(world.stateOf(guest.account.userId)).toBeNull();
    });

    test('many gone guests can’t pile up without end', async () => {
      const { join, move, world } = setup();
      const first = join(null);
      await move(first.id, { x: 5 });
      world.disconnect(first.id);
      for (let i = 0; i < 2048; i++) {
        const g = join(null);
        // eslint-disable-next-line no-await-in-loop -- one at a time, as they would come
        await move(g.id);
        world.disconnect(g.id);
      }
      expect(world.stateOf(first.account.userId)).toBeNull();
    });

    test('guests from one address over the cap watch, unseen and told so', async () => {
      const { join, move, world } = setup({ guestsPerAddress: 2 });
      const a = join(null, { address: 'x' });
      const b = join(null, { address: 'x' });
      const c = join(null, { address: 'x' });
      const elsewhere = join(null, { address: 'y' });
      const seen = (g: typeof a) => ofType(g.connection.messages, 'identity')[0]?.unseen;
      expect([seen(a), seen(b), seen(c), seen(elsewhere)]).toEqual([false, false, true, false]);
      await move(c.id, { x: 5 });
      expect(world.stateOf(c.account.userId)).toBeNull();
      // A second tab of a guest already out there is not another guest.
      expect(ofType(joinTab(world, a).connection.messages, 'identity')[0]?.unseen).toBe(false);
      world.disconnect(a.id);
      // The tab above keeps guest a on the map, so there is still no room.
      expect(ofType(join(null, { address: 'x' }).connection.messages, 'identity')[0]?.unseen).toBe(
        true,
      );
      world.disconnect(b.id);
      expect(ofType(join(null, { address: 'x' }).connection.messages, 'identity')[0]?.unseen).toBe(
        false,
      );
    });

    test('signing in: the same figure carries on under the account’s name', async () => {
      const { join, move, world, saved } = setup();
      const watcher = join('w');
      const guest = join(null);
      const tab = joinTab(world, guest);
      await move(guest.id, { x: 5 });
      world.tick();
      watcher.connection.take();
      guest.connection.take();
      const red = { ...outfit, shirt: 0xff0000 };
      world.signedIn(guest.account.userId, { userId: 'ana', name: 'Ana', outfit: red }, 'token');
      expect(watcher.connection.take()).toEqual([
        { type: 'renamed', id: guest.you, name: 'Ana', outfit: red },
      ]);
      world.tick();
      // No leave and no join: one figure, a new name.
      expect(leftIds(watcher.connection.take())).toEqual([]);
      for (const c of [guest.connection, tab.connection]) {
        expect(ofType(c.messages, 'identity').at(-1)).toEqual({
          type: 'identity',
          guest: false,
          unseen: false,
          name: 'Ana',
          outfit: red,
        });
      }
      expect(world.stateOf('ana')).toMatchObject({ x: 5 });
      expect(world.who(guest.account.userId)).toBeNull();
      world.disconnect(guest.id);
      expect(saved).toEqual([]);
      world.disconnect(tab.id);
      world.tick();
      // Its place is saved from now on, under the account.
      expect(saved).toEqual([['ana', { ...here, x: 5 }]]);
    });

    test('a hidden guest who joins is seen after all', async () => {
      const { join, move, world } = setup({ guestsPerAddress: 0 });
      const guest = join(null);
      await move(guest.id, { x: 5 });
      expect(world.stateOf(guest.account.userId)).toBeNull();
      world.signedIn(guest.account.userId, { userId: 'ana', name: 'Ana', outfit }, 't');
      expect(ofType(guest.connection.messages, 'identity').at(-1)?.unseen).toBe(false);
      await move(guest.id, { x: 6 });
      expect(world.stateOf('ana')).toMatchObject({ x: 6 });
    });

    test('signing in as someone already on the map joins their figure', async () => {
      const { join, move, world } = setup();
      const watcher = join('w');
      const phone = join('ana');
      await move(phone.id, { x: 9 });
      const guest = join(null);
      await move(guest.id, { x: 5 });
      world.tick();
      watcher.connection.take();
      guest.connection.take();
      world.signedIn(guest.account.userId, { userId: 'ana', name: 'Ana', outfit }, 't');
      const heard = guest.connection.take();
      expect(heard.find((m) => m.type === 'welcome')).toEqual({ type: 'welcome', you: phone.you });
      expect(ofType(heard, 'placed')).toEqual([
        { type: 'placed', id: phone.you, state: { ...here, x: 9 } },
      ]);
      expect(ofType(guest.connection.messages, 'driving')).toEqual([]);
      world.tick();
      expect(leftIds(watcher.connection.take())).toEqual([guest.you]);
      await world.receive(guest.id, encodeClientMessage({ type: 'drive' }));
      await move(guest.id, { x: 10 });
      expect(world.stateOf('ana')?.x).toBe(10);
    });

    test('signing in with no figure out there does nothing', () => {
      const { world } = setup();
      world.signedIn('guest:gone', { userId: 'ana', name: 'Ana', outfit }, 't');
      expect(world.size).toBe(0);
    });

    test('signing out: back to the same figure, as the guest', async () => {
      const { join, move, world, saved } = setup();
      const watcher = join('w');
      const ana = join('ana', { session: 's' });
      await move(ana.id, { x: 5 });
      world.tick();
      watcher.connection.take();
      const guest: Account = { userId: 'guest:g', name: 'Sunny Otter', outfit, guest: true };
      world.signedOut('ana', 's', guest);
      expect(watcher.connection.take()).toEqual([
        { type: 'renamed', id: ana.you, name: 'Sunny Otter', outfit },
      ]);
      world.tick();
      expect(saved).toEqual([['ana', { ...here, x: 5 }]]);
      expect(leftIds(watcher.connection.take())).toEqual([]);
      expect(world.who('guest:g')?.name).toBe('Sunny Otter');
      expect(ofType(ana.connection.messages, 'identity').at(-1)).toMatchObject({ guest: true });
      expect(world.who('ana')).toBeNull();
    });

    test('signing out on one device leaves the player signed in on the other', async () => {
      const { join, move, world } = setup();
      const watcher = join('w');
      const laptop = join('ana', { session: 'laptop' });
      const phone = join('ana', { session: 'phone' });
      await move(laptop.id, { x: 5 });
      world.tick();
      watcher.connection.take();
      laptop.connection.take();
      const guest: Account = { userId: 'guest:g', name: 'Sunny Otter', outfit, guest: true };
      world.signedOut('ana', 'laptop', guest);
      // The laptop is a guest somewhere new; the phone still drives Ana.
      expect(ofType(laptop.connection.messages, 'welcome').at(-1)?.you).not.toBe(phone.you);
      expect(ofType(laptop.connection.messages, 'identity').at(-1)).toMatchObject({ guest: true });
      expect(world.who('ana')?.name).toBe('ANA');
      await move(phone.id, { x: 6 });
      expect(world.stateOf('ana')?.x).toBe(6);
    });

    test('signing out with this browser’s guest out there joins it', async () => {
      const { join, move, world } = setup();
      const ana = join('ana', { session: 's' });
      await move(ana.id, { x: 1 });
      const tab = join(null);
      await move(tab.id, { x: 2 });
      const heard = tab.connection.messages.length;
      world.signedOut('ana', 's', tab.account);
      expect(ofType(ana.connection.messages, 'identity').at(-1)?.name).toBe(tab.account.name);
      expect(tab.connection.messages.slice(heard).some((m) => m.type === 'identity')).toBe(false);
    });

    test('signing out a session that isn’t here does nothing', async () => {
      const { join, world } = setup();
      const ana = join('ana', { session: 's' });
      const guest: Account = { userId: 'guest:g', name: 'G', outfit, guest: true };
      world.signedOut('ana', 'other', guest);
      world.signedOut('nobody', 'other', guest);
      expect(world.who('ana')?.name).toBe('ANA');
      expect(ana.connection.closed).toBeNull();
    });

    test('a guest over the cap on signing out goes unseen', async () => {
      const { join, move, world } = setup({ guestsPerAddress: 1 });
      join(null, { address: 'x' });
      const ana = join('ana', { session: 's', address: 'x' });
      await move(ana.id, { x: 5 });
      world.tick();
      const guest: Account = { userId: 'guest:g', name: 'G', outfit, guest: true };
      world.signedOut('ana', 's', guest);
      expect(ofType(ana.connection.messages, 'identity').at(-1)?.unseen).toBe(true);
      expect(world.stateOf('guest:g')).toBeNull();
    });
  });

  test('being signed in over closes every socket of the player, free to reconnect', async () => {
    const { world, join, move } = setup();
    const ana = join('ana');
    const bo = join('bo');
    await move(ana.id);
    world.tick();
    bo.connection.take();
    world.drop('ana');
    expect(ana.connection.closed).toEqual({ code: CLOSE_SIGNED_OUT, reason: 'Signed out' });
    world.tick();
    expect(leftIds(bo.connection.take())).toEqual([ana.you]);
    expect(world.stateOf('ana')).toBeNull();
    // Nobody online by that name: nothing to do.
    world.drop('nobody');
  });

  test('a new outfit reaches those who see them, and whoever comes later', async () => {
    const { join, move, world } = setup();
    const a = join('a');
    const b = join('b');
    await move(a.id);
    world.tick();
    a.connection.take();
    b.connection.take();
    const red = { ...outfit, shirt: 0xff0000 };
    world.setOutfit('a', red);
    world.setOutfit('nobody', red);
    expect(b.connection.take()).toEqual([{ type: 'outfit', id: a.you, outfit: red }]);
    expect(a.connection.take()).toEqual([{ type: 'outfit', id: a.you, outfit: red }]);
    const c = join(null);
    world.tick();
    expect(ofType(c.connection.take(), 'joins')[0]?.players[0]?.outfit).toEqual(red);
  });

  test('a new name is heard by whoever can see them, and by their own tabs', async () => {
    const { join, move, world } = setup();
    const a = join('a');
    await move(a.id);
    const b = join('b');
    world.tick();
    world.tick();
    a.connection.take();
    b.connection.take();
    world.setName('a', 'Anna');
    world.setName('nobody', 'Anna');
    expect(ofType(b.connection.take(), 'renamed')).toEqual([
      { type: 'renamed', id: a.you, name: 'Anna', outfit },
    ]);
    expect(ofType(a.connection.messages, 'identity')).toEqual([
      { type: 'identity', guest: false, unseen: false, name: 'Anna', outfit },
    ]);
    expect(world.who('a')?.name).toBe('Anna');
    const c = join('c');
    world.tick();
    world.tick();
    expect(ofType(c.connection.take(), 'joins')[0]?.players[0]?.name).toBe('Anna');
  });

  test('a connection that throws on send does not stop the others', async () => {
    const { join, move, world } = setup();
    const broken = join('broken');
    broken.connection.send = () => {
      throw new Error('closed');
    };
    const b = join('b');
    b.connection.take();
    await move(broken.id);
    const c = join('c');
    await move(c.id);
    world.tick();
    expect(joinedIds(b.connection.take()).toSorted()).toEqual([broken.you, c.you].toSorted());
  });

  test('a client too slow to keep up misses frames, then starts over', async () => {
    const { join, move, world, advance } = setup();
    const a = join('a');
    const slow = join('slow');
    await move(a.id);
    world.tick();
    slow.connection.take();
    slow.connection.queued = 100_000;
    advance(1000);
    await move(a.id, { x: 11 });
    world.tick();
    expect(slow.connection.take()).toEqual([]);
    expect(slow.connection.closed).toBeNull();
    // Still draining: nothing yet, however far it has fallen behind.
    slow.connection.queued = 20_000;
    advance(1000);
    await move(a.id, { x: 12 });
    world.tick();
    expect(slow.connection.take()).toEqual([]);
    // Caught up: told to forget everyone, then who is here, as they are.
    slow.connection.queued = 0;
    world.tick();
    const heard = slow.connection.take();
    expect(heard[0]).toEqual({ type: 'welcome', you: slow.you });
    expect(joinedIds(heard)).toEqual([a.you]);
    expect(ofType(heard, 'joins')[0]?.players[0]?.state.x).toBe(12);
  });

  test('a socket that drops a frame is treated as behind', async () => {
    const { join, move, world } = setup();
    const a = join('a');
    const b = join('b');
    await move(a.id);
    world.tick();
    b.connection.take();
    b.connection.dropping = true;
    await move(a.id, { x: 11 });
    world.tick();
    b.connection.dropping = false;
    world.tick();
    expect(b.connection.take()[0]).toEqual({ type: 'welcome', you: b.you });
  });

  test('whoever comes later hears how many are on the map', async () => {
    const { join, move, world } = setup();
    const a = join('a');
    await move(a.id);
    for (let i = 0; i < 10; i++) world.tick();
    const late = join(null);
    for (let i = 0; i < 10; i++) world.tick();
    expect(ofType(late.connection.take(), 'online')).toEqual([{ type: 'online', count: 1 }]);
  });

  test('how many are on the map goes out every so often, when it changed', async () => {
    const { join, move, world } = setup();
    const a = join('a');
    const guest = join(null);
    await move(a.id);
    for (let i = 0; i < 10; i++) world.tick();
    expect(ofType(guest.connection.take(), 'online')).toEqual([{ type: 'online', count: 1 }]);
    for (let i = 0; i < 10; i++) world.tick();
    expect(ofType(guest.connection.take(), 'online')).toEqual([]);
  });

  test('the full map gets everyone as dots, only while it is open', async () => {
    const { join, move, world } = setup();
    const a = join('a');
    const far = join('far');
    const viewer = join(null);
    await move(a.id, { x: 10, z: 20 });
    await move(far.id, { x: CELL_SIZE * 3, z: 20 });
    await world.receive(viewer.id, encodeClientMessage({ type: 'dots', on: true }));
    for (let i = 0; i < 20; i++) world.tick();
    const [dots] = ofType(viewer.connection.take(), 'dots');
    expect(dots?.players.map((p) => p.id).toSorted()).toEqual([a.you, far.you].toSorted());
    expect(dots?.players[0]?.colour).toBe(outfit.shirt);
    await world.receive(viewer.id, encodeClientMessage({ type: 'dots', on: false }));
    for (let i = 0; i < 20; i++) world.tick();
    expect(ofType(viewer.connection.take(), 'dots')).toEqual([]);
  });

  test('after the first move a figure nearby goes as a delta; a leave forgets it', async () => {
    const { join, move, world, advance } = setup();
    const a = join('a');
    const b = join('b');
    await move(a.id, { x: 10 });
    await move(b.id);
    world.tick();
    b.connection.take();
    const entries = async (x: number) => {
      advance(100);
      await move(a.id, { x });
      world.tick();
      return ofType(b.connection.take(), 'moves')[0]!.players[0]!;
    };
    expect('state' in (await entries(10.5))).toBe(true);
    expect('delta' in (await entries(11))).toBe(true);
    // Too far for a delta: whole again, and on from there.
    expect('state' in (await entries(18))).toBe(true);
    expect('delta' in (await entries(18.5))).toBe(true);
    // Gone and back: it starts from a whole move again.
    world.disconnect(a.id);
    world.tick();
    b.connection.take();
    const back = join('a');
    await move(back.id, { x: 31 });
    world.tick();
    b.connection.take();
    advance(100);
    await move(back.id, { x: 31.5 });
    world.tick();
    expect('state' in ofType(b.connection.take(), 'moves')[0]!.players[0]!).toBe(true);
  });

  test('a client that fell behind starts its deltas over', async () => {
    const { join, move, world, advance } = setup();
    const a = join('a');
    const b = join('b');
    await move(a.id, { x: 10 });
    world.tick();
    advance(100);
    await move(a.id, { x: 10.5 });
    world.tick();
    b.connection.take();
    b.connection.queued = 100_000;
    advance(100);
    await move(a.id, { x: 11 });
    world.tick();
    b.connection.queued = 0;
    world.tick();
    b.connection.take();
    advance(100);
    await move(a.id, { x: 11.5 });
    world.tick();
    expect('state' in ofType(b.connection.take(), 'moves')[0]!.players[0]!).toBe(true);
  });

  test('sliced, every client still hears each move once a round', async () => {
    const { join, move, look, world, advance } = setup({ slices: 2 });
    const a = join('a');
    const b = join('b');
    const guest = join(null);
    await move(a.id);
    await move(b.id);
    await look(guest.id, 10, 20);
    world.tick();
    world.tick();
    for (const c of [a, b, guest]) c.connection.take();
    advance(100);
    await move(a.id, { x: 11 });
    world.tick();
    world.tick();
    expect(movedIds(b.connection.take())).toEqual([a.you]);
    expect(movedIds(guest.connection.take())).toEqual([a.you]);
    // Heard once, not once a slice.
    world.tick();
    world.tick();
    expect(movedIds(b.connection.take())).toEqual([]);
  });

  test('a freed id waits for every slice to hear it left', async () => {
    const { join, move, world } = setup({ slices: 2 });
    const a = join('a');
    join('b');
    await move(a.id);
    world.tick();
    world.tick();
    world.disconnect(a.id);
    world.tick();
    expect(join('during').you).not.toBe(a.you);
    world.tick();
    expect(join('after').you).toBe(a.you);
  });

  test('reports its load', async () => {
    let time = 0;
    let tock = 0;
    const world = createWorld({ now: () => time, clock: () => (tock += 2) });
    const a = new FakeConnection();
    const id = world.connect(a, { userId: 'a', name: 'A', outfit });
    world.connect(new FakeConnection(), { userId: 'guest:x', name: 'G', outfit, guest: true });
    for (let i = 0; i < 100; i++) {
      time += 100;
      // eslint-disable-next-line no-await-in-loop -- ticks follow one another
      await world.receive(
        id,
        encodeClientMessage({ type: 'state', state: { ...here, x: 10 + i / 100 } }),
      );
      world.tick();
    }
    expect(world.stats()).toMatchObject({ online: 2, players: 1, tickMs: 2, tickMaxMs: 2 });
    expect(world.stats().bytesPerSecond).toBeGreaterThan(0);
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
