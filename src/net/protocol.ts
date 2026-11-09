/**
 * The presence wire format, shared by the browser and the server: one binary WebSocket message
 * per frame, a tag byte then the fields, big-endian. A client's own state is 14 bytes plus its room
 * id. A move in a `tick`, of which a client hears hundreds a second, is 9 bytes: where a figure is as
 * two 16-bit offsets across the 3×3 cells that part of the frame is about (under 2 cm a step), its
 * heading, and its speed with its mode in the top bit; or, for a figure it last heard of nearby, a
 * delta of about 5. A change of room or floor is its own `placed` message.
 *
 *   client → server  state    x f32, z f32, heading u16, speed u8, mode u8, floor i8, place
 *                    view     x f32, z f32, reach u16 (what the map looks at and how far it shows
 *                               anything, which decide who it hears of; 0 is a hidden tab)
 *                    drive    (this tab is in use: it moves the figure from now on)
 *   server → client  welcome  you
 *                    identity flags u8 (1 a guest, 2 unseen), name, outfit (who this connection is, whenever that changes)
 *                    renamed  id, name, outfit (a figure became someone else: signed in or out)
 *                    driving  on u8 (whether this tab is the one that moves the figure)
 *                    tick     flags u8 (1 a recount begins, 2 it ends), then in this order
 *                               leaves  count, id × count
 *                               demotes count, id × count (no longer in full, still coarsely)
 *                               joins   count, (id, name, outfit, state) × count
 *                               near    count, then if any: cell x i16, cell z i16, entries
 *                               far     blocks, then (cell x i8, cell z i8, count, entries) × blocks
 *                    coarse   flags u8 (1 the first page of a frame, 2 the last), then to the end of
 *                               the message (cell x i8, cell z i8, total, weight, count,
 *                               (id, x u8, z u8, colour u16) × count)
 *                    placed   id, state (your own id: your figure, moved from another tab)
 *                    outfit   id, outfit
 *                    online   count
 *
 * A `tick` entry is id×2 (+1 for a delta) then x u16, z u16, heading u16, speed+mode u8, or dx i8,
 * dz i8, what changed u8, then that; a whole entry's position is an offset across the 3×3 cells
 * round its cell (near: the frame's, far: its block's). A `coarse` entry's x and z are 256ths of
 * its cell and its colour is RGB565; `weight` says how many each entry stands for, and sampling is
 * by id % weight, so raising the weight keeps half the sample.
 *
 * Ids and lengths are unsigned varints; strings are UTF-8 after their byte length; an outfit is
 * four 24-bit colours. Decoding never throws: a frame that is short, long, out of range or not
 * UTF-8 decodes to null, so a stranger's bytes can't take the server down.
 */

import * as Binary from '@portable/binary';

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
  /** The floor of that room; in the street 0, or 1 on a bridge's deck or in a tunnel. */
  floor: number;
}

/** A figure's colours, each a 24-bit RGB integer such as 0xfa8064. */
export interface Outfit {
  skin: number;
  hair: number;
  shirt: number;
  shorts: number;
}

/** Where a figure is and how it goes: the part of a state that changes from step to step. */
export type Move = Pick<PlayerState, 'x' | 'z' | 'heading' | 'speed' | 'mode'>;

/** What a `tick` entry says of a figure: the whole move, or how it differs from the last. */
export type MoveEntry = { id: number; state: Move } | { id: number; delta: MoveDelta };

/** How a figure differs from its last move: metres, and what changed of its heading and pace. */
export interface MoveDelta {
  dx: number;
  dz: number;
  heading?: number;
  speed?: number;
  mode?: Mode;
}

/** What a client last heard of a figure, on the wire's steps. */
export interface MoveBaseline {
  x: number;
  z: number;
  heading: number;
  speed: number;
}

/** Someone a client hears of in full: a join, or a recount. */
export interface JoinedPlayer {
  id: number;
  name: string;
  outfit: Outfit;
  state: PlayerState;
}

