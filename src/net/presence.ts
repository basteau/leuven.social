/**
 * The live connection to the other players: one WebSocket to `/ws` on the page's own origin,
 * which comes back by itself after a drop. A cookie says who we are, an account or this browser's
 * guest, and the server says so back (`onIdentity`), again whenever that changes under us: signing
 * in or out in another tab reaches this one here. One tab of a person moves their figure: the last
 * to `drive`, or else the newest left. The avatar's state goes out through `send`, throttled
 * (throttle.ts), from that tab alone; the others follow the figure (`onOwn`). What comes back is
 * decoded and handed to the callbacks, minus our own echo.
 *
 * Each connection starts with `onWelcome`: forget every other player then, since ids are only
 * good for one connection, and the joins of those nearby follow. The server tells it only of the
 * players round where the map looks, so `view` keeps it up to date with that.
 */

import * as WebSockets from '@portable/websockets';

import { cellAt } from './interest.ts';
import { decodeServerMessage, encodeClientMessage, moved } from './protocol.ts';
import type { Dot, Move, Outfit, PlayerState, PlayerUpdate } from './protocol.ts';
import { sendDelay } from './throttle.ts';
import type { Sent } from './throttle.ts';

/** `connecting` at first, `online` while connected, `offline` while it tries again, `closed` after `close()` or when the server turned us away for good. */
export type PresenceStatus = 'connecting' | 'online' | 'offline' | 'closed';

/** Who this connection speaks for. */
export interface Identity {
  guest: boolean;
  /** Over the cap on guests from one address: nobody sees them until there is room or they join. */
  unseen: boolean;
  name: string;
  outfit: Outfit;
}

export interface RemotePlayer {
  id: number;
  name: string;
  outfit: Outfit;
  state: PlayerState;
}

export interface PresenceOptions {
  /** Defaults to `/ws` on the page's origin, `wss:` on an `https:` page. */
  url?: string | URL;
  /** Our figure's id on this connection. Drop every remote player you had. */
  onWelcome?: (you: number) => void;
  /** Who we are: on connecting, and again whenever that changes (signing in or out anywhere). */
  onIdentity?: (identity: Identity) => void;
  /** A figure we can see is someone else now, in place: same id, a new name and look. */
  onRenamed?: (id: number, name: string, outfit: Outfit) => void;
  /** Our figure moved, driven from another of our tabs. */
  onOwn?: (state: PlayerState) => void;
  /** Whether a claim to drive should be made as soon as a socket opens. */
  inUse?: () => boolean;
  /** Those who came within what we hear of, in one batch a tick. */
  onJoin?: (players: RemotePlayer[]) => void;
  /** Those who went out of it, gone or further off. */
  onLeave?: (ids: number[]) => void;
  /** The players who moved since the last tick (at most 10 times a second). */
  onStates?: (players: PlayerUpdate[]) => void;
  onOutfit?: (id: number, outfit: Outfit) => void;
  /** How many players are on the map, whoever we hear of. */
  onOnline?: (count: number) => void;
  /** Everyone on the map as dots, every couple of seconds while `dots(true)`. */
  onDots?: (dots: Dot[]) => void;
  onStatus?: (status: PresenceStatus) => void;
  /** The WebSocket class, for tests or other runtimes. */
  WebSocket?: WebSockets.connect.Options['WebSocket'];
  /** A steady clock (ms), for tests. */
  now?: () => number;
}

export interface Presence {
  /** Hands over the avatar's latest state; call it as often as you like, every frame is fine. */
  send(state: PlayerState): void;
  /** Where the map looks now; call it as often as you like. */
  view(x: number, z: number): void;
  /** Whether the full map is open and wants a dot for everyone online. */
  dots(on: boolean): void;
  /** This tab is the one in use: it moves the figure from now on, whichever had it before. */
  drive(): void;
  /** Disconnects for good. */
  close(): void;
}

/** A view is said again once it has moved this far (m), or to another cell, at most this often (ms). */
const VIEW_STEP = 40;
const VIEW_INTERVAL = 250;

/** A server that turned us away on purpose (1008) won't change its mind on a retry. */
const FINAL = new Set([1008]);

const ignore = () => {};

