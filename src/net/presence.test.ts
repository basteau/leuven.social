import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';

import { connectPresence } from './presence.ts';
import type { PresenceOptions, PresenceStatus, RemotePlayer } from './presence.ts';
import { CLOSE_REPLACED, decodeClientMessage, encodeServerMessage, quantise } from './protocol.ts';
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

async function online(options: PresenceOptions = {}) {
  const session = open(options);
  await flush();
  session.socket().accept();
  await flush();
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
    expect(log.states.length).toBe(2);
    expect(log.states[0]?.[0]).toMatchObject({ id: 6, state: { place: '', floor: 0 } });
    expect(log.states[0]?.[0]?.state.x).toBeCloseTo(1, 1);
    expect(log.states[1]).toEqual([{ id: 6, state: { ...here, place: 'stadhuis', floor: 1 } }]);
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
    second.accept();
    await flush();
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

  test('being replaced by another sign-in is final', async () => {
    const { socket, log } = await online();
    socket().hangUp(CLOSE_REPLACED, 'Signed in somewhere else');
    await advance(60_000);
    expect(FakeSocket.all.length).toBe(1);
    expect(log.statuses).toEqual(['connecting', 'online', 'replaced']);
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