/** One frame's worth of what changed for a client: see the format above. */
export interface TickMessage {
  type: 'tick';
  /** A recount starts with this frame, and with which frame it ends. */
  beginsRecount?: boolean;
  endsRecount?: boolean;
  leaves: readonly number[];
  demotes: readonly number[];
  joins: readonly JoinedPlayer[];
  /** The cell whose 3×3 `near` is placed across. */
  cx: number;
  cz: number;
  near: readonly MoveEntry[];
  /** Encoded as deltas where these baselines say so; decoded as `MoveEntry`. */
  bases?: readonly (MoveBaseline | undefined)[];
  far: readonly {
    cx: number;
    cz: number;
    moves: readonly { id: number; state: Move }[];
  }[];
}

/** One person in a `coarse` frame: a spot and a shirt. */
export interface CoarseEntry {
  id: number;
  x: number;
  z: number;
  colour: number;
}

/** A cell of a `coarse` frame: everyone there, thinned to one of every `weight` by id. */
export interface CoarseCell {
  cx: number;
  cz: number;
  total: number;
  weight: number;
  people: readonly CoarseEntry[];
}

/** A page of a coarse frame: whoever known coarsely isn't in the frame has gone. */
export interface CoarseMessage {
  type: 'coarse';
  first: boolean;
  last: boolean;
  cells: readonly CoarseCell[];
}

export type ClientMessage =
  | { type: 'state'; state: PlayerState }
  /** Where the map looks and how far from there it shows anything; 0 asks for nobody. */
  | { type: 'view'; x: number; z: number; reach: number }
  /** The tab in use: one figure a person, moved from whichever tab said this last. */
  | { type: 'drive' };

export type ServerMessage =
  /** Sent first on every connection: your figure's id. Every tab of a person has the same one. */
  | { type: 'welcome'; you: number }
  /** Who this connection speaks for; again whenever that changes under it (signing in or out). */
  | { type: 'identity'; guest: boolean; unseen: boolean; name: string; outfit: Outfit }
  /** A figure someone can see is someone else now, in place: same id, a new name and look. */
  | { type: 'renamed'; id: number; name: string; outfit: Outfit }
  /** Whether this tab moves the figure; the others only watch it go. */
  | { type: 'driving'; on: boolean }
  /** What changed for this client, in one frame a tick; rare to send, hot to decode (`readTick`). */
  | TickMessage
  /** Everyone in the street in this client's coarse interest, at most once a second. */
  | CoarseMessage
  /**
   * A figure that went into a room or out, or changed floor. With your own id: where your figure
   * is, moved from another of your tabs.
   */
  | { type: 'placed'; id: number; state: PlayerState }
  | { type: 'outfit'; id: number; outfit: Outfit }
  /** How many players are on the map. */
  | { type: 'online'; count: number };

/** Hears one `tick`, so that thousands of movers a second allocate nothing. */
export interface TickSink {
  /** Where the near part, and each far block that follows, are placed: for tools, not the client. */
  nearHead?(cx: number, cz: number): void;
  blockHead?(cx: number, cz: number): void;
  beginRecount(): void;
  endRecount(): void;
  left(id: number): void;
  demoted(id: number): void;
  joined(id: number, name: string, outfit: Outfit, state: PlayerState): void;
  /** A whole move, in the wire's steps (`metresOf` and friends); deltas count from the last one. */
  whole(id: number, x: number, z: number, heading: number, speedByte: number): void;
  /** How a figure differs from its last move, in steps; heading and speedByte -1 when unchanged. */
  delta(id: number, dx: number, dz: number, heading: number, speedByte: number): void;
}

/** Hears one page of a `coarse` frame. */
export interface CoarseSink {
  begin(): void;
  person(id: number, x: number, z: number, colour: number, weight: number): void;
  end(): void;
}