function pageUrl(): string {
  const { protocol, host } = globalThis.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/ws`;
}

export function connectPresence(options: PresenceOptions = {}): Presence {
  const now = options.now ?? (() => performance.now());
  const stop = new AbortController();
  let status: PresenceStatus | undefined;
  let online = false;
  let you = 0;
  /** Whether this tab moves the figure; the server has the last word. */
  let driving = false;
  let latest: PlayerState | null = null;
  let sent: Sent | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let viewTimer: ReturnType<typeof setTimeout> | undefined;
  let look: [number, number] | null = null;
  let told: [number, number] | null = null;
  let toldAt = Number.NEGATIVE_INFINITY;
  let wantsDots = false;
  /** Where each player we hear of is: a move doesn't say, a join or a door does. */
  const places = new Map<number, Pick<PlayerState, 'place' | 'floor'>>();
  /** Each figure's last move: a delta says how the next differs from it. */
  const lastMoves = new Map<number, Move>();

  const report = (next: PresenceStatus) => {
    if (status === next || status === 'closed') return;
    status = next;
    options.onStatus?.(next);
  };
  report('connecting');

  const { readable, writable } = WebSockets.connect(options.url ?? pageUrl, {
    signal: stop.signal,
    delay: { initial: 1000, max: 15_000 },
    reconnectIf({ code }) {
      // Decided here rather than when the socket drops, so a final close is never shown as
      // a brief `offline` first.
      const again = !FINAL.has(code);
      if (again) report('offline');
      return again;
    },
    WebSocket: options.WebSocket,
    open({ send, signal }) {
      online = true;
      sent = null;
      driving = false;
      signal.addEventListener('abort', () => {
        online = false;
        clearTimeout(timer);
        clearTimeout(viewTimer);
      });
      report('online');
      told = null;
      toldAt = Number.NEGATIVE_INFINITY;
      if (look) {
        send(encodeClientMessage({ type: 'view', x: look[0], z: look[1] }));
        told = look;
        toldAt = now();
      }
      if (wantsDots) send(encodeClientMessage({ type: 'dots', on: true }));
      // The tab being used takes its figure back at once, and says where it is before anything
      // else (the server forgot it with the old connection). Any other waits to be told it drives.
      if (options.inUse?.()) {
        driving = true;
        send(encodeClientMessage({ type: 'drive' }));
        if (latest) {
          send(encodeClientMessage({ type: 'state', state: latest }));
          sent = { state: latest, at: now() };
          schedule(sendDelay(sent, latest, now()));
        }
      }
    },
  });
  const writer = writable.getWriter();
  // A write fails only once the connection is gone for good, which the reader reports.
  writer.closed.catch(ignore);

  function schedule(wait: number) {
    clearTimeout(timer);
    timer = setTimeout(pump, wait);
  }

  /** Sends the latest state if it is time, and comes back when it will be. */
  function pump() {
    if (!online || !driving || !latest) return;
    const wait = sendDelay(sent, latest, now());
    if (wait === 0) {
      writer.write(encodeClientMessage({ type: 'state', state: latest })).catch(ignore);
      sent = { state: latest, at: now() };
      schedule(sendDelay(sent, latest, now()));
    } else {
      schedule(wait);
    }
  }

  /** Says where the map looks, if it has moved enough since last said and it is time. */
  function pumpView() {
    if (!online || !look) return;
    if (told) {
      const far = Math.hypot(look[0] - told[0], look[1] - told[1]) >= VIEW_STEP;
      if (!far && cellAt(...look) === cellAt(...told)) return;
    }
    const wait = toldAt + VIEW_INTERVAL - now();
    if (wait > 0) {
      clearTimeout(viewTimer);
      viewTimer = setTimeout(pumpView, wait);
      return;
    }
    writer.write(encodeClientMessage({ type: 'view', x: look[0], z: look[1] })).catch(ignore);
    told = look;
    toldAt = now();
  }

  function receive(value: WebSockets.Message) {
    const message = typeof value === 'string' ? null : decodeServerMessage(value);
    switch (message?.type) {
      case 'welcome':
        you = message.you;
        places.clear();
        lastMoves.clear();
        options.onWelcome?.(you);
        break;
      case 'identity':
        options.onIdentity?.(message);
        break;
      case 'renamed':
        if (message.id !== you) options.onRenamed?.(message.id, message.name, message.outfit);
        break;
      case 'driving':
        if (driving === message.on) break;
        driving = message.on;
        if (driving) {
          // Our turn: say where the figure is now, at once.
          sent = null;
          pump();
        } else {
          clearTimeout(timer);
        }
        break;
      case 'joins': {
        const others = message.players.filter((p) => p.id !== you);
        for (const { id, state } of others) places.set(id, state);
        if (others.length) options.onJoin?.(others);
        break;
      }
      case 'leaves':
        for (const id of message.ids) {
          places.delete(id);
          lastMoves.delete(id);
        }
        options.onLeave?.(message.ids);
        break;
      case 'moves': {
        const updates: PlayerUpdate[] = [];
        for (const entry of message.players) {
          const { id } = entry;
          const last = lastMoves.get(id);
          // The server only sends a delta from a move it sent us, so this is never a guess.
          const move = 'delta' in entry ? last && moved(last, entry.delta) : entry.state;
          if (!move) continue;
          lastMoves.set(id, move);
          const at = places.get(id);
          if (at && id !== you) {
            updates.push({ id, state: { ...move, place: at.place, floor: at.floor } });
          }
        }
        if (updates.length) options.onStates?.(updates);
        break;
      }
      case 'placed':
        if (message.id === you) {
          // Our figure, moved from another tab. Should this tab take over, it goes on from here.
          if (driving) break;
          latest = message.state;
          options.onOwn?.(message.state);
          break;
        }
        // A door: the figure is somewhere else at once, told in full.
        if (places.has(message.id)) {
          places.set(message.id, message.state);
          options.onStates?.([{ id: message.id, state: message.state }]);
        }
        break;
      case 'outfit':
        options.onOutfit?.(message.id, message.outfit);
        break;
      case 'online':
        options.onOnline?.(message.count);
        break;
      case 'dots':
        options.onDots?.(message.players.filter((p) => p.id !== you));
        break;
    }
  }

  /** The stream ends only for good: closed by us, or by a server that won't have us back. */
  const ended = () => {
    online = false;
    clearTimeout(timer);
    report('closed');
  };
  readable.pipeTo(new WritableStream({ write: receive })).then(ended, ended);

  return {
    send(state) {
      latest = state;
      pump();
    },
    view(x, z) {
      look = [x, z];
      pumpView();
    },
    dots(on) {
      wantsDots = on;
      if (online) writer.write(encodeClientMessage({ type: 'dots', on })).catch(ignore);
    },
    drive() {
      if (!online || driving) return;
      driving = true;
      writer.write(encodeClientMessage({ type: 'drive' })).catch(ignore);
      sent = null;
      pump();
    },
    close() {
      clearTimeout(timer);
      clearTimeout(viewTimer);
      online = false;
      report('closed');
      stop.abort();
    },
  };
}
