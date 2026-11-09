/**
 * The presence hub: who is online, where they are, and who needs to hear about it. It knows
 * nothing of sockets or SQLite: connections are a `send` and a `close`, persistence is a
 * callback and time is a clock, so tests drive it directly (server.ts wires it to Bun).
 *
 * A person, signed in or a guest, is one figure on the map, however many of their tabs are open:
 * a figure and a socket are separate things here. Each tab sees the map for itself, but only one,
 * the `driver`, moves the figure: the last to say it is in use, or else the newest left. A figure
 * appears with its first state, not before, so nobody pops up at a made-up spot. A client hears only of the players in the 3×3 cells round where its map looks
 * (src/net/interest.ts): sending everyone to everyone is N² of bandwidth, and one uplink can't
 * carry a thousand players that way. Whatever happened since the last 10 Hz `tick` goes out in one
 * go: those it can now see (`joins`), those it can't any more (`leaves`) and who moved (`moves`).
 *
 * In a crowd, the nearest few still move at 10 Hz and the rest in turns, once a second. A client
 * too slow to keep up is skipped rather than cut off, and gets a fresh start once it catches up.
 * Signing in or out changes who a figure is in place (`signedIn`, `signedOut`), so the socket and
 * the figure carry on and the others only see a new name.
 */

import * as RateLimit from '@portable/rate-limit';