const TAG = {
  state: 1,
  view: 2,
  // 3 was the full map's dots.
  drive: 4,
  welcome: 10,
  // 11 to 13 were single joins, leaves and full states; 15 to 17 and 20 the joins, leaves, moves
  // and dots that `tick` and `coarse` replaced: an old tab reads the new ones as nothing.
  outfit: 14,
  placed: 18,
  online: 19,
  identity: 21,
  renamed: 22,
  driving: 23,
  tick: 24,
  coarse: 25,
} as const;
/** The first byte of a `tick` and a `coarse` frame: `readTick` and `readCoarse` hear those. */
export const TICK_TAG = TAG.tick;
export const COARSE_TAG = TAG.coarse;
/** Flags of a `tick`. */
export const RECOUNT_BEGINS = 1;
export const RECOUNT_ENDS = 2;
/** Flags of a `coarse` page. */
export const COARSE_FIRST = 1;
export const COARSE_LAST = 2;
const GUEST = 1;
const UNSEEN = 2;
const MODES: readonly Mode[] = ['foot', 'bike'];
const TURN = Math.PI * 2;
const HEADINGS = 65536;
/** Tenths of a metre a second. */
const SPEED_STEPS = 10;
/** In a `tick` entry, speed is in fifths of a metre a second, in seven bits; the top one is the mode. */
const MOVE_SPEED_STEPS = 5;
const MOVE_BIKE = 0x80;
const OFFSETS = 65535;
/** The furthest a delta can say a figure went on either axis, in position steps: about 2 m. */
const MAX_DELTA = 127;
/** Three cells across, in `tick` entries. */
const SPAN = CELL_SIZE * 3;
/** A position step in `tick` entries (m): under 2 cm. */
const STEP = SPAN / OFFSETS;
/** A cell across, in steps: exactly a third of what 16 bits span. */
const CELL_STEPS = OFFSETS / 3;
/** The smallest entries, to refuse a count that is a lie and not a big batch. */
const MIN_JOIN = 1 + 1 + 12 + 15;
const MIN_MOVE = 4;
const MIN_COARSE = 5;
export const MAX_SPEED = 25.5;
/** Room ids are short slugs; a name is a username. Longer strings are refused, not cut. */
export const MAX_PLACE_BYTES = 64;
const MAX_NAME_BYTES = 64;
const MAX_ID = 0xffff_ffff;
const STRICT = { fatal: true } as const;
/** How far a client that doesn't say sees, and the reach of a `view` sent by an old tab (m). */
export const DEFAULT_REACH = CELL_SIZE;
/** The most a `reach` says (m): further than the map is wide. */
export const MAX_REACH = 0xffff;

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
  w.uint16(headingSteps(s.heading));
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

/** Position steps from the origin, whatever the frame: what `tick` entries are measured in. */
export const stepsOf = (metres: number): number => Math.round(finite(metres) / STEP);
/** Steps from the origin to where a cell starts. */
export const cellSteps = (cell: number): number => cell * CELL_STEPS;
/** Steps back to metres. */
export const metresOf = (steps: number): number => steps * STEP;
export const headingSteps = (heading: number): number => {
  const turns = finite(heading) / TURN;
  return Math.round((turns - Math.floor(turns)) * HEADINGS) % HEADINGS;
};
export const headingOf = (steps: number): number => (steps / HEADINGS) * TURN;
/** Speed and mode as one byte of a `tick` entry. */
export const speedByte = (speed: number, mode: Mode): number =>
  Math.min(127, Math.round(clamp(finite(speed), 0, MAX_SPEED) * MOVE_SPEED_STEPS)) |
  (mode === 'bike' ? MOVE_BIKE : 0);
export const speedOf = (byte: number): number => (byte & ~MOVE_BIKE) / MOVE_SPEED_STEPS;
export const modeOf = (byte: number): Mode => (byte & MOVE_BIKE ? 'bike' : 'foot');
/** A colour as RGB565, what a `coarse` entry carries. */
export const rgb565 = (colour: number): number =>
  ((colour >> 8) & 0xf800) | ((colour >> 5) & 0x07e0) | ((colour >> 3) & 0x001f);
/** And back, each channel stretched to fill its range, so white stays white. */
export const rgb888 = (colour: number): number => {
  const r = (colour >> 11) & 31;
  const g = (colour >> 5) & 63;
  const b = colour & 31;
  return (((r << 3) | (r >> 2)) << 16) | (((g << 2) | (g >> 4)) << 8) | ((b << 3) | (b >> 2));
};

/** An output buffer: one, reused, for every frame of a tick. */
export interface Output {
  bytes: Uint8Array<ArrayBuffer>;
  view: DataView;
}

export function createOutput(size: number): Output {
  const bytes = new Uint8Array(size);
  return { bytes, view: new DataView(bytes.buffer) };
}

