/**
 * The live connection to the other players: one WebSocket to `/ws` on the page's own origin,
 * which comes back by itself after a drop. A cookie says who we are, an account or this browser's
 * guest, and the server says so back (`onIdentity`), again whenever that changes under us: signing
 * in or out in another tab reaches this one here. One tab of a person moves their figure: the last
 * to `drive`, or else the newest left. The avatar's state goes out through `send`, throttled
 * (throttle.ts), from that tab alone; the others follow the figure (`onOwn`). What comes back goes
 * straight into `people`, minus our own echo: hundreds of movers a frame, one object apiece would
 * be a lot of garbage for nothing.
 *
 * Each connection starts with `onWelcome`: everyone in `people` is forgotten then, since ids are
 * only good for one connection, and the joins of those nearby follow. The server tells it only of
 * the players round where the map looks and how far that reaches (`view`).
 */

import * as WebSockets from '@portable/websockets';

import { FINE_REACH, cellAt } from './interest.ts';
import type { People, Stride } from './people.ts';
import {
  COARSE_TAG,
  TICK_TAG,
  decodeServerMessage,
  encodeClientMessage,
  headingOf,
  metresOf,
  modeOf,
  readCoarse,
  readTick,
  speedOf,
} from './protocol.ts';
import type { CoarseSink, Outfit, PlayerState, TickSink } from './protocol.ts';
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

export interface PresenceOptions {
  /** Defaults to `/ws` on the page's origin, `wss:` on an `https:` page. */
  url?: string | URL;
  /** Where everyone heard of goes: written straight into, and listened to through `onNews`. */
  people: People;
  /** Our figure's id on this connection; `people` was just forgotten, ids being per connection. */
  onWelcome?: (you: number) => void;
  /** Who we are: on connecting, and again whenever that changes (signing in or out anywhere). */
  onIdentity?: (identity: Identity) => void;
  /** Our figure moved, driven from another of our tabs. */
  onOwn?: (state: PlayerState) => void;
  /** Our own outfit changed from another of our tabs. */
  onOwnOutfit?: (outfit: Outfit) => void;
  /** Whether a claim to drive should be made as soon as a socket opens. */
  inUse?: () => boolean;
  /** Something in `people` changed. */
  onNews?: () => void;
  /** How many players are on the map, whoever we hear of. */
  onOnline?: (count: number) => void;
  onStatus?: (status: PresenceStatus) => void;
  /** The WebSocket class, for tests or other runtimes. */
  WebSocket?: WebSockets.connect.Options['WebSocket'];
  /** A steady clock (ms), for tests. */
  now?: () => number;
}

export interface Presence {
  /** Hands over the avatar's latest state; call it as often as you like, every frame is fine. */
  send(state: PlayerState): void;
  /** Where the map looks now and how far it reaches (m); call it as often as you like. */
  view(x: number, z: number, reach: number): void;
  /** This tab is the one in use: it moves the figure from now on, whichever had it before. */
  drive(): void;
  /** Disconnects for good. */
  close(): void;
}

/** A view is said again once it has moved this far (m), or to another cell, at most this often (ms). */
const VIEW_STEP = 40;
const VIEW_INTERVAL = 250;
/** A reach is said again once it has changed by this share. */
const REACH_STEP = 0.12;
/** The highest id a delta can be tracked for. */
const MOST_ID = 1 << 20;

/** A server that turned us away on purpose (1008) won't change its mind on a retry. */
const FINAL = new Set([1008]);

const ignore = () => {};