import { AREA, VIEW_AREA } from '../src/data/area.ts';
import type { Bounds } from '../src/data/city.ts';
import { around, cellAt, cellX, cellZ, watches } from '../src/net/interest.ts';
import { MAX_SPEED, decodeClientMessage, encodeServerMessage } from '../src/net/protocol.ts';
import type {
  JoinedPlayer,
  MoveBaseline,
  Outfit,
  PlayerState,
  ServerMessage,
} from '../src/net/protocol.ts';
import { isPlace } from '../src/net/rules.ts';
import { nearestFirst } from './nearest.ts';

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
  /** A new password: every socket of theirs off the map, to reconnect if they may. */
  drop(userId: string): void;
  /**
   * A guest (`guestKey`, their `userId`) signed in or up as `account`: the same figure carries on
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
interface Figure {
  id: number;
  account: Account;
  /** Over the cap on guests from one address: nobody sees them. */
  hidden: boolean;
  /** Where it came from: counts against the address while a guest. */
  address: string;
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
  /** Where the map looks, if the client has said. */
  look: readonly [number, number] | null;
  /** The cell the client watches round, and those 9 cells; NOWHERE and none until the first tick. */
  watching: number;
  nine: readonly number[];
  /** Those it has to be told about: +1 now in view, -1 out of it, or nothing if that cancelled. */
  pending: Map<Figure, number>;
  /** What it last heard of the figures nearest it, each sent as a delta from this. */
  baselines: Map<number, MoveBaseline>;
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
/** Refused for good; 1008 is the code the client won't retry. */
const CLOSE_TURNED_AWAY = 1008;
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
/** How often forgotten guests are cleared out (rounds). */
const FORGET_TICKS = 300;
/** How many ticks /api/health averages over. */
const STATS_TICKS = 100;
/** A client moves what it watches at most this often (ms): each move is a burst of joins. */
const LOOK_MS = 250;
/** A baseline nothing has been sent from yet: the first move goes whole. */
const UNKNOWN: MoveBaseline = { x: Number.NaN, z: Number.NaN, heading: 0, speed: 0 };
/** More than this and they are all forgotten, for a whole move each next time. */
const MOST_BASELINES = NEAREST * 4;
const NOBODY: readonly Figure[] = [];
const NOONE: readonly Client[] = [];
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
  const guestsPerAddress = options.guestsPerAddress ?? Number.POSITIVE_INFINITY;
  const clients = new Map<number, Client>();
  /** Everyone online, by account or guest id. */
  const people = new Map<string, Figure>();
  /** Guests' names in use, so no two online are the same. */
  const guestNames = new Set<string>();
  /** How many guests each address has on the map. */
  const guestsFrom = new Map<string, number>();
  /** Guests who left a moment ago and where. */
  const remembered = new Map<string, { state: PlayerState; at: number }>();
  /** Who is placed in each cell. */
  const residents = new Map<number, Set<Figure>>();
  /** Who watches each cell. */
  const watchers = new Map<number, Set<Client>>();
  /** Who moved this tick and who takes a turn this tick, cell by cell. */
  const movers = new Map<number, Figure[]>();
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
  const selected: Figure[] = [];
  const bases: (MoveBaseline | undefined)[] = [];
  const stats = { ticks: 0, busy: 0, longest: 0, bytes: 0, since: 0 };
  let report: WorldStats = { online: 0, players: 0, tickMs: 0, tickMaxMs: 0, bytesPerSecond: 0 };

  const nextId = () => freeIds.pop() ?? ++lastId;

  const deliver = (client: Client, frame: Uint8Array) => {
    try {
      stats.bytes += frame.length;
      if (client.connection.send(frame) === 0) client.behind = true;
    } catch {
      // A socket closing under us: its own close event cleans up.
    }
  };

  /** Delivers one frame, encoded once, to everyone who sees `player`. */
  const toSeers = (player: Figure, message: ServerMessage) => {
    const seers = watchers.get(player.cell);
    if (!seers?.size) return;
    const frame = encodeServerMessage(message);
    for (const seer of seers) if (seer.figure !== player && !seer.behind) deliver(seer, frame);
  };

  const joined = ({ id, account, state }: Figure): JoinedPlayer => ({
    id,
    name: account.name,
    outfit: account.outfit,
    state: state!,
  });

  const queue = (viewer: Client, player: Figure, delta: 1 | -1) => {
    const net = (viewer.pending.get(player) ?? 0) + delta;
    if (net === 0) viewer.pending.delete(player);
    else viewer.pending.set(player, net);
  };

  const persist = (figure: Figure) => {
    if (figure.account.guest || !figure.state || !figure.unsaved) return;
    saves.push({ userId: figure.account.userId, state: figure.state });
    figure.unsaved = false;
    figure.savedAt = now();
  };

  const unwatch = (viewer: Client, cell: number) => {
    const seers = watchers.get(cell);
    seers?.delete(viewer);
    if (seers?.size === 0) watchers.delete(cell);
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
    refile(figure, NOWHERE);
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
    for (const cell of client.nine) unwatch(client, cell);
    client.nine = [];
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
      dirty: 0,
      stale: 0,
      replaced: false,
      unsaved: false,
      savedAt: now(),
      cell: NOWHERE,
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
    startOver(client);
    introduce(client);
  };

  /** Files a figure under another cell, or none, and tells those who gain or lose sight of it. */
  const refile = (player: Figure, cell: number) => {
    const old = player.cell;
    if (old !== NOWHERE) {
      const left = residents.get(old);
      left?.delete(player);
      if (left?.size === 0) residents.delete(old);
      for (const viewer of watchers.get(old) ?? NOONE) {
        if (viewer.figure !== player && (cell === NOWHERE || !watches(viewer.watching, cell))) {
          queue(viewer, player, -1);
        }
      }
    }
    if (cell !== NOWHERE) {
      let here = residents.get(cell);
      if (!here) residents.set(cell, (here = new Set()));
      here.add(player);
      for (const viewer of watchers.get(cell) ?? NOONE) {
        if (viewer.figure !== player && (old === NOWHERE || !watches(viewer.watching, old))) {
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
        if (player !== viewer.figure) queue(viewer, player, -1);
      }
      unwatch(viewer, c);
    }
    for (const c of nine) {
      let seers = watchers.get(c);
      if (!seers) watchers.set(c, (seers = new Set()));
      seers.add(viewer);
      if (old !== NOWHERE && watches(old, c)) continue;
      for (const player of residents.get(c) ?? NOBODY) {
        if (player !== viewer.figure) queue(viewer, player, 1);
      }
    }
    viewer.nine = nine;
    viewer.watching = cell;
  };

  /** Where a client's interest centres: what it looks at, else its figure, else the city's middle. */
  const lookOf = (client: Client): readonly [number, number] =>
    client.look ?? (client.figure.state ? [client.figure.state.x, client.figure.state.z] : [0, 0]);

  /** A client that fell behind and caught up: forget everyone, here is everyone it can see. */
  const startOver = (client: Client) => {
    client.behind = false;
    client.heardOnline = -1;
    client.pending.clear();
    client.baselines.clear();
    deliver(client, encodeServerMessage({ type: 'welcome', you: client.figure.id }));
    const players: JoinedPlayer[] = [];
    for (const cell of client.nine) {
      for (const player of residents.get(cell) ?? NOBODY) {
        if (player !== client.figure) players.push(joined(player));
      }
    }
    if (players.length) deliver(client, encodeServerMessage({ type: 'joins', players }));
  };

  const flushPending = (client: Client) => {
    const ids: number[] = [];
    const players: JoinedPlayer[] = [];
    for (const [player, net] of client.pending) {
      if (net > 0 && player.state) players.push(joined(player));
      else if (net < 0) ids.push(player.id);
      // Whether it came or went, nothing it heard before stands.
      client.baselines.delete(player.id);
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
    // A delta only for those it hears of every tick: for the others (their turn, once a second)
    // what it last heard is old, and a client watching a crowd would keep hundreds for nothing.
    if (client.baselines.size > MOST_BASELINES) client.baselines.clear();
    const near = Math.min(count, NEAREST);
    bases.length = count;
    for (let i = 0; i < count; i++) {
      const { id } = players[i]!;
      if (i >= near) {
        client.baselines.delete(id);
        bases[i] = undefined;
        continue;
      }
      let base = client.baselines.get(id);
      if (!base) client.baselines.set(id, (base = { ...UNKNOWN }));
      bases[i] = base;
    }
    deliver(
      client,
      encodeServerMessage({ type: 'moves', cx: cellX(cell), cz: cellZ(cell), players, bases }),
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

  /** The same figure, someone else: its tabs are told, and so is whoever can see it. */
  const changeWho = (figure: Figure, account: Account, session: string | null) => {
    stopBeing(figure);
    becomeWho(figure, account);
    if (figure.hidden && figure.state) {
      figure.state = null;
      refile(figure, NOWHERE);
    }
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
      const client: Client = {
        id: ++lastSocket,
        connection,
        figure,
        session,
        look: null,
        watching: NOWHERE,
        nine: [],
        pending: new Map(),
        baselines: new Map(),
        watchedAt: Number.NEGATIVE_INFINITY,
        heardOnline: -1,
        wantsDots: false,
        behind: false,
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
        figure.unsaved = true;
        return;
      }
      const state = withinReach(previous, sane, (time - figure.movedAt) / 1000);
      if (same(previous, state)) return;
      figure.replaced ||= state.place !== previous.place || state.floor !== previous.floor;
      figure.state = state;
      figure.movedAt = time;
      figure.dirty = figure.stale = everySlice;
      figure.unsaved = true;
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
      const bit = 1 << slice;
      const round = Math.floor(tickCount / slices);
      const inSlice = (client: Client) => client.id % slices === slice;

      // 1. Everyone goes where they are now: the gone, the new, and across a cell's edge.
      for (const figure of departed) {
        leaving.push({ id: figure.id, after: tickCount + slices - 1 });
      }
      departed.length = 0;
      let players = 0;
      for (const figure of people.values()) {
        if (!figure.state) continue;
        players++;
        const cell = cellAt(figure.state.x, figure.state.z);
        if (cell !== figure.cell) refile(figure, cell);
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
      for (const figure of people.values()) {
        if (figure.replaced && figure.state && figure.cell !== NOWHERE) {
          toSeers(figure, { type: 'placed', id: figure.id, state: figure.state });
        }
        figure.replaced = false;
      }

      // 5. Who moved, by cell: those it is near get them all, the rest when it is their turn.
      movers.clear();
      for (const figure of people.values()) {
        const turn = (figure.id + round) % TURN_TICKS === 0;
        if (figure.cell !== NOWHERE && (figure.dirty & bit || (turn && figure.stale & bit))) {
          let list = movers.get(figure.cell);
          if (!list) movers.set(figure.cell, (list = []));
          list.push(figure);
        }
        // Their other tabs follow the figure they don't drive.
        if (figure.tabs.size > 1 && figure.dirty & bit && figure.state) {
          let frame: Uint8Array | null = null;
          for (const tab of figure.tabs) {
            if (tab === figure.driver || tab.behind || !inSlice(tab)) continue;
            frame ??= encodeServerMessage({ type: 'placed', id: figure.id, state: figure.state });
            deliver(tab, frame);
          }
        }
        figure.dirty &= ~bit;
        if (turn) figure.stale &= ~bit;
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
            if (player !== client.figure) selected[moved++] = player;
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
            players: [...people.values()].flatMap((f) =>
              f.state
                ? [{ id: f.id, x: f.state.x, z: f.state.z, colour: f.account.outfit.shirt }]
                : [],
            ),
          });
          deliver(client, frame);
        }
      }

      for (const figure of people.values()) {
        if (time - figure.savedAt >= saveEvery) persist(figure);
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
