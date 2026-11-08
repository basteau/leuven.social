/**
 * The live connection to the other players: one WebSocket to `/ws` on the page's own origin,
 * which comes back by itself after a drop. The session cookie says who we are; without one we
 * are a guest who sees everyone but isn't seen. The avatar's state goes out through
 * `send`, throttled (throttle.ts); what comes back is decoded and handed to the callbacks, minus
 * our own echo.
 *
 * Each connection starts with `onWelcome`: forget every other player then, since ids are only
 * good for one connection, and the joins of those nearby follow. The server tells it only of the
 * players round where the map looks, so `view` keeps it up to date with that.
 */

import * as WebSockets from '@portable/websockets';

import { cellAt } from './interest.ts';
import { CLOSE_REPLACED, decodeServerMessage, encodeClientMessage, moved } from './protocol.ts';
import type { Dot, Move, Outfit, PlayerState, PlayerUpdate } from './protocol.ts';
import { sendDelay } from './throttle.ts';
import type { Sent } from './throttle.ts';

/**
 * `connecting` at first, `online` while connected, `offline` while it tries again, `replaced`
 * once the same account signed in somewhere else (final), `closed` after `close()` or when the
 * server turned us away for good.
 */
export type PresenceStatus = 'connecting' | 'online' | 'offline' | 'replaced' | 'closed';

export interface RemotePlayer {
  id: number;
  name: string;
  outfit: Outfit;
  state: PlayerState;
}

export interface PresenceOptions {
  /** Defaults to `/ws` on the page's origin, `wss:` on an `https:` page. */
  url?: string | URL;
  /** Our id on this connection, or 0 as a guest. Drop every remote player you had. */
  onWelcome?: (you: number) => void;
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
  /** Disconnects for good. */
  close(): void;
}

/** A view is said again once it has moved this far (m), or to another cell, at most this often (ms). */
const VIEW_STEP = 40;
const VIEW_INTERVAL = 250;

/** A server that turned us away on purpose (1008) won't change its mind on a retry. */
const FINAL = new Set([CLOSE_REPLACED, 1008]);

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
    if (status === next || status === 'replaced' || status === 'closed') return;
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
      // The server forgot us with the old connection: say where we are before anything else.
      if (latest) {
        send(encodeClientMessage({ type: 'state', state: latest }));
        sent = { state: latest, at: now() };
        schedule(sendDelay(sent, latest, now()));
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
    if (!online || !latest) return;
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
        // A door: the figure is somewhere else at once, told in full.
        if (message.id !== you && places.has(message.id)) {
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
  const ended = (error?: unknown) => {
    online = false;
    clearTimeout(timer);
    const replaced = error instanceof WebSockets.CloseError && error.code === CLOSE_REPLACED;
    report(replaced ? 'replaced' : 'closed');
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
    close() {
      clearTimeout(timer);
      clearTimeout(viewTimer);
      online = false;
      report('closed');
      stop.abort();
    },
  };
}