/** Makes room for `size` bytes, keeping what is there. */
export function reserve(out: Output, size: number): void {
  if (out.bytes.length >= size) return;
  const bytes = new Uint8Array(Math.max(size, out.bytes.length * 2));
  bytes.set(out.bytes);
  out.bytes = bytes;
  out.view = new DataView(bytes.buffer);
}

/** Puts an unsigned varint at `at`; returns the offset after it. */
export function putVarint(out: Output, at: number, value: number): number {
  const { bytes } = out;
  let v = value;
  while (v > 127) {
    bytes[at++] = (v & 127) | 128;
    v = Math.floor(v / 128);
  }
  bytes[at++] = v;
  return at;
}

/**
 * Puts a whole `tick` entry: `x` and `z` are the figure's steps from the origin, `x0` and `z0` the
 * corner, in steps, of the 3×3 cells it is placed across.
 */
export function putWhole(
  out: Output,
  at: number,
  id: number,
  x: number,
  z: number,
  heading: number,
  speed: number,
  x0: number,
  z0: number,
): number {
  const p = putVarint(out, at, id * 2);
  out.view.setUint16(p, clamp(x - x0, 0, OFFSETS));
  out.view.setUint16(p + 2, clamp(z - z0, 0, OFFSETS));
  out.view.setUint16(p + 4, heading);
  out.bytes[p + 6] = speed;
  return p + 7;
}

/**
 * Puts a `tick` entry as a delta from what the client last heard of the figure, or, when there is
 * nothing to go from or the step is too long, whole. About 5 bytes where a whole move is 9. The
 * socket is reliable and in order, so no acknowledgement is needed: the server only has to forget
 * a baseline whenever the client could have missed one (a leave, a recount).
 */
export function putMove(
  out: Output,
  at: number,
  id: number,
  x: number,
  z: number,
  heading: number,
  speed: number,
  x0: number,
  z0: number,
  baseX: number,
  baseZ: number,
  baseHeading: number,
  baseSpeed: number,
): number {
  const dx = x - baseX;
  const dz = z - baseZ;
  if (dx < -MAX_DELTA || dx > MAX_DELTA || dz < -MAX_DELTA || dz > MAX_DELTA) {
    return putWhole(out, at, id, x, z, heading, speed, x0, z0);
  }
  const p = putVarint(out, at, id * 2 + 1);
  const changes = (heading === baseHeading ? 0 : 1) | (speed === baseSpeed ? 0 : 2);
  out.view.setInt8(p, dx);
  out.view.setInt8(p + 1, dz);
  out.bytes[p + 2] = changes;
  let end = p + 3;
  if (changes & 1) {
    out.view.setUint16(end, heading);
    end += 2;
  }
  if (changes & 2) out.bytes[end++] = speed;
  return end;
}

/** Puts a join: as in `joins`, measured against `limit` by the caller. */
export function putJoin(out: Output, at: number, player: JoinedPlayer): number {
  const w = Binary.createWriter();
  writeId(w, player.id);
  writeJoinBody(w, player);
  const frame = w.toBytes();
  reserve(out, at + frame.length);
  out.bytes.set(frame, at);
  return at + frame.length;
}

/**
 * A join as it goes on the wire, encoded once. A crowd joining a thousand clients at once is the same
 * few hundred bytes a thousand times over, so a Writer per join per client is the whole cost of it.
 */
export interface CachedJoin {
  bytes: Uint8Array;
  view: DataView;
  /** Where the state's numbers start, for `freshenJoin`. */
  stateAt: number;
  /** What the bytes say, to know when they are out of date. */
  name: string;
  outfit: Outfit;
  place: string;
  floor: number;
}

export function cacheJoin(player: JoinedPlayer): CachedJoin {
  const w = Binary.createWriter();
  writeId(w, player.id);
  writeString(w, player.name, MAX_NAME_BYTES);
  writeOutfit(w, player.outfit);
  const stateAt = w.length;
  writeState(w, player.state);
  const bytes = w.toBytes();
  return {
    bytes,
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.length),
    stateAt,
    name: player.name,
    outfit: player.outfit,
    place: player.state.place,
    floor: player.state.floor,
  };
}

