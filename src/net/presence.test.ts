import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';

import { connectPresence } from './presence.ts';
import type { Identity, PresenceOptions, PresenceStatus, RemotePlayer } from './presence.ts';
import { decodeClientMessage, encodeServerMessage, quantise } from './protocol.ts';
import type { Outfit, PlayerState, PlayerUpdate, ServerMessage } from './protocol.ts';
import { HEARTBEAT, SEND_INTERVAL } from './throttle.ts';

type Listener = (event: Event) => void;

/** Just enough of a WebSocket for @portable/websockets, driven by the test. */
class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  binaryType = 'blob';
  sent: Uint8Array[] = [];
  closedWith: number | undefined;
  private listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  addEventListener(type: string, listener: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }
  private emit(type: string, fields: Record<string, unknown> = {}) {
    const event = Object.assign(new Event(type), fields);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  send(data: Uint8Array) {
    this.sent.push(data);
  }
  close(code?: number) {
    if (this.readyState === 3) return;
    this.closedWith = code;
    this.readyState = 3;
    queueMicrotask(() => this.emit('close', { code: code ?? 1005, reason: '' }));
  }
  // What the server does:
  accept() {
    this.readyState = 1;
    this.emit('open');
  }
  deliver(message: ServerMessage | string | Uint8Array) {
    const data =
      typeof message === 'string'
        ? message
        : (message instanceof Uint8Array ? message : encodeServerMessage(message)).slice().buffer;
    this.emit('message', { data });
  }
  hangUp(code: number, reason = '') {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }
  states(): PlayerState[] {
    return this.sent.flatMap((bytes) => {
      const message = decodeClientMessage(bytes)!;
      return message.type === 'state' ? [message.state] : [];
    });
  }
}

const outfit: Outfit = { skin: 1, hair: 2, shirt: 3, shorts: 4 };
const here: PlayerState = quantise({
  x: 1,
  z: 2,
  heading: 0.5,
  speed: 1.4,
  mode: 'foot',
  place: '',
  floor: 0,
});

