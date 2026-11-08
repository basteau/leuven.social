/**
 * The presence wire format, shared by the browser and the server: one binary WebSocket message
 * per frame, a tag byte then the fields, big-endian. A client's own state is 14 bytes plus its room
 * id. A `moves` entry, of which a client hears hundreds a second, is 9: where a figure is as two
 * 16-bit offsets across the 3×3 cells that frame is about (under 2 cm a step), its heading, and
 * its speed with its mode in the top bit; a change of room or floor is its own `placed` message.
 *
 *   client → server  state    x f32, z f32, heading u16, speed u8, mode u8, floor i8, place
 *                    view     x f32, z f32 (what the map looks at, which decides who it hears of)
 *                    dots     on u8 (the full map is open: send everyone's dots)
 *   server → client  welcome  you
 *                    joins    count, then (id, name, outfit, state) × count
 *                    leaves   count, then id × count
 *                    moves    cell x i16, cell z i16, count, then (id, x u16, z u16, heading u16, speed+mode u8) × count
 *                    placed   id, state
 *                    outfit   id, outfit
 *                    online   count
 *                    dots     count, then (id, x u16, z u16, colour u24) × count
 *
 * Ids and lengths are unsigned varints; strings are UTF-8 after their byte length; an outfit is
 * four 24-bit colours. Decoding never throws: a frame that is short, long, out of range or not
 * UTF-8 decodes to null, so a stranger's bytes can't take the server down.
 */

import * as Binary from '@portable/binary';

import { VIEW_AREA } from '../data/area.ts';
import { CELL_SIZE } from '../data/grid.ts';

export type Mode = 'foot' | 'bike';

/** Where a figure is and what it is doing. */
export interface PlayerState {
  /** Metres east of the city's middle. */
  x: number;
  /** Metres south of the city's middle. */
  z: number;
  /** Radians, as the avatar has it; sent to a 65536th of a turn. */
  heading: number;
  /** Metres a second, 0 to 25.5 in tenths. */
  speed: number;
  mode: Mode;
  /** The room id the figure is in, `''` in the street. */
  place: string;
  /** The floor of that room, 0 in the street. */
  floor: number;
}

/** A figure's colours, each a 24-bit RGB integer such as 0xfa8064. */
export interface Outfit {
  skin: number;
  hair: number;
  shirt: number;
  shorts: number;
}

export interface PlayerUpdate {
  id: number;
  state: PlayerState;
}

/** Where a figure is and how it goes: the part of a state that changes from step to step. */
export type Move = Pick<PlayerState, 'x' | 'z' | 'heading' | 'speed' | 'mode'>;

/** Someone a client hasn't heard of yet. */
export interface JoinedPlayer {
  id: number;
  name: string;
  outfit: Outfit;
  state: PlayerState;
}

/** A dot on the full map: anyone online, wherever they are. */
export interface Dot {
  id: number;
  x: number;
  z: number;
  colour: number;
}

export type ClientMessage =
  | { type: 'state'; state: PlayerState }
  /** Where the map looks: the players round it are the ones this client hears of. */
  | { type: 'view'; x: number; z: number }
  /** Whether the full map is open, and wants a dot for everyone online. */
  | { type: 'dots'; on: boolean };

export type ServerMessage =
  /** Sent first on every connection: your id, or 0 for a guest who only watches. */
  | { type: 'welcome'; you: number }
  /** Players now within what this client hears of: arrivals, and those it came near. */
  | { type: 'joins'; players: JoinedPlayer[] }
  /** Players no longer within it (gone, or just further off). */
  | { type: 'leaves'; ids: number[] }
  /** The figures that moved, placed across the 3×3 cells round cell (`cx`, `cz`). */
  | { type: 'moves'; cx: number; cz: number; players: readonly { id: number; state: Move }[] }
  /** A figure that went into a room or out, or changed floor. */
  | { type: 'placed'; id: number; state: PlayerState }
  | { type: 'outfit'; id: number; outfit: Outfit }
  /** How many players are on the map. */
  | { type: 'online'; count: number }
  /** Everyone on the map, for the full map's dots. */
  | { type: 'dots'; players: Dot[] };