/** Writes where a figure stands now over a cached join, as `writeState` lays them out. */
export function freshenJoin(cached: CachedJoin, state: PlayerState): void {
  const { view, stateAt: at } = cached;
  view.setFloat32(at, state.x);
  view.setFloat32(at + 4, state.z);
  view.setUint16(at + 8, headingSteps(state.heading));
  view.setUint8(at + 10, Math.round(clamp(finite(state.speed), 0, MAX_SPEED) * SPEED_STEPS));
  view.setUint8(at + 11, state.mode === 'bike' ? 1 : 0);
}

/** Copies a cached join into a frame, as `putJoin` would have written it. */
export function putCachedJoin(out: Output, at: number, cached: CachedJoin): number {
  reserve(out, at + cached.bytes.length);
  out.bytes.set(cached.bytes, at);
  return at + cached.bytes.length;
}

function writeOutfit(w: Binary.Writer, o: Outfit): void {
  for (const colour of [o.skin, o.hair, o.shirt, o.shorts]) w.uint(3, colour);
}

function readOutfit(r: Binary.Reader): Outfit {
  return { skin: r.uint(3), hair: r.uint(3), shirt: r.uint(3), shorts: r.uint(3) };
}

function writeJoinBody(w: Binary.Writer, player: JoinedPlayer): void {
  writeString(w, player.name, MAX_NAME_BYTES);
  writeOutfit(w, player.outfit);
  writeState(w, player.state);
}

function writeId(w: Binary.Writer, value: number): void {
  check(value);
  w.varint(value);
}

function readJoin(r: Binary.Reader): JoinedPlayer {
  return {
    id: readId(r),
    name: readString(r, MAX_NAME_BYTES),
    outfit: readOutfit(r),
    state: readState(r),
  };
}

/** Reads one `tick` entry and hands it on as steps. */
function readEntry(r: Binary.Reader, sink: TickSink, x0: number, z0: number): void {
  const tagged = r.varint();
  const id = Math.floor(tagged / 2);
  if (id > MAX_ID) throw new MalformedFrame();
  if (tagged % 2) {
    const dx = r.int8();
    const dz = r.int8();
    const changes = r.uint8();
    if (changes > 3) throw new MalformedFrame();
    const heading = changes & 1 ? r.uint16() : -1;
    const speed = changes & 2 ? r.uint8() : -1;
    sink.delta(id, dx, dz, heading, speed);
    return;
  }
  const x = r.uint16() + x0;
  const z = r.uint16() + z0;
  const heading = r.uint16();
  sink.whole(id, x, z, heading, r.uint8());
}

/** Reads a `tick` after its tag into `sink`: an entry at a time, no objects per mover. */
function parseTick(r: Binary.Reader, sink: TickSink): void {
  const flags = r.uint8();
  if (flags > (RECOUNT_BEGINS | RECOUNT_ENDS)) throw new MalformedFrame();
  if (flags & RECOUNT_BEGINS) sink.beginRecount();
  const leaves = r.varint();
  if (leaves > r.remaining) throw new MalformedFrame();
  for (let i = 0; i < leaves; i++) sink.left(readId(r));
  const demotes = r.varint();
  if (demotes > r.remaining) throw new MalformedFrame();
  for (let i = 0; i < demotes; i++) sink.demoted(readId(r));
  const joins = r.varint();
  if (joins * MIN_JOIN > r.remaining) throw new MalformedFrame();
  for (let i = 0; i < joins; i++) {
    const player = readJoin(r);
    sink.joined(player.id, player.name, player.outfit, player.state);
  }
  const near = r.varint();
  if (near) {
    const cx = r.int16();
    const cz = r.int16();
    sink.nearHead?.(cx, cz);
    const x0 = cellSteps(cx - 1);
    const z0 = cellSteps(cz - 1);
    if (near * MIN_MOVE > r.remaining) throw new MalformedFrame();
    for (let i = 0; i < near; i++) readEntry(r, sink, x0, z0);
  }
  const blocks = r.varint();
  if (blocks * 3 > r.remaining) throw new MalformedFrame();
  for (let b = 0; b < blocks; b++) {
    const cx = r.int8();
    const cz = r.int8();
    sink.blockHead?.(cx, cz);
    const x0 = cellSteps(cx - 1);
    const z0 = cellSteps(cz - 1);
    const count = r.varint();
    if (count * MIN_MOVE > r.remaining) throw new MalformedFrame();
    for (let i = 0; i < count; i++) readEntry(r, sink, x0, z0);
  }
  if (flags & RECOUNT_ENDS) sink.endRecount();
}

