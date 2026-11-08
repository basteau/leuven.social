/**
 * The presence hub: who is online, where they are, and who needs to hear about it. It knows
 * nothing of sockets or SQLite: connections are a `send` and a `close`, persistence is a
 * callback and time is a clock, so tests drive it directly (server.ts wires it to Bun).
 *
 * A signed-in player appears with their first state, not before, so nobody pops up at a made-up
 * spot. A client hears only of the players in the 3×3 cells round where its map looks
 * (src/net/interest.ts): sending everyone to everyone is N² of bandwidth, and one uplink can't
 * carry a thousand players that way. Whatever happened since the last 10 Hz `tick` goes out in one
 * go: those it can now see (`joins`), those it can't any more (`leaves`) and who moved (`moves`).
 *
 * In a crowd, the nearest few still move at 10 Hz and the rest in turns, once a second. A client
 * too slow to keep up is skipped rather than cut off, and gets a fresh start once it catches up.
 * One account has one live connection: signing in again elsewhere closes the old one with
 * CLOSE_REPLACED, which the client won't retry.
 */

import * as RateLimit from '@portable/rate-limit';

import { AREA, VIEW_AREA } from '../src/data/area.ts';
import type { Bounds } from '../src/data/city.ts';
import { around, cellAt, cellX, cellZ, watches } from '../src/net/interest.ts';
import {
  CLOSE_REPLACED,
  MAX_SPEED,
  decodeClientMessage,
  encodeServerMessage,
} from '../src/net/protocol.ts';
import type { JoinedPlayer, Outfit, PlayerState, ServerMessage } from '../src/net/protocol.ts';
import { isPlace } from '../src/net/rules.ts';
import { nearestFirst } from './nearest.ts';

export interface Connection {
  /** Sends a frame. A socket that returns 0 dropped it, so the world knows it missed something. */
  send(frame: Uint8Array): number | void;
  close(code: number, reason: string): void;
  /** Bytes queued and not yet on the wire; none if it doesn't know. */
  buffered?(): number;
}

export interface Account {
  userId: string;
  name: string;
  outfit: Outfit;
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
  /** Admits a connection, signed in or a guest (null), and returns its id. */
  connect(connection: Connection, account: Account | null): number;
  /** A message from a connection; resolves once it has been applied or dropped. */
  receive(id: number, data: string | Uint8Array): Promise<void>;
  disconnect(id: number): void;
  /** A player's session ended (signed out, a new password): off the map, to reconnect if they may. */
  drop(userId: string): void;
  /** A player changed colours; whoever can see them hears it if they are online. */
  setOutfit(userId: string, outfit: Outfit): void;
  /** Where an online player is now, or null when they aren't or haven't moved yet. */
  stateOf(userId: string): PlayerState | null;
  /** Sends what changed since the last tick and saves the ones due. */
  tick(): void;
  /** Saves every player online, for a shutdown. */
  flush(): void;
  stats(): WorldStats;
  /** Connections open, guests included. */
  readonly size: number;
}

interface Client {
  id: number;
  connection: Connection;
  account: Account | null;
  state: PlayerState | null;
  /** When `state` was accepted (ms). */
  movedAt: number;
  /** Slices of the round that haven't heard this move yet: goes to the clients it is near. */
  dirty: number;
  /** Slices that haven't heard this since its last turn: goes to all who see it, once a second. */
  stale: number;
  /** Went into a room or out, or changed floor, since the last tick. */
  replaced: boolean;
  /** Moved since the last save. */
  unsaved: boolean;
  savedAt: number;
  /** The cell the figure is filed under; NOWHERE until it is placed. */
  cell: number;
  /** Where the map looks, if the client has said. */
  look: readonly [number, number] | null;
  /** The cell the client watches round, and those 9 cells; NOWHERE and none until the first tick. */
  watching: number;
  nine: readonly number[];
  /** Those it has to be told about: +1 now in view, -1 out of it, or nothing if that cancelled. */
  pending: Map<Client, number>;
  /** When it last moved what it watches (ms). */
  watchedAt: number;
  /** The count of players it last heard. */
  heardOnline: number;
  /** Wants the full map's dots. */
  wantsDots: boolean;
  /** Its socket is backed up: it hears nothing until it has caught up and gets a fresh start. */
  behind: boolean;
}

