/**
 * The presence hub: who is online, where they are, and who needs to hear about it. It knows
 * nothing of sockets or SQLite: connections are a `send` and a `close`, persistence is a
 * callback and time is a clock, so tests drive it directly (server.ts wires it to Bun).
 *
 * A signed-in player is announced (`join`) with their first state, not before, so nobody pops
 * up at a made-up spot; after that the 10 Hz `tick` batches whoever moved. A guest gets the
 * same stream but sends nothing anyone sees. One account has one live connection: signing in
 * again elsewhere closes the old one with CLOSE_REPLACED, which the client won't retry.
 */

import * as RateLimit from '@portable/rate-limit';

import { AREA } from '../src/data/area.ts';
import type { Bounds } from '../src/data/city.ts';
import {
  CLOSE_REPLACED,
  MAX_SPEED,
  decodeClientMessage,
  encodeServerMessage,
} from '../src/net/protocol.ts';
import type { Outfit, PlayerState, PlayerUpdate, ServerMessage } from '../src/net/protocol.ts';
import { isPlace } from '../src/net/rules.ts';

export interface Connection {
  send(frame: Uint8Array): void;
  close(code: number, reason: string): void;
}

export interface Account {
  userId: string;
  name: string;
  outfit: Outfit;
}

export interface WorldOptions {
  /** Milliseconds, steady enough for rate limits and save intervals. */
  now?: () => number;
  /** Keeps a player's last state: called on leave and every `saveEvery` while they move. */
  save?: (userId: string, state: PlayerState) => void;
  saveEvery?: number;
  /** Messages a connection may send: a 10 Hz client with room for bursts of big changes. */
  rate?: { limit: number; period: number; burst?: number };
  /** Where a figure may stand; anything outside is pulled to the nearest edge. */
  area?: readonly Bounds[];
}

export interface World {
  /** Admits a connection, signed in or a guest (null), and returns its id. */
  connect(connection: Connection, account: Account | null): number;
  /** A message from a connection; resolves once it has been applied or dropped. */
  receive(id: number, data: string | Uint8Array): Promise<void>;
  disconnect(id: number): void;
  /** A player's session ended (signed out, a new password): off the map, to reconnect if they may. */
  drop(userId: string): void;
  /** A player changed colours; everyone hears it if they are online. */
  setOutfit(userId: string, outfit: Outfit): void;
  /** Where an online player is now, or null when they aren't or haven't moved yet. */
  stateOf(userId: string): PlayerState | null;
  /** Sends the states that changed since the last tick and saves the ones due. */
  tick(): void;
  /** Saves every player online, for a shutdown. */
  flush(): void;
  /** Connections open, guests included. */
  readonly size: number;
}

interface Client {
  id: number;
  connection: Connection;
  account: Account | null;
  state: PlayerState | null;
  /** Moved since the last tick. */
  dirty: boolean;
  /** Moved since the last save. */
  unsaved: boolean;
  savedAt: number;
}

/** A socket closed because its session ended: the client may reconnect, as whoever it now is. */
export const CLOSE_SIGNED_OUT = 4002;
const TURN = Math.PI * 2;
const MIN_FLOOR = -4;
const MAX_FLOOR = 20;
const MAX_ID = 0xffff_ffff;

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

export function createWorld(options: WorldOptions = {}): World {
  const now = options.now ?? Date.now;
  const save = options.save ?? (() => {});
  const saveEvery = options.saveEvery ?? 15_000;
  const area = options.area ?? AREA;
  const limiter = RateLimit.create(options.rate ?? { limit: 20, period: 1000, burst: 40 });
  const clients = new Map<number, Client>();
  const byUser = new Map<string, Client>();
  let lastId = 0;

  const nextId = () => {
    do lastId = lastId >= MAX_ID ? 1 : lastId + 1;
    while (clients.has(lastId));
    return lastId;
  };

  const deliver = (client: Client, frame: Uint8Array) => {
    try {
      client.connection.send(frame);
    } catch {
      // A socket closing under us: its own close event cleans up.
    }
  };

  const broadcast = (message: ServerMessage, except?: Client) => {
    const frame = encodeServerMessage(message);
    for (const client of clients.values()) if (client !== except) deliver(client, frame);
  };

  /** The join that announces a player, once they are signed in and placed. */
  const joinOf = ({ id, account, state }: Client): ServerMessage | null =>
    account && state
      ? { type: 'join', id, name: account.name, outfit: account.outfit, state }
      : null;

  const persist = (client: Client) => {
    if (!client.account || !client.state || !client.unsaved) return;
    save(client.account.userId, client.state);
    client.unsaved = false;
    client.savedAt = now();
  };

  const remove = (client: Client) => {
    clients.delete(client.id);
    if (client.account && byUser.get(client.account.userId) === client) {
      byUser.delete(client.account.userId);
    }
    persist(client);
    if (client.account && client.state) broadcast({ type: 'leave', id: client.id });
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
        dirty: false,
        unsaved: false,
        savedAt: now(),
      };
      clients.set(client.id, client);
      if (account) byUser.set(account.userId, client);
      deliver(client, encodeServerMessage({ type: 'welcome', you: account ? client.id : 0 }));
      for (const other of clients.values()) {
        const join = joinOf(other);
        if (join) deliver(client, encodeServerMessage(join));
      }
      return client.id;
    },

    async receive(id, data) {
      const client = clients.get(id);
      // Guests watch; text frames aren't part of the protocol.
      if (!client?.account || typeof data === 'string') return;
      const { allowed } = await limiter.take(String(id), { now: new Date(now()) });
      if (!allowed || clients.get(id) !== client) return;
      const message = decodeClientMessage(data);
      if (!message) return;
      const state = sanitise(message.state, area);
      if (!client.state) {
        client.state = state;
        client.unsaved = true;
        broadcast(joinOf(client)!, client);
      } else if (!same(client.state, state)) {
        client.state = state;
        client.dirty = true;
        client.unsaved = true;
      }
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
      broadcast({ type: 'outfit', id: client.id, outfit });
    },

    stateOf: (userId) => byUser.get(userId)?.state ?? null,

    tick() {
      const players: PlayerUpdate[] = [];
      const time = now();
      for (const client of clients.values()) {
        if (client.dirty && client.state) players.push({ id: client.id, state: client.state });
        client.dirty = false;
        if (time - client.savedAt >= saveEvery) persist(client);
      }
      if (players.length) broadcast({ type: 'states', players });
    },

    flush() {
      for (const client of clients.values()) persist(client);
    },

    get size() {
      return clients.size;
    },
  };
}