/**
 * Reads a `tick` into `sink`. False when the frame is malformed: decoding stops there, and a sink
 * may have heard the start of it, which only a bug on our own server could cause.
 */
export function readTick(bytes: Uint8Array, sink: TickSink): boolean {
  try {
    const r = Binary.createReader(bytes);
    if (r.uint8() !== TAG.tick) return false;
    parseTick(r, sink);
    return r.remaining === 0;
  } catch {
    return false;
  }
}

function parseCoarse(r: Binary.Reader, sink: CoarseSink): void {
  const flags = r.uint8();
  if (flags > (COARSE_FIRST | COARSE_LAST)) throw new MalformedFrame();
  if (flags & COARSE_FIRST) sink.begin();
  while (r.remaining) {
    const cx = r.int8();
    const cz = r.int8();
    r.varint(); // total: how many are there, sampled or not
    const weight = r.varint();
    const count = r.varint();
    if (weight < 1 || count * MIN_COARSE > r.remaining) throw new MalformedFrame();
    for (let i = 0; i < count; i++) {
      const id = readId(r);
      const x = (cx + (r.uint8() + 0.5) / 256) * CELL_SIZE;
      const z = (cz + (r.uint8() + 0.5) / 256) * CELL_SIZE;
      sink.person(id, x, z, rgb888(r.uint16()), weight);
    }
  }
  if (flags & COARSE_LAST) sink.end();
}

/** Reads a page of a `coarse` frame into `sink`, as `readTick` does. */
export function readCoarse(bytes: Uint8Array, sink: CoarseSink): boolean {
  try {
    const r = Binary.createReader(bytes);
    if (r.uint8() !== TAG.coarse) return false;
    parseCoarse(r, sink);
    return true;
  } catch {
    return false;
  }
}

/** Puts a block of a `coarse` frame. Returns the offset after it. */
export function putCoarseHead(
  out: Output,
  at: number,
  cx: number,
  cz: number,
  total: number,
  weight: number,
  count: number,
): number {
  out.view.setInt8(at, cx);
  out.view.setInt8(at + 1, cz);
  let p = putVarint(out, at + 2, total);
  p = putVarint(out, p, weight);
  return putVarint(out, p, count);
}

/** Puts one person of a `coarse` block. */
export function putCoarsePerson(
  out: Output,
  at: number,
  id: number,
  x: number,
  z: number,
  cx: number,
  cz: number,
  colour: number,
): number {
  const p = putVarint(out, at, id);
  out.bytes[p] = clamp(Math.floor((x / CELL_SIZE - cx) * 256), 0, 255);
  out.bytes[p + 1] = clamp(Math.floor((z / CELL_SIZE - cz) * 256), 0, 255);
  out.view.setUint16(p + 2, colour);
  return p + 4;
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
      w.uint16(clamp(Math.round(finite(message.reach)), 0, MAX_REACH));
      break;
    case 'drive':
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
        // A tab from before reach sent 8 bytes: it reads as a street-level view.
        const reach = r.remaining === 0 ? DEFAULT_REACH : r.uint16();
        return { type: 'view', x, z, reach };
      }
      case TAG.drive:
        return { type: 'drive' };
      default:
        return null;
    }
  });
}

function check(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_ID) {
    throw new RangeError(`${value} is not a u32 id`);
  }
}

/** A whole move as steps, for an encoder that has metres and radians. */
const stepsMove = (m: Move) =>
  [stepsOf(m.x), stepsOf(m.z), headingSteps(m.heading), speedByte(m.speed, m.mode)] as const;