/** A socket closed because its session ended: the client may reconnect, as whoever it now is. */
export const CLOSE_SIGNED_OUT = 4002;
const TURN = Math.PI * 2;
const MIN_FLOOR = -4;
const MAX_FLOOR = 20;
const NOWHERE = -1;
/** Faster than anyone goes (m/s): a figure can't get further than this between two messages. */
const TOP_SPEED = 30;
/** Slack for a door's few metres, and a stutter of the network. */
const MOVE_SLACK = 8;
/** The longest a pause (s) can earn, so a tab left alone doesn't get a free teleport. */
const MOST_ELAPSED = 5;
/** Each client always hears these many of the movers nearest it, at the full 10 Hz. */
const NEAREST = 32;
/** The rest take turns: each once in this many ticks. */
const TURN_TICKS = 10;
/** The most movers a frame lists, should a crowd take turns faster than a client could use them. */
const MOST_MOVES = 160;
/** How often the count of players goes out when it changed, and the dots while wanted (ticks). */
const ONLINE_TICKS = 10;
const DOTS_TICKS = 20;
/** Bytes queued that mean a client isn't keeping up, and that mean it has caught up. */
const BEHIND_BYTES = 64 * 1024;
const CAUGHT_UP_BYTES = 8 * 1024;
/** How many ticks /api/health averages over. */
const STATS_TICKS = 100;
/** A client moves what it watches at most this often (ms): each move is a burst of joins. */
const LOOK_MS = 250;
const NOBODY: readonly Client[] = [];

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
    // The street has one floor.
    floor:
      place && Number.isFinite(state.floor)
        ? clamp(Math.round(state.floor), MIN_FLOOR, MAX_FLOOR)
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
 * is the one thing that moves a figure at once, and it changes room or floor, so it passes.
 */