/**
 * The close code for a connection that the same account replaced by signing in elsewhere. It
 * is final: the old tab must not reconnect and push the new one out in turn.
 */
export const CLOSE_REPLACED = 4001;

const TAG = {
  state: 1,
  view: 2,
  dots: 3,
  welcome: 10,
  // 11 to 13 were single joins, leaves and full states: an old tab reads the new ones as nothing.
  outfit: 14,
  joins: 15,
  leaves: 16,
  moves: 17,
  placed: 18,
  online: 19,
  dotsAll: 20,
} as const;
const MODES: readonly Mode[] = ['foot', 'bike'];
const TURN = Math.PI * 2;
const HEADINGS = 65536;
/** Tenths of a metre a second. */
const SPEED_STEPS = 10;
/** In a `moves` entry, speed is in fifths of a metre a second, in seven bits; the top one is the mode. */
const MOVE_SPEED_STEPS = 5;
const MOVE_BIKE = 0x80;
const OFFSETS = 65535;
/** Three cells across, in `moves`. */
const SPAN = CELL_SIZE * 3;
/** The whole map, in `dots`. */
const AREA_SPAN = Math.max(VIEW_AREA.maxX - VIEW_AREA.minX, VIEW_AREA.maxZ - VIEW_AREA.minZ);
/** The smallest entries, to refuse a count that is a lie and not a big batch. */
const MIN_JOIN = 1 + 1 + 12 + 15;
const MIN_MOVE = 8;
const MIN_DOT = 8;
export const MAX_SPEED = 25.5;
/** Room ids are short slugs; a name is a username. Longer strings are refused, not cut. */
export const MAX_PLACE_BYTES = 64;
export const MAX_NAME_BYTES = 64;
const MAX_ID = 0xffff_ffff;
const STRICT = { fatal: true } as const;

/** Thrown by `read` helpers on a value the format can't hold; caught by the decoders. */
class MalformedFrame extends Error {}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const finite = (v: number) => (Number.isFinite(v) ? v : 0);

function writeString(w: Binary.Writer, text: string, max: number): void {
  const bytes = Binary.utf8Length(text);
  if (bytes > max) throw new RangeError(`"${text.slice(0, 20)}…" is longer than ${max} bytes`);
  w.varint(bytes);
  w.string(text);
}

function readString(r: Binary.Reader, max: number): string {
  const bytes = r.varint();
  if (bytes > max) throw new MalformedFrame();
  return r.string(bytes, STRICT);
}

function readId(r: Binary.Reader): number {
  const id = r.varint();
  if (id > MAX_ID) throw new MalformedFrame();
  return id;
}

function writeState(w: Binary.Writer, s: PlayerState): void {
  w.float32(s.x);
  w.float32(s.z);
  writeHeading(w, s.heading);
  w.uint8(Math.round(clamp(finite(s.speed), 0, MAX_SPEED) * SPEED_STEPS));
  w.uint8(s.mode === 'bike' ? 1 : 0);
  w.int8(clamp(Math.round(finite(s.floor)), -128, 127));
  writeString(w, s.place, MAX_PLACE_BYTES);
}

function readState(r: Binary.Reader): PlayerState {
  const x = r.float32();
  const z = r.float32();
  const heading = (r.uint16() / HEADINGS) * TURN;
  const speed = r.uint8() / SPEED_STEPS;
  const mode = MODES[r.uint8()];
  const floor = r.int8();
  const place = readString(r, MAX_PLACE_BYTES);
  if (!mode || !Number.isFinite(x) || !Number.isFinite(z)) throw new MalformedFrame();
  return { x, z, heading, speed, mode, place, floor };
}

function writeHeading(w: Binary.Writer, heading: number): void {
  const turns = finite(heading) / TURN;
  w.uint16(Math.round((turns - Math.floor(turns)) * HEADINGS) % HEADINGS);
}