function encodeTick(message: TickMessage): Uint8Array<ArrayBuffer> {
  // Worst case a varint and a whole entry each; a join writes through a writer of its own.
  const size =
    2 +
    (message.leaves.length + message.demotes.length + 1) * 5 +
    (message.near.length + message.far.reduce((n, b) => n + b.moves.length + 1, 0) + 1) * 13 +
    message.joins.length * 200 +
    16;
  const out = createOutput(size);
  let at = 0;
  out.bytes[at++] = TAG.tick;
  out.bytes[at++] =
    (message.beginsRecount ? RECOUNT_BEGINS : 0) | (message.endsRecount ? RECOUNT_ENDS : 0);
  at = putIds(out, at, message.leaves);
  at = putIds(out, at, message.demotes);
  at = putVarint(out, at, message.joins.length);
  for (const player of message.joins) at = putJoin(out, at, player);
  at = putVarint(out, at, message.near.length);
  if (message.near.length) {
    out.view.setInt16(at, message.cx);
    out.view.setInt16(at + 2, message.cz);
    at += 4;
    const x0 = cellSteps(message.cx - 1);
    const z0 = cellSteps(message.cz - 1);
    message.near.forEach((entry, i) => {
      if ('delta' in entry) throw new RangeError('A delta is made by encoding, not encoded');
      check(entry.id);
      const [x, z, heading, speed] = stepsMove(entry.state);
      const base = message.bases?.[i];
      at =
        base && Number.isFinite(base.x)
          ? putMove(
              out,
              at,
              entry.id,
              x,
              z,
              heading,
              speed,
              x0,
              z0,
              base.x,
              base.z,
              base.heading,
              base.speed,
            )
          : putWhole(out, at, entry.id, x, z, heading, speed, x0, z0);
      if (base) Object.assign(base, { x, z, heading, speed });
    });
  }
  at = putVarint(out, at, message.far.length);
  for (const block of message.far) {
    out.view.setInt8(at, block.cx);
    out.view.setInt8(at + 1, block.cz);
    at = putVarint(out, at + 2, block.moves.length);
    const x0 = cellSteps(block.cx - 1);
    const z0 = cellSteps(block.cz - 1);
    for (const { id, state } of block.moves) {
      check(id);
      const [x, z, heading, speed] = stepsMove(state);
      at = putWhole(out, at, id, x, z, heading, speed, x0, z0);
    }
  }
  return out.bytes.slice(0, at);
}

function putIds(out: Output, at: number, ids: readonly number[]): number {
  let p = putVarint(out, at, ids.length);
  for (const id of ids) {
    check(id);
    p = putVarint(out, p, id);
  }
  return p;
}

function encodeCoarse(message: CoarseMessage): Uint8Array<ArrayBuffer> {
  const size = 2 + message.cells.reduce((n, c) => n + 16 + c.people.length * 9, 0);
  const out = createOutput(size);
  out.bytes[0] = TAG.coarse;
  out.bytes[1] = (message.first ? COARSE_FIRST : 0) | (message.last ? COARSE_LAST : 0);
  let at = 2;
  for (const cell of message.cells) {
    at = putCoarseHead(out, at, cell.cx, cell.cz, cell.total, cell.weight, cell.people.length);
    for (const p of cell.people) {
      check(p.id);
      at = putCoarsePerson(out, at, p.id, p.x, p.z, cell.cx, cell.cz, rgb565(p.colour));
    }
  }
  return out.bytes.slice(0, at);
}

/** Encodes a server message; throws a RangeError for an id or string the format can't hold. */
export function encodeServerMessage(message: ServerMessage): Uint8Array<ArrayBuffer> {
  if (message.type === 'tick') return encodeTick(message);
  if (message.type === 'coarse') return encodeCoarse(message);
  const w = Binary.createWriter();
  w.uint8(TAG[message.type]);
  switch (message.type) {
    case 'welcome':
      writeId(w, message.you);
      break;
    case 'identity':
      w.uint8((message.guest ? GUEST : 0) | (message.unseen ? UNSEEN : 0));
      writeString(w, message.name, MAX_NAME_BYTES);
      writeOutfit(w, message.outfit);
      break;
    case 'renamed':
      writeId(w, message.id);
      writeString(w, message.name, MAX_NAME_BYTES);
      writeOutfit(w, message.outfit);
      break;
    case 'driving':
      w.uint8(message.on ? 1 : 0);
      break;
    case 'placed':
      writeId(w, message.id);
      writeState(w, message.state);
      break;
    case 'outfit':
      writeId(w, message.id);
      writeOutfit(w, message.outfit);
      break;
    case 'online':
      w.varint(message.count);
      break;
  }
  return w.toBytes();
}