export function withinReach(from: PlayerState, next: PlayerState, seconds: number): PlayerState {
  if (from.place !== next.place || from.floor !== next.floor) return next;
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
  const slices = Math.max(1, options.slices ?? 1);
  const everySlice = (1 << slices) - 1;
  const limiter = RateLimit.create(options.rate ?? { limit: 20, period: 1000, burst: 40 });
  const clients = new Map<number, Client>();
  const byUser = new Map<string, Client>();
  /** Who is placed in each cell. */
  const residents = new Map<number, Set<Client>>();
  /** Who watches each cell. */
  const watchers = new Map<number, Set<Client>>();
  /** Who moved this tick and who takes a turn this tick, cell by cell. */
  const movers = new Map<number, Client[]>();
  /** Those who left since the last tick, still on the map for whoever saw them. */
  const departed: Client[] = [];
  /** Who left and which tick every client will have heard so by. */
  const leaving: { id: number; after: number }[] = [];
  /** Ids free to use again. */
  const freeIds: number[] = [];
  const saves: SavedPosition[] = [];
  let lastId = 0;
  let tickCount = 0;
  const selected: Client[] = [];
  const stats = { ticks: 0, busy: 0, longest: 0, bytes: 0, since: 0 };
  let report: WorldStats = { online: 0, players: 0, tickMs: 0, tickMaxMs: 0, bytesPerSecond: 0 };

  const nextId = () => freeIds.pop() ?? ++lastId;
  const placed = (client: Client) => Boolean(client.account && client.state);

  const deliver = (client: Client, frame: Uint8Array) => {
    try {
      stats.bytes += frame.length;
      if (client.connection.send(frame) === 0) client.behind = true;
    } catch {
      // A socket closing under us: its own close event cleans up.
    }
  };

  /** Delivers one frame, encoded once, to everyone who sees `player`. */
  const toSeers = (player: Client, message: ServerMessage) => {
    const seers = watchers.get(player.cell);
    if (!seers?.size) return;
    const frame = encodeServerMessage(message);
    for (const seer of seers) if (seer !== player && !seer.behind) deliver(seer, frame);
  };

  const joined = ({ id, account, state }: Client): JoinedPlayer => ({
    id,
    name: account!.name,
    outfit: account!.outfit,
    state: state!,
  });

  const queue = (viewer: Client, player: Client, delta: 1 | -1) => {
    const net = (viewer.pending.get(player) ?? 0) + delta;
    if (net === 0) viewer.pending.delete(player);
    else viewer.pending.set(player, net);
  };

  const persist = (client: Client) => {
    if (!client.account || !client.state || !client.unsaved) return;
    saves.push({ userId: client.account.userId, state: client.state });
    client.unsaved = false;
    client.savedAt = now();
  };

  const unwatch = (viewer: Client, cell: number) => {
    const seers = watchers.get(cell);
    seers?.delete(viewer);
    if (seers?.size === 0) watchers.delete(cell);
  };

  const remove = (client: Client) => {
    clients.delete(client.id);
    if (client.account && byUser.get(client.account.userId) === client) {
      byUser.delete(client.account.userId);
    }
    persist(client);
    for (const cell of client.nine) unwatch(client, cell);
    client.nine = [];
    departed.push(client);
  };

  /** Files a figure under another cell, or none, and tells those who gain or lose sight of it. */
  const refile = (player: Client, cell: number) => {
    const old = player.cell;
    if (old !== NOWHERE) {
      const left = residents.get(old);
      left?.delete(player);
      if (left?.size === 0) residents.delete(old);
      for (const viewer of watchers.get(old) ?? NOBODY) {
        if (viewer !== player && (cell === NOWHERE || !watches(viewer.watching, cell))) {
          queue(viewer, player, -1);
        }
      }
    }
    if (cell !== NOWHERE) {
      let here = residents.get(cell);
      if (!here) residents.set(cell, (here = new Set()));
      here.add(player);
      for (const viewer of watchers.get(cell) ?? NOBODY) {
        if (viewer !== player && (old === NOWHERE || !watches(viewer.watching, old))) {
          queue(viewer, player, 1);
        }
      }
    }
    player.cell = cell;
  };

  /** Points a client at another cell: it sees those it now has in view, and no longer the rest. */
  const watch = (viewer: Client, cell: number) => {
    const old = viewer.watching;
    const nine = around(cell);
    for (const c of viewer.nine) {
      if (watches(cell, c)) continue;
      for (const player of residents.get(c) ?? NOBODY) {
        if (player !== viewer) queue(viewer, player, -1);
      }
      unwatch(viewer, c);
    }
    for (const c of nine) {
      let seers = watchers.get(c);
      if (!seers) watchers.set(c, (seers = new Set()));
      seers.add(viewer);
      if (old !== NOWHERE && watches(old, c)) continue;
      for (const player of residents.get(c) ?? NOBODY) {
        if (player !== viewer) queue(viewer, player, 1);
      }
    }
    viewer.nine = nine;
    viewer.watching = cell;
  };

  /** Where a client's interest centres: what it looks at, else its figure, else the city's middle. */
  const lookOf = (client: Client): readonly [number, number] =>
    client.look ?? (client.state ? [client.state.x, client.state.z] : [0, 0]);

  /** A client that fell behind and caught up: forget everyone, here is everyone it can see. */
  const startOver = (client: Client) => {
    client.behind = false;
    client.heardOnline = -1;
    client.pending.clear();
    deliver(client, encodeServerMessage({ type: 'welcome', you: client.account ? client.id : 0 }));
    const players: JoinedPlayer[] = [];
    for (const cell of client.nine) {
      for (const player of residents.get(cell) ?? NOBODY) {
        if (player !== client) players.push(joined(player));
      }
    }
    if (players.length) deliver(client, encodeServerMessage({ type: 'joins', players }));
  };

  const flushPending = (client: Client) => {
    const ids: number[] = [];
    const players: JoinedPlayer[] = [];
    for (const [player, net] of client.pending) {
      if (net > 0 && player.state && player.account) players.push(joined(player));
      else if (net < 0) ids.push(player.id);
    }
    client.pending.clear();
    if (ids.length) deliver(client, encodeServerMessage({ type: 'leaves', ids }));
    if (players.length) deliver(client, encodeServerMessage({ type: 'joins', players }));
  };

  const sendMoves = (client: Client, moved: number, round: number) => {
    const count = moved <= NEAREST ? moved : pickFrom(client, moved, round);
    if (!count) return;
    const cell = client.watching;
    const players = selected.slice(0, count) as { id: number; state: PlayerState }[];
    deliver(
      client,
      encodeServerMessage({ type: 'moves', cx: cellX(cell), cz: cellZ(cell), players }),
    );
  };

  /** Of the `moved` figures in `selected`: the nearest, and those whose turn it is. */
  const pickFrom = (client: Client, moved: number, round: number) => {
    const [x, z] = lookOf(client);
    nearestFirst(selected, moved, NEAREST, ({ state }) => {
      const dx = state!.x - x;
      const dz = state!.z - z;
      return dx * dx + dz * dz;
    });
    let count = NEAREST;
    for (let i = NEAREST; i < moved && count < MOST_MOVES; i++) {
      const player = selected[i]!;
      if ((player.id + round) % TURN_TICKS === 0) {
        selected[i] = selected[count]!;
        selected[count++] = player;
      }
    }
    return count;
  };

  return {
    connect(connection, account) {
      if (account) {
        const old = byUser.get(account.userId);
        if (old) {
          remove(old);
          old.connection.close(CLOSE_REPLACED, 'Signed in somewhere else');
        }
      }
      const client: Client = {
        id: nextId(),
        connection,
        account,
        state: null,
        movedAt: 0,
        dirty: 0,
        stale: 0,
        replaced: false,
        unsaved: false,
        savedAt: now(),
        cell: NOWHERE,
        look: null,
        watching: NOWHERE,
        nine: [],
        pending: new Map(),
        watchedAt: Number.NEGATIVE_INFINITY,
        heardOnline: -1,
        wantsDots: false,
        behind: false,
      };
      clients.set(client.id, client);
      if (account) byUser.set(account.userId, client);
      deliver(client, encodeServerMessage({ type: 'welcome', you: account ? client.id : 0 }));
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
        client.look = [
          clamp(message.x, VIEW_AREA.minX, VIEW_AREA.maxX),
          clamp(message.z, VIEW_AREA.minZ, VIEW_AREA.maxZ),
        ];
        return;
      }
      if (message?.type === 'dots') {
        client.wantsDots = message.on;
        return;
      }
      // Guests watch: what they say about themselves goes nowhere.
      if (!message || !client.account) return;
      const time = now();
      const sane = sanitise(message.state, area);
      const previous = client.state;
      if (!previous) {
        client.state = sane;
        client.movedAt = time;
        client.unsaved = true;
        return;
      }
      const state = withinReach(previous, sane, (time - client.movedAt) / 1000);
      if (same(previous, state)) return;
      client.replaced ||= state.place !== previous.place || state.floor !== previous.floor;
      client.state = state;
      client.movedAt = time;
      client.dirty = client.stale = everySlice;
      client.unsaved = true;
    },

    disconnect(id) {
      const client = clients.get(id);
      if (client) remove(client);
    },

    drop(userId) {
      const client = byUser.get(userId);
      if (!client) return;
      remove(client);
      client.connection.close(CLOSE_SIGNED_OUT, 'Signed out');
    },

    setOutfit(userId, outfit) {
      const client = byUser.get(userId);
      if (!client?.account) return;
      client.account.outfit = outfit;
      deliver(client, encodeServerMessage({ type: 'outfit', id: client.id, outfit }));
      toSeers(client, { type: 'outfit', id: client.id, outfit });
    },

    stateOf: (userId) => byUser.get(userId)?.state ?? null,

    tick() {
      const started = clock();
      tickCount++;
      const time = now();
      const slice = tickCount % slices;
      const bit = 1 << slice;
      const round = Math.floor(tickCount / slices);
      const inSlice = (client: Client) => client.id % slices === slice;

      // 1. Everyone goes where they are now: the gone, the new, and across a cell's edge.
      for (const client of departed) {
        refile(client, NOWHERE);
        leaving.push({ id: client.id, after: tickCount + slices - 1 });
      }
      departed.length = 0;
      let players = 0;
      for (const client of clients.values()) {
        if (!placed(client)) continue;
        players++;
        const cell = cellAt(client.state!.x, client.state!.z);
        if (cell !== client.cell) refile(client, cell);
      }

      // 2. Everyone looks where they look now.
      for (const client of clients.values()) {
        const [x, z] = lookOf(client);
        const cell = cellAt(x, z);
        if (cell !== client.watching && time - client.watchedAt >= LOOK_MS) {
          client.watchedAt = time;
          watch(client, cell);
        }
      }

      // 3. Who is backed up, by how much, is read only now: what is queued is what's left of
      // the frames of the ticks before.
      for (const client of clients.values()) {
        if (!inSlice(client)) continue;
        const queued = client.connection.buffered?.() ?? 0;
        if (client.behind) {
          if (queued < CAUGHT_UP_BYTES) startOver(client);
        } else if (queued > BEHIND_BYTES) {
          client.behind = true;
          client.pending.clear();
        }
      }

      // 4. A door: before the moves, so the figure's jump reads as one.
      for (const client of clients.values()) {
        if (client.replaced && client.state && client.cell !== NOWHERE) {
          toSeers(client, { type: 'placed', id: client.id, state: client.state });
        }
        client.replaced = false;
      }

      // 5. Who moved, by cell: those it is near get them all, the rest when it is their turn.
      movers.clear();
      for (const client of clients.values()) {
        const turn = (client.id + round) % TURN_TICKS === 0;
        if (client.cell !== NOWHERE && (client.dirty & bit || (turn && client.stale & bit))) {
          let list = movers.get(client.cell);
          if (!list) movers.set(client.cell, (list = []));
          list.push(client);
        }
        client.dirty &= ~bit;
        if (turn) client.stale &= ~bit;
      }

      // 6. To this slice's clients what they have to hear.
      for (const client of clients.values()) {
        if (client.behind || !inSlice(client)) continue;
        if (client.pending.size) flushPending(client);
        let moved = 0;
        for (const cell of client.nine) {
          const list = movers.get(cell);
          if (!list) continue;
          for (const player of list) {
            if (player !== client) selected[moved++] = player;
          }
        }
        if (moved) sendMoves(client, moved, round);
      }

      // 7. Now everyone has heard they went, their ids can be used again.
      while (leaving[0] && leaving[0].after <= tickCount) freeIds.push(leaving.shift()!.id);

      // 8. The rarer news: how many are here, and the full map's dots.
      if (slice === 0 && round % ONLINE_TICKS === 0) {
        let frame: Uint8Array | null = null;
        for (const client of clients.values()) {
          if (client.behind || client.heardOnline === players) continue;
          client.heardOnline = players;
          frame ??= encodeServerMessage({ type: 'online', count: players });
          deliver(client, frame);
        }
      }
      if (slice === 0 && round % DOTS_TICKS === 0) {
        let frame: Uint8Array | null = null;
        for (const client of clients.values()) {
          if (!client.wantsDots || client.behind) continue;
          frame ??= encodeServerMessage({
            type: 'dots',
            players: [...clients.values()].flatMap((c) =>
              c.account && c.state
                ? [{ id: c.id, x: c.state.x, z: c.state.z, colour: c.account.outfit.shirt }]
                : [],
            ),
          });
          deliver(client, frame);
        }
      }

      for (const client of clients.values()) {
        if (time - client.savedAt >= saveEvery) persist(client);
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
      for (const client of clients.values()) persist(client);
      if (saves.length) save(saves.splice(0));
    },

    stats: () => ({ ...report, online: clients.size }),

    get size() {
      return clients.size;
    },
  };
}
