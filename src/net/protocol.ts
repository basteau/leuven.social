/**
 * The presence wire format, shared by the browser and the server: one binary WebSocket message
 * per frame, a tag byte then the fields, big-endian. Positions are f32 metres (east and south of
 * the city's middle, as `City` has them); the rest is quantised to what a figure on screen can
 * show, so a state is 14 bytes plus its room id.
 *
 *   client → server  state    x f32, z f32, heading u16, speed u8, mode u8, floor i8, place
 *   server → client  welcome  you
 *                    join     id, name, outfit, state
 *                    leave    id
 *                    states   count, then (id, state) × count
 *                    outfit   id, outfit
 *
 * Ids and lengths are unsigned varints; strings are UTF-8 after their byte length; an outfit is
 * four 24-bit colours. Decoding never throws: a frame that is short, long, out of range or not
 * UTF-8 decodes to null, so a stranger's bytes can't take the server down.
 */

import * as Binary from '@portable/binary';

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

export type ClientMessage = { type: 'state'; state: PlayerState };

export type ServerMessage =
  /** Sent first on every connection: your id, or 0 for a guest who only watches. */
  | { type: 'welcome'; you: number }
  | { type: 'join'; id: number; name: string; outfit: Outfit; state: PlayerState }
  | { type: 'leave'; id: number }
  /** The players who moved since the last tick, batched. */
  | { type: 'states'; players: PlayerUpdate[] }
  | { type: 'outfit'; id: number; outfit: Outfit };

/**
 * The close code for a connection that the same account replaced by signing in elsewhere. It
 * is final: the old tab must not reconnect and push the new one out in turn.
 */
export const CLOSE_REPLACED = 4001;

const TAG = { state: 1, welcome: 10, join: 11, leave: 12, states: 13, outfit: 14 } as const;
const MODES: readonly Mode[] = ['foot', 'bike'];
const TURN = Math.PI * 2;
const HEADINGS = 65536;
/** Tenths of a metre a second. */
const SPEED_STEPS = 10;
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
  const turns = finite(s.heading) / TURN;
  w.uint16(Math.round((turns - Math.floor(turns)) * HEADINGS) % HEADINGS);
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
  writeState(w, message.state);
  return w.toBytes();
}

export function decodeClientMessage(bytes: Uint8Array): ClientMessage | null {
  return decode(bytes, (r, tag) =>
    tag === TAG.state ? { type: 'state', state: readState(r) } : null,
  );
}

/** Encodes a server message; throws a RangeError for an id or string the format can't hold. */
export function encodeServerMessage(message: ServerMessage): Uint8Array<ArrayBuffer> {
  const w = Binary.createWriter();
  w.uint8(TAG[message.type]);
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
    case 'join':
      id(message.id);
      writeString(w, message.name, MAX_NAME_BYTES);
      writeOutfit(w, message.outfit);
      writeState(w, message.state);
      break;
    case 'leave':
      id(message.id);
      break;
    case 'states':
      w.varint(message.players.length);
      for (const player of message.players) {
        id(player.id);
        writeState(w, player.state);
      }
      break;
    case 'outfit':
      id(message.id);
      writeOutfit(w, message.outfit);
      break;
  }
  return w.toBytes();
}

export function decodeServerMessage(bytes: Uint8Array): ServerMessage | null {
  return decode<ServerMessage>(bytes, (r, tag) => {
    switch (tag) {
      case TAG.welcome:
        return { type: 'welcome', you: readId(r) };
      case TAG.join:
        return {
          type: 'join',
          id: readId(r),
          name: readString(r, MAX_NAME_BYTES),
          outfit: readOutfit(r),
          state: readState(r),
        };
      case TAG.leave:
        return { type: 'leave', id: readId(r) };
      case TAG.states: {
        const count = r.varint();
        // Each player takes at least 15 bytes: a count past that is a lie, not a big batch.
        if (count * 15 > r.remaining) throw new MalformedFrame();
        const players: PlayerUpdate[] = [];
        for (let i = 0; i < count; i++) players.push({ id: readId(r), state: readState(r) });
        return { type: 'states', players };
      }
      case TAG.outfit:
        return { type: 'outfit', id: readId(r), outfit: readOutfit(r) };
      default:
        return null;
    }
  });
}

/** A state as the other side will see it: rounded to the wire's steps. */
export function quantise(state: PlayerState): PlayerState {
  const message = decodeClientMessage(encodeClientMessage({ type: 'state', state }));
  if (!message) throw new RangeError('The state does not fit the wire format');
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