function pageUrl(): string {
  const { protocol, host } = globalThis.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/ws`;
}

/** Whether a reach has changed enough to be worth saying again. */
function reachChanged(told: number, reach: number): boolean {
  if (told === reach) return false;
  if ((told === 0) !== (reach === 0)) return true;
  if (told <= FINE_REACH !== reach <= FINE_REACH) return true;
  return Math.abs(reach - told) > told * REACH_STEP;
}

export function connectPresence(options: PresenceOptions): Presence {
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
  let look: [number, number, number] | null = null;
  let told: [number, number, number] | null = null;
  let toldAt = Number.NEGATIVE_INFINITY;
  const people = options.people;
  /** When the frame being read came in (ms): one clock reading for all its entries. */
  let frameTime = 0;
  /** What each figure last heard of, in the wire's steps, for a delta to count from. */
  let lastX = new Int32Array(1024);
  let lastZ = new Int32Array(1024);
  let lastHeading = new Uint16Array(1024);
  let lastSpeed = new Uint8Array(1024);
  let lastKnown = new Uint8Array(1024);
  /** One, reused: `people.move` takes the numbers it needs and keeps nothing. */
  const stride: Stride = { x: 0, z: 0, heading: 0, speed: 0, mode: 'foot' };

  function ensure(id: number): void {
    if (id < lastKnown.length) return;
    const size = Math.max(id + 1, lastKnown.length * 2);
    const wider = <T extends Int32Array | Uint16Array | Uint8Array>(a: T): T => {
      const next = new (a.constructor as new (n: number) => T)(size);
      next.set(a);
      return next;
    };
    lastX = wider(lastX);
    lastZ = wider(lastZ);
    lastHeading = wider(lastHeading);
    lastSpeed = wider(lastSpeed);
    lastKnown = wider(lastKnown);
  }

  function say(id: number, x: number, z: number, heading: number, speed: number): void {
    if (id === you) return;
    stride.x = metresOf(x);
    stride.z = metresOf(z);
    stride.heading = headingOf(heading);
    stride.speed = speedOf(speed);
    stride.mode = modeOf(speed);
    people.move(frameTime, id, stride);
  }

  /** Reads ticks straight into `people` and the deltas' baselines. */
  const tickSink: TickSink = {
    beginRecount: () => people.beginRecount(),
    endRecount: () => people.endRecount(frameTime),
    left(id) {
      if (id < lastKnown.length) lastKnown[id] = 0;
      people.leave(frameTime, id);
    },
    demoted: (id) => people.demote(id),
    joined(id, name, outfit, state) {
      if (id !== you) people.join(frameTime, id, name, outfit, state);
    },
    whole(id, x, z, heading, speed) {
      if (id > MOST_ID) return;
      ensure(id);
      lastKnown[id] = 1;
      lastX[id] = x;
      lastZ[id] = z;
      lastHeading[id] = heading;
      lastSpeed[id] = speed;
      say(id, x, z, heading, speed);
    },
    delta(id, dx, dz, heading, speed) {
      // The server only sends a delta from a move it sent us, so this is never a guess.
      if (id > MOST_ID || id >= lastKnown.length || !lastKnown[id]) return;
      lastX[id]! += dx;
      lastZ[id]! += dz;
      if (heading >= 0) lastHeading[id] = heading;
      if (speed >= 0) lastSpeed[id] = speed;
      say(id, lastX[id]!, lastZ[id]!, lastHeading[id]!, lastSpeed[id]!);
    },
  };

  const coarseSink: CoarseSink = {
    begin: () => people.beginCoarse(),
    person(id, x, z, colour, weight) {
      if (id !== you) people.coarse(frameTime, id, x, z, colour, weight);
    },
    end: () => people.endCoarse(frameTime),
  };

  const news = () => options.onNews?.();

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
        send(encodeClientMessage({ type: 'view', x: look[0], z: look[1], reach: look[2] }));
        told = look;
        toldAt = now();
      }
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
      const wider = reachChanged(told[2], look[2]);
      if (!far && !wider && cellAt(look[0], look[1]) === cellAt(told[0], told[1])) return;
    }
    const wait = toldAt + VIEW_INTERVAL - now();
    if (wait > 0) {
      clearTimeout(viewTimer);
      viewTimer = setTimeout(pumpView, wait);
      return;
    }
    writer
      .write(encodeClientMessage({ type: 'view', x: look[0], z: look[1], reach: look[2] }))
      .catch(ignore);
    told = look;
    toldAt = now();
  }

  function receive(value: WebSockets.Message) {
    if (typeof value === 'string') return;
    const tag = value[0];
    if (tag === TICK_TAG || tag === COARSE_TAG) {
      frameTime = now();
      if (tag === TICK_TAG) readTick(value, tickSink);
      else readCoarse(value, coarseSink);
      news();
      return;
    }
    const message = decodeServerMessage(value);
    switch (message?.type) {
      case 'welcome':
        you = message.you;
        people.forget();
        lastKnown.fill(0);
        options.onWelcome?.(you);
        break;
      case 'identity':
        options.onIdentity?.(message);
        break;
      case 'renamed':
        if (message.id !== you) {
          people.restyle(message.id, { name: message.name, outfit: message.outfit });
          news();
        }
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
      case 'placed':
        if (message.id === you) {
          // Our figure, moved from another tab. Should this tab take over, it goes on from here.
          if (driving) break;
          latest = message.state;
          options.onOwn?.(message.state);
          break;
        }
        // A door: the figure is somewhere else at once, told in full.
        people.jump(now(), message.id, message.state);
        news();
        break;
      case 'outfit':
        if (message.id === you) {
          options.onOwnOutfit?.(message.outfit);
          break;
        }
        people.restyle(message.id, { outfit: message.outfit });
        news();
        break;
      case 'online':
        options.onOnline?.(message.count);
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
    view(x, z, reach) {
      look = [x, z, reach];
      pumpView();
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
