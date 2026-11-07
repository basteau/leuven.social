/**
 * The live connection to the other players: one WebSocket to `/ws` on the page's own origin,
 * which comes back by itself after a drop. The session cookie says who we are; without one we
 * are a guest who sees everyone but isn't seen. The avatar's state goes out through
 * `send`, throttled (throttle.ts); what comes back is decoded and handed to the callbacks, minus
 * our own echo.
 *
 * Each connection starts with `onWelcome`: forget every other player then, since ids are only
 * good for one connection, and the joins of everyone online follow.
 */

import * as WebSockets from '@portable/websockets';

import { CLOSE_REPLACED, decodeServerMessage, encodeClientMessage } from './protocol.ts';
import type { Outfit, PlayerState, PlayerUpdate } from './protocol.ts';
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
  onJoin?: (player: RemotePlayer) => void;
  onLeave?: (id: number) => void;
  /** The players who moved since the last tick (at most 10 times a second). */
  onStates?: (players: PlayerUpdate[]) => void;
  onOutfit?: (id: number, outfit: Outfit) => void;
  onStatus?: (status: PresenceStatus) => void;
  /** The WebSocket class, for tests or other runtimes. */
  WebSocket?: WebSockets.connect.Options['WebSocket'];
  /** A steady clock (ms), for tests. */
  now?: () => number;
}

export interface Presence {
  /** Hands over the avatar's latest state; call it as often as you like, every frame is fine. */
  send(state: PlayerState): void;
  /** Disconnects for good. */
  close(): void;
}

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
      });
      report('online');
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

  function receive(value: WebSockets.Message) {
    const message = typeof value === 'string' ? null : decodeServerMessage(value);
    switch (message?.type) {
      case 'welcome':
        you = message.you;
        options.onWelcome?.(you);
        break;
      case 'join':
        if (message.id !== you) options.onJoin?.(message);
        break;
      case 'leave':
        options.onLeave?.(message.id);
        break;
      case 'states': {
        const others = message.players.filter((p) => p.id !== you);
        if (others.length) options.onStates?.(others);
        break;
      }
      case 'outfit':
        options.onOutfit?.(message.id, message.outfit);
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
    close() {
      clearTimeout(timer);
      online = false;
      report('closed');
      stop.abort();
    },
  };
}
