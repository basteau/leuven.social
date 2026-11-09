/**
 * The presence hub: who is online, where they are, and which tabs are theirs. It knows nothing of
 * sockets or SQLite: connections are a `send` and a `close`, persistence is a callback and time
 * is a clock, so tests drive it directly (server.ts wires it to Bun). What a client hears, and
 * how the frames for it are made, is broadcast.ts; here is what they are about.
 *
 * A person, signed in or a guest, is one figure on the map, however many tabs they have open:
 * a figure and a socket are separate things here. Each tab sees the map for itself, but only one,
 * the `driver`, moves the figure: the last to say it is in use, or else the newest left. A figure
 * appears with its first state, not before, so nobody pops up at a made-up spot. Signing in or out
 * changes who a figure is in place (`signedIn`, `signedOut`), so the socket and the figure carry
 * on and the others only see a new name.
 */

import * as RateLimit from '@portable/rate-limit';

import { AREA } from '../src/data/area.ts';
import type { Bounds } from '../src/data/city.ts';
import { boundsOf } from '../src/data/geometry.ts';
import { MAX_SPEED, decodeClientMessage, encodeServerMessage } from '../src/net/protocol.ts';
import type { Outfit, PlayerState, ServerMessage } from '../src/net/protocol.ts';
import { isPlace } from '../src/net/rules.ts';
import { createBroadcast } from './broadcast.ts';
import type { Figure as FigureOnTheMap, Viewer } from './broadcast.ts';

export interface Connection {
  /** Sends a frame. A socket that returns 0 dropped it, so the world knows it missed something. */
  send(frame: Uint8Array): number | void;
  close(code: number, reason: string): void;
  /** Bytes queued and not yet on the wire; none if it doesn't know. */
  buffered?(): number;
}

/** Who a figure is: an account, or a guest, whose `userId` lasts as long as their cookie. */
export interface Account {
  userId: string;
  name: string;
  outfit: Outfit;
  /** A guest: never saved, and the name isn't theirs to keep. */
  guest?: boolean;
}

/** What a socket came with, beyond who it speaks for. */
export interface ConnectOptions {
  /** Its session, if signed in: signing out ends this one, not the same player's on a phone. */
  session?: string | null;
  /** Where it connects from, for the cap on guests. */
  address?: string;
}

export interface SavedPosition {
  userId: string;
  state: PlayerState;
}

export interface WorldOptions {
  /** Milliseconds, steady enough for rate limits and save intervals. */
  now?: () => number;
  /** A precise clock (ms) for how long ticks take. */
  clock?: () => number;
  /** Keeps players' last states: every `saveEvery` while they move and when they leave, in batches. */
  save?: (saves: SavedPosition[]) => void;
  saveEvery?: number;
  /** How many guests one address can have on the map; the rest watch, unseen. */
  guestsPerAddress?: number;
  /** Messages a connection may send: a 10 Hz client with room for bursts of big changes. */
  rate?: { limit: number; period: number; burst?: number };
  /** Where a figure may stand; anything outside is pulled to the nearest edge. */
  area?: readonly Bounds[];
  /**
   * How many `tick`s make one round: each sends to a share of the clients, so writing to a
   * thousand sockets is spread over the 100 ms instead of done in one go. Every client still
   * hears once a round.
   */
  slices?: number;
}

/** How the hub is doing, for /api/health and load tests. */
export interface WorldStats {
  /** Connections open, guests included. */
  online: number;
  /** Those on the map. */
  players: number;
  /** The mean and the longest tick (ms) of the last few seconds. */
  tickMs: number;
  tickMaxMs: number;
  /** What the last few seconds sent, per second. */
  bytesPerSecond: number;
}