/** `v` as a 16-bit step of `span` metres from `from`. */
const offset = (v: number, from: number, span: number) =>
  Math.round((clamp(finite(v) - from, 0, span) / span) * OFFSETS);

function writeMove(w: Binary.Writer, m: Move, x0: number, z0: number): void {
  w.uint16(offset(m.x, x0, SPAN));
  w.uint16(offset(m.z, z0, SPAN));
  writeHeading(w, m.heading);
  const speed = Math.min(127, Math.round(clamp(finite(m.speed), 0, MAX_SPEED) * MOVE_SPEED_STEPS));
  w.uint8(speed | (m.mode === 'bike' ? MOVE_BIKE : 0));
}

function readMove(r: Binary.Reader, x0: number, z0: number): Move {
  const x = x0 + (r.uint16() / OFFSETS) * SPAN;
  const z = z0 + (r.uint16() / OFFSETS) * SPAN;
  const heading = (r.uint16() / HEADINGS) * TURN;
  const byte = r.uint8();
  return {
    x,
    z,
    heading,
    speed: (byte & ~MOVE_BIKE) / MOVE_SPEED_STEPS,
    mode: byte & MOVE_BIKE ? 'bike' : 'foot',
  };
}

function writeOutfit(w: Binary.Writer, o: Outfit): void {
  for (const colour of [o.skin, o.hair, o.shirt, o.shorts]) w.uint(3, colour);
}

function readOutfit(r: Binary.Reader): Outfit {
  return { skin: r.uint(3), hair: r.uint(3), shirt: r.uint(3), shorts: r.uint(3) };
}

/** Reads a whole frame, or null when anything about it is off, including bytes left over. */
function decode<T>(bytes: Uint8Array, read: (r: Binary.Reader, tag: number) => T | null): T | null {
  try {
    const r = Binary.createReader(bytes);
    const message = read(r, r.uint8());
    return message && r.remaining === 0 ? message : null;
  } catch {
    // Truncated, overlong varints, bad UTF-8 and out-of-range values all land here.
    return null;
  }
}

export function encodeClientMessage(message: ClientMessage): Uint8Array<ArrayBuffer> {
  const w = Binary.createWriter();
  w.uint8(TAG[message.type]);
  switch (message.type) {
    case 'state':
      writeState(w, message.state);
      break;
    case 'view':
      w.float32(message.x);
      w.float32(message.z);
      break;
    case 'dots':
      w.uint8(message.on ? 1 : 0);
      break;
  }
  return w.toBytes();
}

export function decodeClientMessage(bytes: Uint8Array): ClientMessage | null {
  return decode<ClientMessage>(bytes, (r, tag) => {
    switch (tag) {
      case TAG.state:
        return { type: 'state', state: readState(r) };
      case TAG.view: {
        const [x, z] = [r.float32(), r.float32()];
        if (!Number.isFinite(x) || !Number.isFinite(z)) throw new MalformedFrame();
        return { type: 'view', x, z };
      }
      case TAG.dots:
        return { type: 'dots', on: r.uint8() === 1 };
      default:
        return null;
    }
  });
}

/** Encodes a server message; throws a RangeError for an id or string the format can't hold. */
export function encodeServerMessage(message: ServerMessage): Uint8Array<ArrayBuffer> {
  const w = Binary.createWriter();
  w.uint8(TAG[message.type === 'dots' ? 'dotsAll' : message.type]);
  const id = (value: number) => {
    if (!Number.isInteger(value) || value < 0 || value > MAX_ID) {
      throw new RangeError(`${value} is not a u32 id`);
    }
    w.varint(value);
  };
  switch (message.type) {
    case 'welcome':
      id(message.you);
      break;
    case 'joins':
      w.varint(message.players.length);
      for (const player of message.players) {
        id(player.id);
        writeString(w, player.name, MAX_NAME_BYTES);
        writeOutfit(w, player.outfit);
        writeState(w, player.state);
      }
      break;
    case 'leaves':
      w.varint(message.ids.length);
      for (const value of message.ids) id(value);
      break;
    case 'moves': {
      w.int16(message.cx);
      w.int16(message.cz);
      w.varint(message.players.length);
      const x0 = (message.cx - 1) * CELL_SIZE;
      const z0 = (message.cz - 1) * CELL_SIZE;
      for (const player of message.players) {
        id(player.id);
        writeMove(w, player.state, x0, z0);
      }
      break;
    }
    case 'placed':
      id(message.id);
      writeState(w, message.state);
      break;
    case 'outfit':
      id(message.id);
      writeOutfit(w, message.outfit);
      break;
    case 'online':
      w.varint(message.count);
      break;
    case 'dots':
      w.varint(message.players.length);
      for (const dot of message.players) {
        id(dot.id);
        w.uint16(offset(dot.x, VIEW_AREA.minX, AREA_SPAN));
        w.uint16(offset(dot.z, VIEW_AREA.minZ, AREA_SPAN));
        w.uint(3, dot.colour);
      }
      break;
  }
  return w.toBytes();
}