/** A sink that writes everything down, for tests and tools; `readTick` is the fast road. */
function collectTick(r: Binary.Reader): TickMessage {
  const near: MoveEntry[] = [];
  const far: { cx: number; cz: number; moves: { id: number; state: Move }[] }[] = [];
  let into: { id: number; state: Move }[] | MoveEntry[] = near;
  const message = {
    type: 'tick' as const,
    leaves: [] as number[],
    demotes: [] as number[],
    joins: [] as JoinedPlayer[],
    cx: 0,
    cz: 0,
    near,
    far,
    beginsRecount: false,
    endsRecount: false,
  };
  parseTick(r, {
    beginRecount: () => (message.beginsRecount = true),
    endRecount: () => (message.endsRecount = true),
    left: (id) => message.leaves.push(id),
    demoted: (id) => message.demotes.push(id),
    joined: (id, name, outfit, state) => message.joins.push({ id, name, outfit, state }),
    nearHead(cx, cz) {
      [message.cx, message.cz] = [cx, cz];
    },
    blockHead(cx, cz) {
      const moves: { id: number; state: Move }[] = [];
      far.push({ cx, cz, moves });
      into = moves;
    },
    whole(id, x, z, heading, byte) {
      (into as { id: number; state: Move }[]).push({
        id,
        state: {
          x: metresOf(x),
          z: metresOf(z),
          heading: headingOf(heading),
          speed: speedOf(byte),
          mode: modeOf(byte),
        },
      });
    },
    delta(id, dx, dz, heading, byte) {
      const delta: MoveDelta = { dx: metresOf(dx), dz: metresOf(dz) };
      if (heading >= 0) delta.heading = headingOf(heading);
      if (byte >= 0) Object.assign(delta, { speed: speedOf(byte), mode: modeOf(byte) });
      (into as MoveEntry[]).push({ id, delta });
    },
  });
  return message;
}

function collectCoarse(r: Binary.Reader): CoarseMessage {
  const flags = r.uint8();
  if (flags > (COARSE_FIRST | COARSE_LAST)) throw new MalformedFrame();
  const message: CoarseMessage & { cells: CoarseCell[] } = {
    type: 'coarse',
    first: Boolean(flags & COARSE_FIRST),
    last: Boolean(flags & COARSE_LAST),
    cells: [],
  };
  while (r.remaining) {
    const cx = r.int8();
    const cz = r.int8();
    const total = r.varint();
    const weight = r.varint();
    const count = r.varint();
    if (weight < 1 || count * MIN_COARSE > r.remaining) throw new MalformedFrame();
    const people: CoarseEntry[] = [];
    for (let i = 0; i < count; i++) {
      const id = readId(r);
      const x = (cx + (r.uint8() + 0.5) / 256) * CELL_SIZE;
      const z = (cz + (r.uint8() + 0.5) / 256) * CELL_SIZE;
      people.push({ id, x, z, colour: rgb888(r.uint16()) });
    }
    message.cells.push({ cx, cz, total, weight, people });
  }
  return message;
}

export function decodeServerMessage(bytes: Uint8Array): ServerMessage | null {
  return decode<ServerMessage>(bytes, (r, tag) => {
    switch (tag) {
      case TAG.welcome:
        return { type: 'welcome', you: readId(r) };
      case TAG.identity: {
        const flags = r.uint8();
        if (flags > (GUEST | UNSEEN)) throw new MalformedFrame();
        return {
          type: 'identity',
          guest: (flags & GUEST) !== 0,
          unseen: (flags & UNSEEN) !== 0,
          name: readString(r, MAX_NAME_BYTES),
          outfit: readOutfit(r),
        };
      }
      case TAG.renamed:
        return {
          type: 'renamed',
          id: readId(r),
          name: readString(r, MAX_NAME_BYTES),
          outfit: readOutfit(r),
        };
      case TAG.driving:
        return { type: 'driving', on: r.uint8() === 1 };
      case TAG.tick:
        return collectTick(r);
      case TAG.coarse:
        return collectCoarse(r);
      case TAG.placed:
        return { type: 'placed', id: readId(r), state: readState(r) };
      case TAG.outfit:
        return { type: 'outfit', id: readId(r), outfit: readOutfit(r) };
      case TAG.online:
        return { type: 'online', count: r.varint() };
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