export interface World {
  /** Admits a socket as the person it speaks for and returns its id, or 0 when refused. */
  connect(connection: Connection, account: Account, options?: ConnectOptions): number;
  /** A message from a connection; resolves once it has been applied or dropped. */
  receive(id: number, data: string | Uint8Array): Promise<void>;
  disconnect(id: number): void;
  /** Someone signed in over them: every socket of theirs off the map, to reconnect if they may. */
  drop(userId: string): void;
  /**
   * A guest (`guestKey`, their `userId`) signed in as `account`: the same figure carries on
   * under the account's name, or, if the account is on the map already, their tabs join that one.
   */
  signedIn(guestKey: string, account: Account, session: string | null): void;
  /** One session of a player ended: its tabs are `guest` again, whoever else is still signed in. */
  signedOut(userId: string, session: string | null, guest: Account): void;
  /** Who is online under `userId` as the world knows them, the guests' names made unique. */
  who(userId: string): Account | null;
  /** A player changed colours; whoever can see them hears it if they are online. */
  setOutfit(userId: string, outfit: Outfit): void;
  /** A player took another name; their tabs and whoever can see them hear it if they are online. */
  setName(userId: string, name: string): void;
  /** Where a player is now, a guest also for a while after they left; null when neither. */
  stateOf(userId: string): PlayerState | null;
  /** Sends what changed since the last tick and saves the ones due. */
  tick(): void;
  /** Saves every player online, for a shutdown. */
  flush(): void;
  stats(): WorldStats;
  /** Connections open, guests included. */
  readonly size: number;
}

/** A person on the map: one, however many tabs they have open. */
interface Figure extends FigureOnTheMap {
  account: Account;
  /** Over the cap on guests from one address: nobody sees them. */
  hidden: boolean;
  /** Where it came from: counts against the address while a guest. */
  address: string;
  /** When `state` was accepted (ms). */
  movedAt: number;
  /** Counts its moves: a tab that follows it is told whenever it hasn't heard the latest. */
  moves: number;
  /** Went into a room or out, or changed floor, since the last tick. */
  replaced: boolean;
  /** Moved since the last save. */
  unsaved: boolean;
  savedAt: number;
  /** Every open tab of this person. */
  tabs: Set<Client>;
  /** The one that moves the figure. Only empty for the moment a figure is being made or retired. */
  driver: Client | null;
}

/** One socket: a tab's view of the map. */
interface Client {
  id: number;
  connection: Connection;
  figure: Figure;
  /** The session it is signed in by, if any. */
  session: string | null;
  /** Its side of the broadcast: who it hears of. */
  viewer: Viewer;
  /** The last of its figure's `moves` it heard, when it follows from another tab. */
  heardMove: number;
}

/** A socket closed because its session ended: the client may reconnect, as whoever it now is. */
export const CLOSE_SIGNED_OUT = 4002;
const TURN = Math.PI * 2;
const MIN_FLOOR = -4;
const MAX_FLOOR = 20;
/** Refused for good; 1008 is the code the client won't retry. */
const CLOSE_TURNED_AWAY = 1008;
/** Faster than anyone goes (m/s): a figure can't get further than this between two messages. */
const TOP_SPEED = 30;
/** Slack for a door's few metres, and a stutter of the network. */
const MOVE_SLACK = 8;
/** The longest a pause (s) can earn, so a tab left alone doesn't get a free teleport. */
const MOST_ELAPSED = 5;
/** How often the count of players goes out when it changed (rounds). */
const ONLINE_ROUNDS = 10;
/** How often forgotten guests are cleared out (rounds). */
const FORGET_TICKS = 300;
/** How many ticks /api/health averages over. */
const STATS_TICKS = 100;
/** How many tabs one person can have open; the next is turned away (1008), not an old one. */
const MOST_TABS = 16;
/** A guest's position is remembered this long after they left (ms): a reload, or a short break. */
const GUEST_REMEMBERED = 10 * 60 * 1000;
const MOST_REMEMBERED = 2048;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A state as the server will keep it: inside the map, in range, with a room id or none. */
export function sanitise(state: PlayerState, area: readonly Bounds[] = AREA): PlayerState {
  let x = state.x;
  let z = state.z;
  let best = Infinity;
  for (const b of area) {
    const cx = clamp(state.x, b.minX, b.maxX);
    const cz = clamp(state.z, b.minZ, b.maxZ);
    const d = Math.hypot(cx - state.x, cz - state.z);
    if (d < best) [best, x, z] = [d, cx, cz];
  }
  const place = isPlace(state.place) ? state.place : '';
  const h = state.heading;
  // Left exactly as sent when already in range: a rewrapped float would never compare equal.
  const heading = h >= 0 && h < TURN ? h : Number.isFinite(h) ? ((h % TURN) + TURN) % TURN : 0;
  return {
    x,
    z,
    heading,
    speed: Number.isFinite(state.speed) ? clamp(state.speed, 0, MAX_SPEED) : 0,
    mode: state.mode === 'bike' ? 'bike' : 'foot',
    place,
    // In the street, the ground or the one level of decks and tunnels; a room has its floors.
    floor: !Number.isFinite(state.floor)
      ? 0
      : place
        ? clamp(Math.round(state.floor), MIN_FLOOR, MAX_FLOOR)
        : state.floor === 1
          ? 1
          : 0,
  };
}