export function decodeServerMessage(bytes: Uint8Array): ServerMessage | null {
  return decode<ServerMessage>(bytes, (r, tag) => {
    switch (tag) {
      case TAG.welcome:
        return { type: 'welcome', you: readId(r) };
      case TAG.joins: {
        const count = r.varint();
        if (count * MIN_JOIN > r.remaining) throw new MalformedFrame();
        const players: JoinedPlayer[] = [];
        for (let i = 0; i < count; i++) {
          players.push({
            id: readId(r),
            name: readString(r, MAX_NAME_BYTES),
            outfit: readOutfit(r),
            state: readState(r),
          });
        }
        return { type: 'joins', players };
      }
      case TAG.leaves: {
        const count = r.varint();
        if (count > r.remaining) throw new MalformedFrame();
        const ids: number[] = [];
        for (let i = 0; i < count; i++) ids.push(readId(r));
        return { type: 'leaves', ids };
      }
      case TAG.moves: {
        const [cx, cz] = [r.int16(), r.int16()];
        const count = r.varint();
        if (count * MIN_MOVE > r.remaining) throw new MalformedFrame();
        const x0 = (cx - 1) * CELL_SIZE;
        const z0 = (cz - 1) * CELL_SIZE;
        const players: { id: number; state: Move }[] = [];
        for (let i = 0; i < count; i++) {
          players.push({ id: readId(r), state: readMove(r, x0, z0) });
        }
        return { type: 'moves', cx, cz, players };
      }
      case TAG.placed:
        return { type: 'placed', id: readId(r), state: readState(r) };
      case TAG.outfit:
        return { type: 'outfit', id: readId(r), outfit: readOutfit(r) };
      case TAG.online:
        return { type: 'online', count: r.varint() };
      case TAG.dotsAll: {
        const count = r.varint();
        if (count * MIN_DOT > r.remaining) throw new MalformedFrame();
        const players: Dot[] = [];
        for (let i = 0; i < count; i++) {
          players.push({
            id: readId(r),
            x: VIEW_AREA.minX + (r.uint16() / OFFSETS) * AREA_SPAN,
            z: VIEW_AREA.minZ + (r.uint16() / OFFSETS) * AREA_SPAN,
            colour: r.uint(3),
          });
        }
        return { type: 'dots', players };
      }
      default:
        return null;
    }
  });
}

/** A state as the other side will see it: rounded to the wire's steps. */
export function quantise(state: PlayerState): PlayerState {
  const message = decodeClientMessage(encodeClientMessage({ type: 'state', state }));
  if (message?.type !== 'state') throw new RangeError('The state does not fit the wire format');
  return message.state;
}

const isColour = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffff;

/** Whether a parsed JSON value is an outfit: four 24-bit colours and nothing else. */
export function isOutfit(value: unknown): value is Outfit {
  if (typeof value !== 'object' || value === null) return false;
  const keys = Object.keys(value);
  const o = value as Record<string, unknown>;
  return (
    keys.length === 4 &&
    isColour(o.skin) &&
    isColour(o.hair) &&
    isColour(o.shirt) &&
    isColour(o.shorts)
  );
}