let time = 0;
const flush = async () => {
  // eslint-disable-next-line no-await-in-loop -- each turn lets one more promise in the socket library settle
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
const advance = async (ms: number) => {
  time += ms;
  jest.advanceTimersByTime(ms);
  await flush();
};

beforeEach(() => {
  jest.useFakeTimers();
  FakeSocket.all = [];
  time = 0;
});
afterEach(() => {
  jest.useRealTimers();
});

function open(options: PresenceOptions = {}) {
  const log = {
    statuses: [] as PresenceStatus[],
    welcomes: [] as number[],
    joins: [] as RemotePlayer[],
    leaves: [] as number[],
    onlines: [] as number[],
    dots: [] as number[][],
    states: [] as PlayerUpdate[][],
    outfits: [] as [number, Outfit][],
  };
  const presence = connectPresence({
    url: 'ws://test/ws',
    WebSocket: FakeSocket as never,
    now: () => time,
    onStatus: (s) => log.statuses.push(s),
    onWelcome: (you) => log.welcomes.push(you),
    onJoin: (players) => log.joins.push(...players),
    onLeave: (ids) => log.leaves.push(...ids),
    onOnline: (count) => log.onlines.push(count),
    onDots: (dots) => log.dots.push(dots.map((d) => d.id)),
    onStates: (players) => log.states.push(players),
    onOutfit: (id, o) => log.outfits.push([id, o]),
    ...options,
  });
  const socket = () => FakeSocket.all.at(-1)!;
  return { presence, log, socket };
}

/** A socket that says it is driving, as the first tab of a person is told. */
const serve = async (socket: FakeSocket, driving = true) => {
  socket.accept();
  await flush();
  socket.deliver({ type: 'driving', on: driving });
  await flush();
};

async function online(options: PresenceOptions = {}) {
  const session = open(options);
  await flush();
  await serve(session.socket());
  return session;
}

describe('connectPresence', () => {
  test('connects, says so, and hands over what the server sends but our own echo', async () => {
    const { log, socket, presence } = await online();
    expect(socket().url).toBe('ws://test/ws');
    expect(log.statuses).toEqual(['connecting', 'online']);

    socket().deliver({ type: 'welcome', you: 5 });
    const joined = { id: 6, name: 'Ann', outfit, state: here };
    socket().deliver({
      type: 'joins',
      players: [{ id: 5, name: 'Me', outfit, state: here }, joined],
    });
    const move = { x: 1, z: 2, heading: 0.5, speed: 1.4, mode: 'foot' } as const;
    socket().deliver({ type: 'moves', cx: 0, cz: 0, players: [{ id: 5, state: move }] });
    socket().deliver({
      type: 'moves',
      cx: 0,
      cz: 0,
      players: [
        { id: 5, state: move },
        { id: 6, state: move },
        { id: 7, state: move }, // nobody it has heard of: dropped
      ],
    });
    const follow = { x: 0, z: 0, heading: 0, speed: 0, mode: 'foot' as const };
    const base = { x: Number.NaN, z: Number.NaN, heading: 0, speed: 0 };
    const encodeMove = (x: number) =>
      encodeServerMessage({
        type: 'moves',
        cx: 0,
        cz: 0,
        players: [{ id: 6, state: { ...follow, x, z: 2, heading: 0.5, speed: 1.4 } }],
        bases: [base],
      });
    encodeMove(1); // the whole move it already heard
    socket().deliver(encodeMove(1.5));
    socket().deliver({ type: 'outfit', id: 6, outfit });
    socket().deliver({ type: 'online', count: 3 });
    socket().deliver({
      type: 'dots',
      players: [
        { id: 5, x: 0, z: 0, colour: 1 },
        { id: 6, x: 0, z: 0, colour: 1 },
      ],
    });
    socket().deliver({ type: 'placed', id: 6, state: { ...here, place: 'stadhuis', floor: 1 } });
    socket().deliver({ type: 'leaves', ids: [6] });
    socket().deliver('a text frame');
    socket().deliver(new Uint8Array([99, 1, 2]));
    await flush();

    expect(log.welcomes).toEqual([5]);
    expect(log.joins).toEqual([joined]);
    expect(log.states.length).toBe(3);
    expect(log.states[0]?.[0]).toMatchObject({ id: 6, state: { place: '', floor: 0 } });
    expect(log.states[0]?.[0]?.state.x).toBeCloseTo(1, 1);
    expect(log.states[1]?.[0]?.state.x).toBeCloseTo(1.5, 1);
    expect(log.states[1]?.[0]?.state.heading).toBeCloseTo(0.5, 2);
    expect(log.states[2]).toEqual([{ id: 6, state: { ...here, place: 'stadhuis', floor: 1 } }]);
    expect(log.outfits).toEqual([[6, outfit]]);
    expect(log.leaves).toEqual([6]);
    expect(log.onlines).toEqual([3]);
    expect(log.dots).toEqual([[6]]);
    presence.close();
  });

  test('sends at most ten times a second, a big change at once, and a heartbeat when idle', async () => {
    const { presence, socket } = await online();
    presence.send(here);
    expect(socket().states()).toEqual([here]);

    await advance(10);
    presence.send({ ...here, x: 1.5 });
    presence.send({ ...here, x: 2 });
    expect(socket().sent.length).toBe(1);
    await advance(SEND_INTERVAL - 10);
    expect(socket().states().at(-1)).toMatchObject({ x: 2 });

    presence.send({ ...here, x: 2, mode: 'bike' });
    expect(socket().states().at(-1)).toMatchObject({ mode: 'bike' });
    const count = socket().sent.length;

    await advance(HEARTBEAT - 1);
    expect(socket().sent.length).toBe(count);
    await advance(1);
    expect(socket().sent.length).toBe(count + 1);
    presence.close();
  });

  test('sends nothing while disconnected, and the latest state on reconnecting', async () => {
    const { presence, socket, log } = await online();
    presence.send(here);
    const first = socket();
    first.hangUp(1006);
    await flush();
    expect(log.statuses).toEqual(['connecting', 'online', 'offline']);

    presence.send({ ...here, x: 40 });
    await advance(SEND_INTERVAL);
    expect(first.sent.length).toBe(1);

    await advance(2000);
    const second = socket();
    expect(second).not.toBe(first);
    expect(second.sent).toEqual([]);
    await serve(second);
    expect(log.statuses.at(-1)).toBe('online');
    expect(second.states()).toEqual([{ ...here, x: 40 }]);
    presence.close();
  });

  test('a reconnect before anything was sent sends nothing', async () => {
    const { presence, socket } = await online();
    socket().hangUp(1001);
    await advance(2000);
    socket().accept();
    await flush();
    expect(socket().sent).toEqual([]);
    presence.close();
  });

  test('a server that turns us away for good is closed', async () => {
    const { socket, log } = await online();
    socket().hangUp(1008, 'Policy');
    await advance(60_000);
    expect(FakeSocket.all.length).toBe(1);
    expect(log.statuses.at(-1)).toBe('closed');
  });

  test('close() hangs up for good', async () => {
    const { presence, socket, log } = await online();
    presence.send(here);
    presence.close();
    await advance(60_000);
    expect(socket().closedWith).toBe(1000);
    expect(FakeSocket.all.length).toBe(1);
    expect(log.statuses).toEqual(['connecting', 'online', 'closed']);
    presence.send({ ...here, x: 9 });
    expect(socket().sent.length).toBe(1);
  });

  test.each([
    ['https:', 'wss:'],
    ['http:', 'ws:'],
  ])('on an %s page, connects to /ws on its origin over %s', async (protocol, scheme) => {
    const page = globalThis as { location?: unknown };
    page.location = { protocol, host: 'leuven.example:8443' };
    try {
      const { presence } = open({ url: undefined });
      await flush();
      expect(FakeSocket.all.at(-1)?.url).toBe(`${scheme}//leuven.example:8443/ws`);
      presence.close();
    } finally {
      delete page.location;
    }
  });

  describe('one figure, moved from one tab at a time', () => {
    test('a tab that isn’t the one driving sends no state, and goes on from where the figure went', async () => {
      const followed: PlayerState[] = [];
      const session = open({ onOwn: (s) => followed.push(s) });
      await flush();
      await serve(session.socket(), false);
      const { presence, socket } = session;
      socket().deliver({ type: 'welcome', you: 5 });
      await flush();
      presence.send(here);
      await advance(SEND_INTERVAL);
      expect(socket().states()).toEqual([]);

      const moved = { ...here, x: 44, z: 55 };
      socket().deliver({ type: 'placed', id: 5, state: moved });
      await flush();
      expect(followed).toEqual([moved]);

      // Told to drive (the other tab closed): the figure carries on from where it was.
      socket().deliver({ type: 'driving', on: true });
      await flush();
      expect(socket().states()).toEqual([moved]);
      presence.close();
    });

    test('drive() takes over at once, and says so', async () => {
      const session = open();
      await flush();
      await serve(session.socket(), false);
      const { presence, socket } = session;
      presence.send(here);
      presence.drive();
      await flush();
      expect(socket().sent.map((b) => decodeClientMessage(b)?.type)).toEqual(['drive', 'state']);
      // Already driving: nothing more to say.
      presence.drive();
      await flush();
      expect(socket().sent.length).toBe(2);
      presence.close();
    });

    test('drive() before a socket is up does nothing yet', async () => {
      const { presence, socket } = open();
      await flush();
      presence.drive();
      await flush();
      expect(socket().sent).toEqual([]);
      presence.close();
    });

    test('losing the drive stops the state going out', async () => {
      const { presence, socket } = await online();
      presence.send(here);
      expect(socket().states()).toEqual([here]);
      socket().deliver({ type: 'driving', on: false });
      await flush();
      presence.send({ ...here, x: 50 });
      await advance(SEND_INTERVAL * 3);
      expect(socket().states()).toEqual([here]);
      // A figure update for ourselves while driving is just old news.
      presence.drive();
      await flush();
      socket().deliver({ type: 'placed', id: 0, state: { ...here, x: 99 } });
      await flush();
      expect(socket().states().at(-1)?.x).not.toBe(99);
      presence.close();
    });

    test('the tab in use claims its figure as soon as the socket opens', async () => {
      const { presence, socket } = open({ inUse: () => true });
      presence.send(here);
      await flush();
      socket().accept();
      await flush();
      expect(socket().sent.map((b) => decodeClientMessage(b)?.type)).toEqual(['drive', 'state']);
      presence.close();
    });

    test('claiming as it opens survives the server’s earlier “not you”', async () => {
      const { presence, socket } = open({ inUse: () => true });
      presence.send(here);
      await flush();
      socket().accept();
      await flush();
      expect(socket().states()).toEqual([here]);
      // Sent on connecting, before the claim reached the server; then its answer to the claim.
      socket().deliver({ type: 'driving', on: false });
      await flush();
      presence.send({ ...here, x: 30 });
      await advance(SEND_INTERVAL);
      expect(socket().states()).toEqual([here]);
      socket().deliver({ type: 'driving', on: true });
      await flush();
      expect(socket().states().at(-1)?.x).toBeCloseTo(30, 3);
      presence.close();
    });

    test('a tab not in use waits to be told', async () => {
      const { presence, socket } = open({ inUse: () => false });
      presence.send(here);
      await flush();
      socket().accept();
      await flush();
      expect(socket().sent).toEqual([]);
      presence.close();
    });
  });

  test('tells who we are, and who a figure has become', async () => {
    const identities: Identity[] = [];
    const renames: [number, string, Outfit][] = [];
    const { presence, socket } = await online({
      onIdentity: (identity) => identities.push(identity),
      onRenamed: (id, name, o) => renames.push([id, name, o]),
    });
    socket().deliver({ type: 'welcome', you: 5 });
    const identity = { guest: true, unseen: false, name: 'Guest Sunny Otter', outfit };
    socket().deliver({ type: 'identity', ...identity });
    await flush();
    expect(identities).toEqual([{ type: 'identity', ...identity }] as never);
    socket().deliver({ type: 'renamed', id: 5, name: 'Me', outfit });
    socket().deliver({ type: 'renamed', id: 7, name: 'Ann', outfit });
    await flush();
    expect(renames).toEqual([[7, 'Ann', outfit]]);
    presence.close();
  });

  test('works without any callbacks', async () => {
    const presence = connectPresence({ url: 'ws://test/ws', WebSocket: FakeSocket as never });
    await flush();
    FakeSocket.all.at(-1)!.accept();
    await flush();
    FakeSocket.all.at(-1)!.deliver({ type: 'welcome', you: 1 });
    FakeSocket.all.at(-1)!.deliver({
      type: 'joins',
      players: [{ id: 2, name: 'A', outfit, state: here }],
    });
    FakeSocket.all.at(-1)!.deliver({
      type: 'moves',
      cx: 0,
      cz: 0,
      players: [{ id: 2, state: here }],
    });
    FakeSocket.all.at(-1)!.deliver({ type: 'outfit', id: 2, outfit });
    FakeSocket.all.at(-1)!.deliver({ type: 'leaves', ids: [2] });
    presence.send(here);
    await flush();
    presence.close();
  });

  test('says where the map looks, only as it moves, and again on reconnecting', async () => {
    const { presence, socket } = await online();
    const views = () =>
      socket().sent.flatMap((bytes) => {
        const m = decodeClientMessage(bytes)!;
        return m.type === 'view' ? [[m.x, m.z]] : [];
      });
    presence.view(10, 10);
    expect(views()).toEqual([[10, 10]]);
    // A few metres aren't worth saying.
    await advance(1000);
    presence.view(15, 10);
    expect(views()).toEqual([[10, 10]]);
    // Forty are, at once if it's been long enough.
    presence.view(60, 10);
    expect(views()).toEqual([
      [10, 10],
      [60, 10],
    ]);
    // Moving on quickly: the latest, a moment later.
    presence.view(120, 10);
    expect(views().length).toBe(2);
    await advance(300);
    expect(views().at(-1)).toEqual([120, 10]);

    socket().hangUp(1006);
    await flush();
    await advance(2000);
    socket().accept();
    await flush();
    expect(views()).toEqual([[120, 10]]);
    presence.close();
  });

  test('asks for the full map’s dots while it is open, and again on reconnecting', async () => {
    const { presence, socket } = await online();
    const asked = () =>
      socket().sent.flatMap((bytes) => {
        const m = decodeClientMessage(bytes)!;
        return m.type === 'dots' ? [m.on] : [];
      });
    presence.dots(true);
    await flush();
    expect(asked()).toEqual([true]);
    socket().hangUp(1006);
    await flush();
    await advance(2000);
    socket().accept();
    await flush();
    expect(asked()).toEqual([true]);
    presence.dots(false);
    await flush();
    expect(asked()).toEqual([true, false]);
    presence.close();
  });
});