const same = (a: PlayerState, b: PlayerState) =>
  a.x === b.x &&
  a.z === b.z &&
  a.heading === b.heading &&
  a.speed === b.speed &&
  a.mode === b.mode &&
  a.place === b.place &&
  a.floor === b.floor;

/**
 * `next`, no further from `from` than `seconds` at top speed allow: a client can't teleport. A door
 * is the one thing that moves a figure at once, and it changes room or floor inside one, so it
 * passes. Stepping onto a deck or down a tunnel is the street's floor changing with a walker's own
 * stride (`levelAt` in walkable.ts), so it is clamped like any other step.
 */
export function withinReach(from: PlayerState, next: PlayerState, seconds: number): PlayerState {
  if (from.place !== next.place || (next.place !== '' && from.floor !== next.floor)) return next;
  const [dx, dz] = [next.x - from.x, next.z - from.z];
  const distance = Math.hypot(dx, dz);
  const most = TOP_SPEED * clamp(seconds, 0, MOST_ELAPSED) + MOVE_SLACK;
  if (distance <= most) return next;
  const share = most / distance;
  return { ...next, x: from.x + dx * share, z: from.z + dz * share };
}

export function createWorld(options: WorldOptions = {}): World {
  const now = options.now ?? Date.now;
  const clock = options.clock ?? (() => performance.now());
  const save = options.save ?? (() => {});
  const saveEvery = options.saveEvery ?? 15_000;
  const area = options.area ?? AREA;
  const bounds = boundsOf(area);
  const slices = Math.max(1, options.slices ?? 1);
  const limiter = RateLimit.create(options.rate ?? { limit: 20, period: 1000, burst: 40 });
  const guestsPerAddress = options.guestsPerAddress ?? Number.POSITIVE_INFINITY;
  const broadcast = createBroadcast({ bounds, slices });
  const clients = new Map<number, Client>();
  /** Everyone online, by account or guest id. */
  const people = new Map<string, Figure>();
  /** Guests' names in use, so no two online are the same. */
  const guestNames = new Set<string>();
  /** How many guests each address has on the map. */
  const guestsFrom = new Map<string, number>();
  /** Guests who left a moment ago and where. */
  const remembered = new Map<string, { state: PlayerState; at: number }>();
  /** Those who left since the last tick, still on the map for whoever saw them. */
  const departed: Figure[] = [];
  /** Who left and which tick every client will have heard so by. */
  const leaving: { id: number; after: number }[] = [];
  /** Ids free to use again. */
  const freeIds: number[] = [];
  const saves: SavedPosition[] = [];
  let lastId = 0;
  let lastSocket = 0;
  let tickCount = 0;
  const stats = { ticks: 0, busy: 0, longest: 0, bytes: 0, since: 0 };
  let report: WorldStats = { online: 0, players: 0, tickMs: 0, tickMaxMs: 0, bytesPerSecond: 0 };

  const nextId = () => freeIds.pop() ?? ++lastId;

  const deliver = (client: Client, frame: Uint8Array) => broadcast.deliver(client.viewer, frame);

  /** Delivers one frame, encoded once, to everyone who sees `player`. */
  const toSeers = (player: Figure, message: ServerMessage) => {
    broadcast.toSeers(player, encodeServerMessage(message));
  };

  const persist = (figure: Figure) => {
    if (figure.account.guest || !figure.state || !figure.unsaved) return;
    saves.push({ userId: figure.account.userId, state: figure.state });
    figure.unsaved = false;
    figure.savedAt = now();
  };

  /** A name no other guest online has: the same one again, unless someone else holds it now. */
  const freeName = (name: string) => {
    let free = name;
    for (let n = 2; guestNames.has(free); n++) free = `${name} ${n}`;
    return free;
  };

  /** Writes who a figure is, reserving a guest's unique name, and counting them on their address. */
  const becomeWho = (figure: Figure, account: Account) => {
    if (account.guest) {
      const count = guestsFrom.get(figure.address) ?? 0;
      figure.hidden = count >= guestsPerAddress;
      figure.account = { ...account, name: freeName(account.name) };
      guestNames.add(figure.account.name);
      if (!figure.hidden) guestsFrom.set(figure.address, count + 1);
    } else {
      figure.hidden = false;
      figure.account = account;
    }
    people.set(figure.account.userId, figure);
  };

  /** Lets go of who it was: a guest's name and their place on their address's count. */
  const stopBeing = (figure: Figure) => {
    const { account, address, hidden } = figure;
    people.delete(account.userId);
    if (!account.guest) return;
    guestNames.delete(account.name);
    if (hidden) return;
    const count = guestsFrom.get(address) ?? 0;
    if (count <= 1) guestsFrom.delete(address);
    else guestsFrom.set(address, count - 1);
    if (count === guestsPerAddress) letIn(address);
  };

  /** Room on an address: the first of its guests still watching unseen goes on the map. */
  const letIn = (address: string) => {
    for (const figure of people.values()) {
      if (!figure.hidden || figure.address !== address) continue;
      figure.hidden = false;
      guestsFrom.set(address, (guestsFrom.get(address) ?? 0) + 1);
      for (const tab of figure.tabs) introduce(tab);
      return;
    }
  };

  /** The last tab of a figure went. It leaves the map; a guest is remembered a while. */
  const retire = (figure: Figure) => {
    persist(figure);
    if (figure.account.guest && figure.state) {
      remembered.delete(figure.account.userId);
      remembered.set(figure.account.userId, { state: figure.state, at: now() });
      if (remembered.size > MOST_REMEMBERED) {
        remembered.delete(remembered.keys().next().value!);
      }
    }
    stopBeing(figure);
    broadcast.remove(figure);
    departed.push(figure);
  };

  /** Says to a socket who it speaks for and whether it moves the figure. */
  const introduce = (client: Client) => {
    const { account, hidden, driver, id, state } = client.figure;
    deliver(
      client,
      encodeServerMessage({
        type: 'identity',
        guest: Boolean(account.guest),
        unseen: hidden,
        name: account.name,
        outfit: account.outfit,
      }),
    );
    deliver(client, encodeServerMessage({ type: 'driving', on: driver === client }));
    if (state && driver !== client) {
      deliver(client, encodeServerMessage({ type: 'placed', id, state }));
    }
  };

  /**
   * Hands the figure to `client` and tells both. The new driver hears it too: a tab that claimed
   * as it opened will just have read the "not you" sent when it connected.
   */
  const drive = (client: Client) => {
    const { figure } = client;
    if (figure.driver === client) return;
    const before = figure.driver;
    figure.driver = client;
    if (before) deliver(before, encodeServerMessage({ type: 'driving', on: false }));
    deliver(client, encodeServerMessage({ type: 'driving', on: true }));
  };

  /** A tab of `figure` closed or moved away: the newest left takes over, if it was the driver. */
  const leaveFigure = (client: Client) => {
    const { figure } = client;
    figure.tabs.delete(client);
    if (figure.driver === client) {
      figure.driver = [...figure.tabs].at(-1) ?? null;
      if (figure.driver) {
        deliver(figure.driver, encodeServerMessage({ type: 'driving', on: true }));
      }
    }
    if (figure.tabs.size === 0) retire(figure);
  };

  const removeSocket = (client: Client) => {
    clients.delete(client.id);
    broadcast.disconnect(client.viewer);
    leaveFigure(client);
  };

  const newFigure = (account: Account, address: string): Figure => {
    const figure: Figure = {
      id: nextId(),
      account,
      hidden: false,
      address,
      state: null,
      movedAt: 0,
      moves: 0,
      replaced: false,
      unsaved: false,
      savedAt: now(),
      tabs: new Set(),
      driver: null,
    };
    becomeWho(figure, account);
    return figure;
  };

  /** Moves a tab to another figure: a clean start, since "you" is someone else now. */
  const moveTab = (client: Client, into: Figure, session: string | null) => {
    leaveFigure(client);
    client.figure = into;
    client.session = session;
    into.tabs.add(client);
    into.driver ??= client;
    deliver(client, encodeServerMessage({ type: 'welcome', you: into.id }));
    broadcast.become(client.viewer, into);
    introduce(client);
    client.heardMove = into.moves;
  };

  /** The same figure, someone else: its tabs are told, and so is whoever can see it. */
  const changeWho = (figure: Figure, account: Account, session: string | null) => {
    stopBeing(figure);
    becomeWho(figure, account);
    if (figure.hidden && figure.state) {
      figure.state = null;
      broadcast.remove(figure);
    }
    if (figure.state) broadcast.update(figure);
    figure.unsaved = !account.guest && figure.state !== null;
    for (const tab of figure.tabs) {
      tab.session = session;
      introduce(tab);
    }
    toSeers(figure, {
      type: 'renamed',
      id: figure.id,
      name: figure.account.name,
      outfit: figure.account.outfit,
    });
  };

  return {
    connect(connection, account, { session = null, address = '' } = {}) {
      let figure = people.get(account.userId);
      if (figure && figure.tabs.size >= MOST_TABS) {
        connection.close(CLOSE_TURNED_AWAY, 'Too many tabs');
        return 0;
      }
      figure ??= newFigure(account, address);
      const viewer = broadcast.connect(
        figure,
        (frame) => {
          stats.bytes += frame.length;
          return connection.send(frame);
        },
        () => connection.buffered?.() ?? 0,
      );
      const client: Client = {
        id: ++lastSocket,
        connection,
        figure,
        session,
        viewer,
        heardMove: figure.moves,
      };
      clients.set(client.id, client);
      figure.tabs.add(client);
      figure.driver ??= client;
      deliver(client, encodeServerMessage({ type: 'welcome', you: figure.id }));
      introduce(client);
      return client.id;
    },

    async receive(id, data) {
      const client = clients.get(id);
      // Text frames aren't part of the protocol.
      if (!client || typeof data === 'string') return;
      const { allowed } = await limiter.take(String(id), { now: new Date(now()) });
      if (!allowed || clients.get(id) !== client) return;
      const message = decodeClientMessage(data);
      if (message?.type === 'view') {
        // Kept on the map: an empty cell a stranger looks at would still cost a list.
        broadcast.look(
          client.viewer,
          clamp(message.x, bounds.minX, bounds.maxX),
          clamp(message.z, bounds.minZ, bounds.maxZ),
          message.reach,
        );
        return;
      }
      if (message?.type === 'drive') {
        drive(client);
        return;
      }
      const { figure } = client;
      // Only the tab in use moves the figure; a guest over the cap watches.
      if (!message || figure.driver !== client || figure.hidden) return;
      const time = now();
      const sane = sanitise(message.state, area);
      const previous = figure.state;
      if (!previous) {
        figure.state = sane;
        figure.movedAt = time;
        figure.moves++;
        figure.unsaved = true;
        broadcast.update(figure);
        return;
      }
      const state = withinReach(previous, sane, (time - figure.movedAt) / 1000);
      if (same(previous, state)) return;
      figure.replaced ||= state.place !== previous.place || state.floor !== previous.floor;
      figure.state = state;
      figure.movedAt = time;
      figure.moves++;
      figure.unsaved = true;
      broadcast.update(figure);
    },

    disconnect(id) {
      const client = clients.get(id);
      if (client) removeSocket(client);
    },

    drop(userId) {
      for (const client of people.get(userId)?.tabs ?? []) {
        removeSocket(client);
        client.connection.close(CLOSE_SIGNED_OUT, 'Signed out');
      }
    },

    signedIn(guestKey, account, session) {
      const figure = people.get(guestKey);
      if (!figure) return;
      const already = people.get(account.userId);
      if (already) {
        // Signed in on a phone too, say: one figure a person, so this browser's tabs join theirs.
        for (const client of figure.tabs) moveTab(client, already, session);
        return;
      }
      changeWho(figure, account, session);
    },

    signedOut(userId, session, guest) {
      const figure = people.get(userId);
      if (!figure) return;
      const ending = [...figure.tabs].filter((c) => c.session === session);
      if (!ending.length) return;
      const figureOfGuest = people.get(guest.userId);
      if (!figureOfGuest && ending.length === figure.tabs.size) {
        persist(figure);
        changeWho(figure, guest, null);
        return;
      }
      // Others are still signed in as this player, or this browser's guest is out there already.
      const into = figureOfGuest ?? newFigure(guest, figure.address);
      for (const client of ending) moveTab(client, into, null);
    },

    who: (userId) => people.get(userId)?.account ?? null,

    setOutfit(userId, outfit) {
      const figure = people.get(userId);
      if (!figure) return;
      figure.account.outfit = outfit;
      if (figure.state) broadcast.update(figure);
      const frame = encodeServerMessage({ type: 'outfit', id: figure.id, outfit });
      for (const tab of figure.tabs) deliver(tab, frame);
      toSeers(figure, { type: 'outfit', id: figure.id, outfit });
    },

    setName(userId, name) {
      const figure = people.get(userId);
      if (!figure) return;
      figure.account = { ...figure.account, name };
      for (const tab of figure.tabs) introduce(tab);
      toSeers(figure, { type: 'renamed', id: figure.id, name, outfit: figure.account.outfit });
    },

    stateOf(userId) {
      const live = people.get(userId)?.state;
      if (live) return live;
      const left = remembered.get(userId);
      return left && now() - left.at < GUEST_REMEMBERED ? left.state : null;
    },

    tick() {
      const started = clock();
      tickCount++;
      const time = now();
      const slice = tickCount % slices;
      const round = Math.floor(tickCount / slices);

      // 1. Who is gone, and which tick every client will have heard so by.
      for (const figure of departed) {
        leaving.push({ id: figure.id, after: tickCount + slices - 1 });
      }
      departed.length = 0;

      // 2. Everyone goes where they are now, every client looks where it looks now.
      const players = broadcast.prepare(time, slice);

      // 3. Doors go before the moves, so a figure's jump reads as one; tabs follow their figure.
      for (const figure of people.values()) {
        if (figure.replaced && figure.state) {
          toSeers(figure, { type: 'placed', id: figure.id, state: figure.state });
        }
        figure.replaced = false;
        if (figure.tabs.size > 1 && figure.state) {
          let frame: Uint8Array | null = null;
          for (const tab of figure.tabs) {
            // A recount says nothing of your own figure, so a tab that was behind for its last move
            // has to hear it once it has caught up, however long after that is.
            if (tab === figure.driver) tab.heardMove = figure.moves;
            if (tab.heardMove === figure.moves || tab.viewer.behind) continue;
            if (tab.viewer.slot % slices !== slice) continue;
            frame ??= encodeServerMessage({ type: 'placed', id: figure.id, state: figure.state });
            deliver(tab, frame);
            if (!tab.viewer.behind) tab.heardMove = figure.moves;
          }
        }
        if (time - figure.savedAt >= saveEvery) persist(figure);
      }

      // 4. What this slice's clients have to hear.
      broadcast.send(round, slice);

      // 5. Now everyone has heard they went, their ids can be used again.
      while (leaving[0] && leaving[0].after <= tickCount) freeIds.push(leaving.shift()!.id);

      // 6. The rarer news: how many are here.
      if (slice === 0 && round % ONLINE_ROUNDS === 0) {
        let frame: Uint8Array | null = null;
        for (const client of clients.values()) {
          if (client.viewer.behind || client.viewer.heardOnline === players) continue;
          client.viewer.heardOnline = players;
          frame ??= encodeServerMessage({ type: 'online', count: players });
          deliver(client, frame);
        }
      }

      // Long gone guests, a few at a time, so the book can't grow.
      if (slice === 0 && round % FORGET_TICKS === 0) {
        for (const [key, left] of remembered) {
          if (time - left.at < GUEST_REMEMBERED) break;
          remembered.delete(key);
        }
      }
      // One batch, one transaction, after the sends so a slow disk can't hold up a frame.
      if (saves.length) save(saves.splice(0));

      const took = clock() - started;
      stats.ticks++;
      stats.busy += took;
      stats.longest = Math.max(stats.longest, took);
      if (stats.ticks === STATS_TICKS) {
        const elapsed = Math.max(1, time - stats.since);
        report = {
          online: clients.size,
          players,
          tickMs: stats.busy / stats.ticks,
          tickMaxMs: stats.longest,
          bytesPerSecond: Math.round((stats.bytes / elapsed) * 1000),
        };
        stats.ticks = stats.busy = stats.longest = stats.bytes = 0;
        stats.since = time;
      }
    },

    flush() {
      for (const figure of people.values()) persist(figure);
      if (saves.length) save(saves.splice(0));
    },

    stats: () => ({ ...report, online: clients.size }),

    get size() {
      return clients.size;
    },
  };
}
