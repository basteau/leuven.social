/**
 * Who hears what, and the frames that say it. World.ts keeps the figures, the tabs and who they
 * are; this keeps, in flat arrays indexed by figure id, what a tick needs of them, and turns it
 * into one frame per client per tick, so a thousand clients cost a thousand memory copies and not
 * a thousand trips through the whole list.
 *
 * Everyone is filed in the city's 350 m cells. A client hears of those in the 3×3 round where its
 * map looks, by name (`joins`), near ones every tick and the rest in turns, while its view reaches
 * at most `FINE_REACH`. Further than that, or wider than that, it gets `coarse` frames: per cell,
 * shared by everyone interested, once a second, or at once when its interest changes.
 *
 * A figure's turn, `(id + round) % period`, doesn't depend on who is watching, so a cell's far
 * movers are encoded once and copied into each frame. Baselines of deltas belong to the 32 nearest
 * of each client and are never shared.
 *
 * A client that falls behind is skipped, not wiped: once it has caught up it gets a recount,
 * paged like any join and paced by how much is queued, so a recount can't itself put it behind.
 */

import type { Bounds } from '../src/data/city.ts';
import { CELL_SIZE } from '../src/data/grid.ts';
import { FINE_REACH } from '../src/net/interest.ts';
import {
  COARSE_FIRST,
  COARSE_LAST,
  COARSE_TAG,
  DEFAULT_REACH,
  RECOUNT_BEGINS,
  RECOUNT_ENDS,
  TICK_TAG,
  cacheJoin,
  cellSteps,
  createOutput,
  freshenJoin,
  headingSteps,
  putCachedJoin,
  putCoarseHead,
  putCoarsePerson,
  putMove,
  putVarint,
  putWhole,
  reserve,
  rgb565,
  speedByte,
  stepsOf,
} from '../src/net/protocol.ts';
import type { CachedJoin, Outfit, PlayerState } from '../src/net/protocol.ts';
import { nearestFirst } from './nearest.ts';

/** What a frame needs to say of a figure beyond its numbers. */
export interface Figure {
  id: number;
  account: { name: string; outfit: Outfit };
  state: PlayerState | null;
}

/** One socket's view of the map. World.ts holds it; the fields are the broadcast's. */
export interface Viewer {
  slot: number;
  figure: Figure;
  deliver(frame: Uint8Array): number | void;
  buffered(): number;
  /** Its socket is backed up: it hears nothing until it has caught up. */
  behind: boolean;
  /** Bytes queued when last asked, for how big a page it may take. */
  queued: number;
  /** The count of players it last heard. */
  heardOnline: number;
  /** What it said: where its map looks and how far it reaches. None yet: it follows its figure. */
  hasView: boolean;
  viewX: number;
  viewZ: number;
  viewReach: number;
  /** When it last moved what it watches (ms), so a burst of joins comes at most four times a second. */
  watchedAt: number;
  /** The cell its fine interest centres on; NOWHERE when its view is too wide for fine interest. */
  watching: number;
  /** The cells that overlap its look ± reach, by column and row; empty when `rectFrom > rectTo`. */
  colFrom: number;
  colTo: number;
  rowFrom: number;
  rowTo: number;
  /** The reach those cells were worked out from. */
  appliedReach: number;
  /** The cell its own figure is in, whose 3×3 stays in coarse interest for the minimap. */
  avatarCell: number;
  /** Fine figures it has yet to hear of and to hear gone, a bit per id, and how many of each. */
  joinBits: Uint32Array;
  goneBits: Uint32Array;
  joinCount: number;
  goneCount: number;
  /** A burst of joins in the order they go, nearest first, and how far that has got. */
  order: Int32Array | null;
  orderAt: number;
  /** Everyone to go through again after falling behind, nearest first, and how far that has got. */
  recount: Int32Array | null;
  recountCursor: number;
  recountBegins: boolean;
  /** Its near list wants working out again before the next one goes out. */
  nearDirty: boolean;
  /** A coarse frame is due now, however long since the last: its interest changed. */
  coarseDue: boolean;
  /** Part of a coarse frame has gone out, and the next page carries on from this cell. */
  coarseBusy: boolean;
  coarseCursor: number;
  coarseFirst: boolean;
  /** The client could be holding someone coarsely: a coarse frame or a demote said so. */
  coarseHolds: boolean;
}

export interface BroadcastOptions {
  bounds: Bounds;
  slices: number;
}

export interface Broadcast {
  /** A figure's state changed, or it has one for the first time: it is on the map. */
  update(figure: Figure): void;
  /** A figure left the map, for good or for now: those who see it hear so next tick. */
  remove(figure: Figure): void;
  /** Delivers one frame, encoded once, to everyone who sees `figure`, but not `figure` itself. */
  toSeers(figure: Figure, frame: Uint8Array): void;

  connect(
    figure: Figure,
    deliver: (frame: Uint8Array) => number | void,
    buffered: () => number,
  ): Viewer;
  disconnect(viewer: Viewer): void;
  /** A socket's frames, through the same gate as a tick's. */
  deliver(viewer: Viewer, frame: Uint8Array): void;
  /** Where a client says its map looks, and how far it reaches. */
  look(viewer: Viewer, x: number, z: number, reach: number): void;
  /** The tab is someone else now: everything starts over for it, as for a new connection. */
  become(viewer: Viewer, figure: Figure): void;
  /** It starts over, as after falling behind: a recount, then on as usual. */
  restart(viewer: Viewer): void;

  /**
   * The first half of a tick: everyone goes where they are now, every client looks where it looks
   * now, and whose socket is backed up is read. Returns how many are on the map.
   */
  prepare(time: number, slice: number): number;
  /** The second half: the shared blobs, then this slice's frames. */
  send(round: number, slice: number): void;
}

const NOWHERE = -1;
/** Each client always hears these many of the figures nearest it, at the full 10 Hz. */
const NEAREST = 32;
/** How often (rounds) a client's near list is worked out again, on a turn of its own. */
const NEAR_EVERY = 5;
/** The others take turns: each once in this many rounds. */
const TURN_ROUNDS = 10;
/** The most movers of one cell in one round, whatever the crowd: a cell's turn gets longer instead. */
const CELL_FAR_MOST = 64;
/** The most joins one frame carries (bytes): the rest wait, nearest first. */
const JOIN_PAGE = 16 * 1024;
/** Bytes queued that mean a client isn't keeping up, and that mean it has caught up. */
const BEHIND_BYTES = 64 * 1024;
const CAUGHT_UP_BYTES = 8 * 1024;
/** Kept free below BEHIND_BYTES by the paced pages, for the frames that aren't paged. */
const HEADROOM = 4 * 1024;
/** A client moves what it watches at most this often (ms): each move is a burst of joins. */
const LOOK_MS = 250;
/** How far past a cell's edge (m) a look goes before the 3×3 it hears of moves over. */
const CELL_HYSTERESIS = 40;
/** How often the coarse frames go out (rounds), each client on a turn of its own. */
const COARSE_ROUNDS = 10;
/** Past this reach (m) a client's coarse frames are thinned down further. */
const COARSE_CLOSE_REACH = 1225;
const COARSE_CLOSE_BUDGET = 256;
const COARSE_WIDE_BUDGET = 64;
/** The most bytes a page of a coarse frame carries. */
const COARSE_PAGE = 16 * 1024;
/** A cell is cut into this many squares a side (25 m) to find who is nearest without looking at all. */
const SQUARES = 14;
const SQUARE_SIZE = CELL_SIZE / SQUARES;
/** Squares of a cell, and one more for where the last one ends. */
const SQUARE_SLOTS = SQUARES * SQUARES + 1;
/**
 * How many figures one slice may go through to work out near lists, recounts and who a view that
 * moved has to hear of. Most slices use nothing like it; a storm of all of those at once waits a
 * tick or two rather than hold up every frame behind it.
 */
const WORK_PER_SLICE = 1_000_000;
/** The most join bytes one slice writes over everyone, so a storm of pages spreads over ticks. */
const JOIN_BYTES_PER_SLICE = 8 * 1024 * 1024;
/** A 3×3 this thin is cheaper to look through whole than to walk its squares, empty ones included. */
const SCAN_UP_TO = 512;
/** The nearest this many of a ranked list are in true distance order; the rest by ring (25 m). */
const RANKED_EXACT = 512;
/** A near entry new to the list: its first move goes whole, at once or only once it changes. */
const UNHEARD = 2;
const ON_CHANGE = 1;
/** The cell index fits an i8, as the frames say; the real map is a few dozen cells across. */
const MOST_CELL = 127;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** A longer array of the same kind, starting with what `a` holds. */
function copy<T extends Uint8Array | Int32Array | Uint16Array | Uint32Array>(a: T, n: number): T {
  const next = new (a.constructor as new (n: number) => T)(n);
  next.set(a);
  return next;
}

/** Calls `visit` with every id set in `bits`, lowest first. */
function forEachBit(bits: Uint32Array, visit: (id: number) => void): void {
  for (let i = 0; i < bits.length; i++) {
    let word = bits[i]!;
    while (word !== 0) {
      const low = word & -word;
      visit(i * 32 + 31 - Math.clz32(low));
      word ^= low;
    }
  }
}

export function createBroadcast({ bounds, slices }: BroadcastOptions): Broadcast {
  const minCol = clamp(Math.floor(bounds.minX / CELL_SIZE), -MOST_CELL, MOST_CELL);
  const maxCol = clamp(Math.floor(bounds.maxX / CELL_SIZE), -MOST_CELL, MOST_CELL);
  const minRow = clamp(Math.floor(bounds.minZ / CELL_SIZE), -MOST_CELL, MOST_CELL);
  const maxRow = clamp(Math.floor(bounds.maxZ / CELL_SIZE), -MOST_CELL, MOST_CELL);
  const cols = maxCol - minCol + 1;
  const rows = maxRow - minRow + 1;
  const cells = cols * rows;
  const everySlice = (1 << slices) - 1;

  const colOf = (x: number) => clamp(Math.floor(x / CELL_SIZE) - minCol, 0, cols - 1);
  const rowOf = (z: number) => clamp(Math.floor(z / CELL_SIZE) - minRow, 0, rows - 1);
  const cellOf = (x: number, z: number) => colOf(x) * rows + rowOf(z);
  const colOfCell = (cell: number) => Math.floor(cell / rows);
  const rowOfCell = (cell: number) => cell % rows;
  /** Whether cell `b` is cell `a` or one of the eight around it. */
  const adjacent = (a: number, b: number) =>
    Math.abs(colOfCell(a) - colOfCell(b)) <= 1 && Math.abs(rowOfCell(a) - rowOfCell(b)) <= 1;

  let figureCapacity = 256;
  let fx = new Float32Array(figureCapacity);
  let fz = new Float32Array(figureCapacity);
  /** Their state in the wire's steps: positions from the origin, heading, speed and mode. */
  let fqx = new Int32Array(figureCapacity);
  let fqz = new Int32Array(figureCapacity);
  let fheading = new Uint16Array(figureCapacity);
  let fspeed = new Uint8Array(figureCapacity);
  let fcolour = new Uint16Array(figureCapacity);
  /** In the street, or in a room. */
  let fstreet = new Uint8Array(figureCapacity);
  /** Slices that haven't heard this since its last turn. */
  let fstale = new Uint8Array(figureCapacity);
  let fplaced = new Uint8Array(figureCapacity);
  /** The tick its whole move went into a far blob, and who was last told of it in a join. */
  let fFarTick = new Int32Array(figureCapacity);
  let fJoinTick = new Int32Array(figureCapacity);
  let fJoinSlot = new Int32Array(figureCapacity);
  let fcell = new Int32Array(figureCapacity).fill(NOWHERE);
  /** Where each is in `live`. */
  let livePos = new Int32Array(figureCapacity).fill(-1);
  let live = new Int32Array(figureCapacity);
  let liveCount = 0;
  const figures: (Figure | undefined)[] = [];
  /** Each figure's join, encoded once, and the tick its numbers were last brought up to date. */
  const joinCache: (CachedJoin | undefined)[] = [];
  let joinFreshAt = new Int32Array(figureCapacity);

  function grow(id: number): void {
    if (id < figureCapacity) return;
    const capacity = Math.max(id + 1, figureCapacity * 2);
    const wider = <T extends Int32Array | Float32Array | Uint8Array | Uint16Array>(
      a: T,
      filler?: number,
    ): T => {
      const next = new (a.constructor as new (n: number) => T)(capacity);
      if (filler !== undefined) next.fill(filler);
      next.set(a);
      return next;
    };
    fx = wider(fx);
    fz = wider(fz);
    fqx = wider(fqx);
    fqz = wider(fqz);
    fheading = wider(fheading);
    fspeed = wider(fspeed);
    fcolour = wider(fcolour);
    fstreet = wider(fstreet);
    fstale = wider(fstale);
    fplaced = wider(fplaced);
    fFarTick = wider(fFarTick);
    fJoinTick = wider(fJoinTick);
    fJoinSlot = wider(fJoinSlot);
    joinFreshAt = wider(joinFreshAt);
    fcell = wider(fcell, NOWHERE);
    livePos = wider(livePos, -1);
    live = wider(live);
    figureCapacity = capacity;
  }

  // Who is in each cell, built anew each tick: by far the cheapest way to have them flat. Within a
  // cell they lie by 25 m square (`fileSquares`), so finding who is nearest looks at a neighbourhood
  // and not at the 3×3.
  const residentStart = new Int32Array(cells + 1);
  let residents = new Int32Array(figureCapacity);
  const fineStart = new Int32Array(cells * SQUARE_SLOTS);
  const squareAt = new Int32Array(SQUARES * SQUARES);
  let filedScratch = new Int32Array(256);
  // Who watches each cell, from each viewer's own cell.
  const viewerStart = new Int32Array(cells + 1);
  let viewersByCell: Viewer[] = [];

  // Near lists: NEAREST ids and baselines per viewer slot.
  let slotCapacity = 16;
  let nearCount = new Uint8Array(slotCapacity);
  let nearIds = new Int32Array(slotCapacity * NEAREST);
  let baseX = new Int32Array(slotCapacity * NEAREST);
  let baseZ = new Int32Array(slotCapacity * NEAREST);
  let baseHeading = new Uint16Array(slotCapacity * NEAREST);
  let baseSpeed = new Uint8Array(slotCapacity * NEAREST);
  /** Just joined the list: its first move goes whole, then deltas from that. */
  let baseFresh = new Uint8Array(slotCapacity * NEAREST);
  const freeSlots: number[] = [];
  let slotCount = 0;
  const viewers: Viewer[] = [];
  const viewerPlace = new Map<Viewer, number>();

  function newSlot(): number {
    const free = freeSlots.pop();
    if (free !== undefined) return free;
    const slot = slotCount++;
    if (slot === slotCapacity) {
      slotCapacity *= 2;
      nearCount = copy(nearCount, slotCapacity);
      nearIds = copy(nearIds, slotCapacity * NEAREST);
      baseX = copy(baseX, slotCapacity * NEAREST);
      baseZ = copy(baseZ, slotCapacity * NEAREST);
      baseHeading = copy(baseHeading, slotCapacity * NEAREST);
      baseSpeed = copy(baseSpeed, slotCapacity * NEAREST);
      baseFresh = copy(baseFresh, slotCapacity * NEAREST);
    }
    return slot;
  }

  // The one output buffer, and the blobs shared between frames.
  const output = createOutput(1 << 16);
  const farOut = createOutput(1 << 16);
  const coarseOut = createOutput(1 << 16);
  const farAt = new Int32Array(cells);
  const farLen = new Int32Array(cells);
  const coarseAt = new Int32Array(cells * 2);
  const coarseLen = new Int32Array(cells * 2);
  /** Whether blobs were built yet. */
  let coarseBuilt = false;
  let builtTick = -1;
  let lastTick = 0;
  /** What is left of this slice's WORK_PER_SLICE and JOIN_BYTES_PER_SLICE. */
  let work = WORK_PER_SLICE;
  let joinBytesLeft = JOIN_BYTES_PER_SLICE;
  // Reused from call to call: these run for every client on most ticks.
  let scratchIds = new Int32Array(256);
  let scratchDist = new Float64Array(256);
  const rankKeys = new Float64Array(RANKED_EXACT);
  const rankHead = new Int32Array(RANKED_EXACT);
  const leavesList: number[] = [];
  const demotesList: number[] = [];
  /** Cells whose far movers mustn't use up their turn this slice (`buildFar`). */
  const held = new Uint8Array(cells);
  const newIds = new Int32Array(NEAREST);
  const newBaseX = new Int32Array(NEAREST);
  const newBaseZ = new Int32Array(NEAREST);
  const newHeading = new Uint16Array(NEAREST);
  const newSpeed = new Uint8Array(NEAREST);
  const newFresh = new Uint8Array(NEAREST);

  /** A figure now in view (+1) or out of it (-1); the opposite still waiting cancels out. */
  function queue(v: Viewer, id: number, delta: number): void {
    const word = id >>> 5;
    if (word >= v.joinBits.length) {
      const longer = (figureCapacity >>> 5) + 1;
      v.joinBits = copy(v.joinBits, longer);
      v.goneBits = copy(v.goneBits, longer);
    }
    const bit = 1 << (id & 31);
    if (delta > 0) {
      if (v.goneBits[word]! & bit) {
        v.goneBits[word]! &= ~bit;
        v.goneCount--;
      } else if (!(v.joinBits[word]! & bit)) {
        v.joinBits[word]! |= bit;
        v.joinCount++;
      }
    } else if (v.joinBits[word]! & bit) {
      v.joinBits[word]! &= ~bit;
      v.joinCount--;
    } else if (!(v.goneBits[word]! & bit)) {
      v.goneBits[word]! |= bit;
      v.goneCount++;
    }
  }

  const isJoining = (v: Viewer, id: number) =>
    ((v.joinBits[id >>> 5] ?? 0) & (1 << (id & 31))) !== 0;

  function unqueueJoin(v: Viewer, id: number): void {
    v.joinBits[id >>> 5]! &= ~(1 << (id & 31));
    v.joinCount--;
  }

  /** Everyone it was going to hear of or hear gone is off the list. */
  function clearQueue(v: Viewer): void {
    v.joinBits.fill(0);
    v.goneBits.fill(0);
    v.joinCount = 0;
    v.goneCount = 0;
    v.order = null;
  }

  /** Files one figure under another cell, or none, and tells those who gain or lose sight of it. */
  function refile(id: number, old: number, cell: number): void {
    if (old !== NOWHERE)
      forEachWatcher(old, (v) => {
        if (v.figure.id !== id && (cell === NOWHERE || !adjacent(v.watching, cell)))
          queue(v, id, -1);
      });
    if (cell !== NOWHERE)
      forEachWatcher(cell, (v) => {
        if (v.figure.id !== id && (old === NOWHERE || !adjacent(v.watching, old))) queue(v, id, 1);
      });
    fcell[id] = cell;
  }

  /** Those watching `cell` are those whose own cell is `cell` or one of the eight around it. */
  function forEachWatcher(cell: number, visit: (v: Viewer) => void): void {
    const col = colOfCell(cell);
    const row = rowOfCell(cell);
    for (let c = Math.max(0, col - 1); c <= Math.min(cols - 1, col + 1); c++) {
      for (let r = Math.max(0, row - 1); r <= Math.min(rows - 1, row + 1); r++) {
        const key = c * rows + r;
        for (let i = viewerStart[key]!; i < viewerStart[key + 1]!; i++) visit(viewersByCell[i]!);
      }
    }
  }

  /** The cells round a client's look it is told in full about, centred on `watching`. */
  function eachFineCell(v: Viewer, visit: (cell: number) => void): void {
    if (v.watching === NOWHERE) return;
    const col = colOfCell(v.watching);
    const row = rowOfCell(v.watching);
    for (let c = Math.max(0, col - 1); c <= Math.min(cols - 1, col + 1); c++) {
      for (let r = Math.max(0, row - 1); r <= Math.min(rows - 1, row + 1); r++) visit(c * rows + r);
    }
  }

  function fileFigures(): void {
    for (let i = liveCount - 1; i >= 0; i--) {
      const id = live[i]!;
      const cell = fplaced[id] ? cellOf(fx[id]!, fz[id]!) : NOWHERE;
      const old = fcell[id]!;
      if (cell !== old) refile(id, old, cell);
      if (!fplaced[id]) {
        // Off the map: whoever saw it is told this tick, and nothing can name it after.
        const last = live[--liveCount]!;
        live[i] = last;
        livePos[last] = i;
        livePos[id] = -1;
        figures[id] = undefined;
        joinCache[id] = undefined;
      }
    }
  }

  function buildResidents(): void {
    if (residents.length < live.length) residents = new Int32Array(live.length);
    residentStart.fill(0);
    for (let i = 0; i < liveCount; i++) residentStart[fcell[live[i]!]! + 1]!++;
    for (let c = 0; c < cells; c++) residentStart[c + 1]! += residentStart[c]!;
    for (let i = 0; i < liveCount; i++) residents[residentStart[fcell[live[i]!]!]!++] = live[i]!;
    // Filling moved the starts on by the counts: shift them back.
    for (let c = cells; c > 0; c--) residentStart[c] = residentStart[c - 1]!;
    residentStart[0] = 0;
    for (let c = 0; c < cells; c++) {
      if (residentStart[c] !== residentStart[c + 1]) fileSquares(c);
    }
  }

  /** Lays a cell's residents out by 25 m square: a counting sort, each figure's square read once. */
  function fileSquares(c: number): void {
    const base = c * SQUARE_SLOTS;
    const start = residentStart[c]!;
    const end = residentStart[c + 1]!;
    const left = (colOfCell(c) + minCol) * CELL_SIZE;
    const top = (rowOfCell(c) + minRow) * CELL_SIZE;
    const squareOf = (id: number) =>
      clamp(Math.floor((fx[id]! - left) / SQUARE_SIZE), 0, SQUARES - 1) * SQUARES +
      clamp(Math.floor((fz[id]! - top) / SQUARE_SIZE), 0, SQUARES - 1);
    fineStart.fill(0, base, base + SQUARE_SLOTS);
    for (let i = start; i < end; i++) fineStart[base + squareOf(residents[i]!) + 1]!++;
    let at = start;
    for (let k = 0; k < SQUARES * SQUARES; k++) {
      const count = fineStart[base + k + 1]!;
      fineStart[base + k] = at;
      squareAt[k] = at;
      at += count;
    }
    fineStart[base + SQUARES * SQUARES] = end;
    const n = end - start;
    if (filedScratch.length < n) filedScratch = new Int32Array(n * 2);
    for (let i = start; i < end; i++) {
      const id = residents[i]!;
      filedScratch[squareAt[squareOf(id)]!++ - start] = id;
    }
    for (let i = 0; i < n; i++) residents[start + i] = filedScratch[i]!;
  }

  /**
   * Goes over the 25 m squares of the 3×3 round `watching`, in rings out from (x, z): `take` gets the
   * span of `residents` in each one that has anybody. After each ring, `enough` hears how far (m)
   * from the look everything has been covered, and ends the walk with true. Returns the work done.
   */
  function walkRings(
    watching: number,
    x: number,
    z: number,
    take: (start: number, end: number) => void,
    enough: (coveredSquared: number) => boolean,
  ): number {
    if (watching === NOWHERE) return 0;
    const col = colOfCell(watching);
    const row = rowOfCell(watching);
    const loCol = Math.max(0, col - 1);
    const hiCol = Math.min(cols - 1, col + 1);
    const loRow = Math.max(0, row - 1);
    const hiRow = Math.min(rows - 1, row + 1);
    let total = 0;
    for (let a = loCol; a <= hiCol; a++) {
      for (let b = loRow; b <= hiRow; b++) {
        const c = a * rows + b;
        total += residentStart[c + 1]! - residentStart[c]!;
      }
    }
    if (!total) return 0;
    if (total <= SCAN_UP_TO) {
      for (let a = loCol; a <= hiCol; a++) {
        for (let b = loRow; b <= hiRow; b++) {
          const c = a * rows + b;
          if (residentStart[c] !== residentStart[c + 1])
            take(residentStart[c]!, residentStart[c + 1]!);
        }
      }
      return total;
    }
    const loX = loCol * SQUARES;
    const hiX = (hiCol + 1) * SQUARES - 1;
    const loZ = loRow * SQUARES;
    const hiZ = (hiRow + 1) * SQUARES - 1;
    const gx = clamp(Math.floor(x / SQUARE_SIZE) - minCol * SQUARES, loX, hiX);
    const gz = clamp(Math.floor(z / SQUARE_SIZE) - minRow * SQUARES, loZ, hiZ);
    let seen = 0;
    let squares = 0;
    const visit = (qx: number, qz: number) => {
      squares++;
      const c = Math.floor(qx / SQUARES) * rows + Math.floor(qz / SQUARES);
      if (residentStart[c] === residentStart[c + 1]) return;
      const at = c * SQUARE_SLOTS + (qx % SQUARES) * SQUARES + (qz % SQUARES);
      const start = fineStart[at]!;
      const end = fineStart[at + 1]!;
      if (start === end) return;
      take(start, end);
      seen += end - start;
    };
    for (let r = 0; ; r++) {
      if (r === 0) {
        visit(gx, gz);
      } else {
        for (let qx = Math.max(loX, gx - r); qx <= Math.min(hiX, gx + r); qx++) {
          if (gz - r >= loZ) visit(qx, gz - r);
          if (gz + r <= hiZ) visit(qx, gz + r);
        }
        for (let qz = Math.max(loZ, gz - r + 1); qz <= Math.min(hiZ, gz + r - 1); qz++) {
          if (gx - r >= loX) visit(gx - r, qz);
          if (gx + r <= hiX) visit(gx + r, qz);
        }
      }
      if (seen >= total) break;
      const leftEnd = gx - r <= loX;
      const rightEnd = gx + r >= hiX;
      const topEnd = gz - r <= loZ;
      const bottomEnd = gz + r >= hiZ;
      if (leftEnd && rightEnd && topEnd && bottomEnd) break;
      const covered = Math.min(
        leftEnd ? Infinity : x - (gx - r + minCol * SQUARES) * SQUARE_SIZE,
        rightEnd ? Infinity : (gx + r + 1 + minCol * SQUARES) * SQUARE_SIZE - x,
        topEnd ? Infinity : z - (gz - r + minRow * SQUARES) * SQUARE_SIZE,
        bottomEnd ? Infinity : (gz + r + 1 + minRow * SQUARES) * SQUARE_SIZE - z,
      );
      if (enough(covered * covered)) break;
    }
    return seen + squares;
  }

  /**
   * Everyone in `v`'s fine interest (or only those still to join it) nearest first: by ring, the
   * first of them in true order, which costs a look at each once and a sort of a page's worth.
   */
  function ranked(v: Viewer, onlyJoining: boolean): Int32Array {
    const self = v.figure.id;
    const [x, z] = lookOf(v);
    const ids = new Int32Array(liveCount);
    let n = 0;
    work -= walkRings(
      v.watching,
      x,
      z,
      (start, end) => {
        for (let i = start; i < end; i++) {
          const id = residents[i]!;
          if (id !== self && (!onlyJoining || isJoining(v, id))) ids[n++] = id;
        }
      },
      () => false,
    );
    const head = Math.min(n, RANKED_EXACT);
    for (let i = 0; i < head; i++) {
      const id = ids[i]!;
      rankHead[i] = id;
      rankKeys[i] = Math.floor((fx[id]! - x) ** 2 + (fz[id]! - z) ** 2) * RANKED_EXACT + i;
    }
    // Whole square metres, then the index: a plain number sort needs no comparator and no object.
    const sorted = rankKeys.subarray(0, head).toSorted();
    for (let i = 0; i < head; i++) ids[i] = rankHead[sorted[i]! % RANKED_EXACT]!;
    return ids.subarray(0, n);
  }

  /** The cell a look in `watching`'s cell keeps counting as, until it is well past the edge. */
  function watchedCell(watching: number, x: number, z: number): number {
    const cell = cellOf(x, z);
    if (watching === NOWHERE || cell === watching || !adjacent(cell, watching)) return cell;
    const left = (colOfCell(watching) + minCol) * CELL_SIZE;
    const top = (rowOfCell(watching) + minRow) * CELL_SIZE;
    const pastX = Math.max(left - x, x - (left + CELL_SIZE), 0);
    const pastZ = Math.max(top - z, z - (top + CELL_SIZE), 0);
    return Math.max(pastX, pastZ) <= CELL_HYSTERESIS ? watching : cell;
  }

  function applyView(v: Viewer, time: number): void {
    const state = v.figure.state;
    const avatar = state ? cellOf(state.x, state.z) : NOWHERE;
    if (avatar !== v.avatarCell) {
      v.avatarCell = avatar;
      v.coarseDue = true;
    }
    const x = v.hasView ? v.viewX : state ? state.x : 0;
    const z = v.hasView ? v.viewZ : state ? state.z : 0;
    const reach = v.hasView ? v.viewReach : DEFAULT_REACH;
    const fine = reach > 0 && reach <= FINE_REACH;
    const watching = fine ? watchedCell(v.watching, x, z) : NOWHERE;
    const colFrom = reach > 0 ? colOf(x - reach) : 1;
    const colTo = reach > 0 ? colOf(x + reach) : 0;
    const rowFrom = reach > 0 ? rowOf(z - reach) : 1;
    const rowTo = reach > 0 ? rowOf(z + reach) : 0;
    const same =
      watching === v.watching &&
      reach === v.appliedReach &&
      colFrom === v.colFrom &&
      colTo === v.colTo &&
      rowFrom === v.rowFrom &&
      rowTo === v.rowTo;
    if (same || time - v.watchedAt < LOOK_MS) return;
    if (watching !== v.watching && work <= 0) return; // Next tick: a storm of views waits its turn.
    v.watchedAt = time;
    v.colFrom = colFrom;
    v.colTo = colTo;
    v.rowFrom = rowFrom;
    v.rowTo = rowTo;
    v.appliedReach = reach;
    v.coarseDue = true;
    if (watching !== v.watching) watch(v, watching);
  }

  /** Points a client's fine interest at another cell: it hears of those new to it, and goes on. */
  function watch(v: Viewer, cell: number): void {
    const old = v.watching;
    eachFineCell(v, (c) => {
      if (cell !== NOWHERE && adjacent(cell, c)) return;
      for (let i = residentStart[c]!; i < residentStart[c + 1]!; i++) {
        if (residents[i] !== v.figure.id) queue(v, residents[i]!, -1);
      }
      work -= residentStart[c + 1]! - residentStart[c]!;
    });
    v.watching = cell;
    eachFineCell(v, (c) => {
      if (old !== NOWHERE && adjacent(old, c)) return;
      for (let i = residentStart[c]!; i < residentStart[c + 1]!; i++) {
        if (residents[i] !== v.figure.id) queue(v, residents[i]!, 1);
      }
      work -= residentStart[c + 1]! - residentStart[c]!;
    });
    v.order = null;
    v.nearDirty = true;
  }

  function buildViewerCells(): void {
    viewerStart.fill(0);
    for (const v of viewers) if (v.watching !== NOWHERE) viewerStart[v.watching + 1]!++;
    for (let c = 0; c < cells; c++) viewerStart[c + 1]! += viewerStart[c]!;
    if (viewersByCell.length < viewers.length) viewersByCell = Array.from(viewers);
    for (const v of viewers) {
      if (v.watching !== NOWHERE) viewersByCell[viewerStart[v.watching]!++] = v;
    }
    for (let c = cells; c > 0; c--) viewerStart[c] = viewerStart[c - 1]!;
    viewerStart[0] = 0;
  }

  /** Forgets everything it thinks it knows and sets a recount going, nearest first. */
  function startRecount(v: Viewer): void {
    v.behind = false;
    v.heardOnline = -1;
    clearQueue(v);
    nearCount[v.slot] = 0;
    v.coarseDue = true;
    v.coarseBusy = false;
    v.recount = ranked(v, false);
    v.recountCursor = 0;
    v.recountBegins = true;
    v.nearDirty = true;
  }

  function forgetNear(v: Viewer, id: number): void {
    const base = v.slot * NEAREST;
    const n = nearCount[v.slot]!;
    for (let k = 0; k < n; k++) {
      if (nearIds[base + k] !== id) continue;
      const last = base + n - 1;
      nearIds[base + k] = nearIds[last]!;
      baseX[base + k] = baseX[last]!;
      baseZ[base + k] = baseZ[last]!;
      baseHeading[base + k] = baseHeading[last]!;
      baseSpeed[base + k] = baseSpeed[last]!;
      baseFresh[base + k] = baseFresh[last]!;
      nearCount[v.slot] = n - 1;
      return;
    }
  }

  /** Whether a figure in `cell` is in a client's coarse interest: wider than fine, in the street. */
  function inCoarse(v: Viewer, cell: number): boolean {
    if (v.appliedReach === 0) return false;
    const col = colOfCell(cell);
    const row = rowOfCell(cell);
    const rect = col >= v.colFrom && col <= v.colTo && row >= v.rowFrom && row <= v.rowTo;
    if (!rect && (v.avatarCell === NOWHERE || !adjacent(v.avatarCell, cell))) return false;
    if (v.watching === NOWHERE || !adjacent(v.watching, cell)) return true;
    // Fine cells aren't coarse once everyone there has been told, or a join still under way
    // would have nothing to show for those it hasn't reached yet.
    return v.joinCount > 0 || v.recount !== null;
  }

  /**
   * Finds the 32 nearest of a client by rings out from its look, and stops as soon as nobody further
   * out could still make the list: exact, for a look at a small part of the 3×3. Skipped, for its
   * next turn, when this slice has done enough already.
   */
  function refreshNear(v: Viewer): void {
    if (work <= 0) return;
    const [x, z] = lookOf(v);
    if (scratchIds.length < liveCount + NEAREST) {
      scratchIds = new Int32Array((liveCount + NEAREST) * 2);
      scratchDist = new Float64Array((liveCount + NEAREST) * 2);
    }
    const self = v.figure.id;
    const check = v.joinCount > 0;
    let n = 0;
    const prune = () => {
      if (n <= NEAREST) return;
      nearestFirst(scratchIds, scratchDist, n, NEAREST);
      n = NEAREST;
    };
    work -= walkRings(
      v.watching,
      x,
      z,
      (start, end) => {
        for (let i = start; i < end; i++) {
          const id = residents[i]!;
          if (id === self || (check && isJoining(v, id))) continue;
          const dx = fx[id]! - x;
          const dz = fz[id]! - z;
          scratchIds[n] = id;
          scratchDist[n] = dx * dx + dz * dz;
          n++;
        }
      },
      (coveredSquared) => {
        prune();
        if (n < NEAREST) return false;
        let furthest = 0;
        for (let k = 0; k < NEAREST; k++) furthest = Math.max(furthest, scratchDist[k]!);
        return furthest <= coveredSquared;
      },
    );
    prune();
    const base = v.slot * NEAREST;
    const before = nearCount[v.slot]!;
    for (let k = 0; k < n; k++) {
      const id = scratchIds[k]!;
      let found = -1;
      for (let j = 0; j < before; j++) {
        if (nearIds[base + j] === id) {
          found = j;
          break;
        }
      }
      newIds[k] = id;
      // New to the list: what the client knows of them is whatever it last heard, or a join in
      // this very frame, so the next near entry goes whole, and deltas count from that.
      newBaseX[k] = found < 0 ? 0 : baseX[base + found]!;
      newBaseZ[k] = found < 0 ? 0 : baseZ[base + found]!;
      newHeading[k] = found < 0 ? 0 : baseHeading[base + found]!;
      newSpeed[k] = found < 0 ? 0 : baseSpeed[base + found]!;
      newFresh[k] = found < 0 ? UNHEARD : baseFresh[base + found]!;
    }
    nearCount[v.slot] = n;
    for (let k = 0; k < n; k++) {
      nearIds[base + k] = newIds[k]!;
      baseX[base + k] = newBaseX[k]!;
      baseZ[base + k] = newBaseZ[k]!;
      baseHeading[base + k] = newHeading[k]!;
      baseSpeed[base + k] = newSpeed[k]!;
      baseFresh[base + k] = newFresh[k]!;
    }
    v.nearDirty = false;
  }

  /** Encodes each cell's far movers whose turn it is, once, for everyone in this slice. */
  function buildFar(round: number, slice: number): void {
    const bit = 1 << slice;
    // Someone recounting hears no moves, and a move that fell inside its recount was never told
    // to it: the figure stays stale in the cells it watches, for a turn after it has finished.
    held.fill(0);
    for (const v of viewers) {
      if (v.recount && v.slot % slices === slice) eachFineCell(v, (c) => (held[c] = 1));
    }
    let at = 0;
    for (let c = 0; c < cells; c++) {
      farAt[c] = at;
      farLen[c] = 0;
      const start = residentStart[c]!;
      const end = residentStart[c + 1]!;
      if (start === end) continue;
      let stale = 0;
      for (let i = start; i < end; i++) if (fstale[residents[i]!]! & bit) stale++;
      if (!stale) continue;
      // A cell so packed its movers wouldn't fit a round's share gets a longer turn instead of
      // dropping someone, so a stop is never lost.
      const period = Math.max(TURN_ROUNDS, Math.ceil(stale / CELL_FAR_MOST));
      let count = 0;
      for (let i = start; i < end; i++) {
        const id = residents[i]!;
        if (fstale[id]! & bit && (id + round) % period === 0) count++;
      }
      if (!count) continue;
      reserve(farOut, at + count * 13 + 8);
      const col = colOfCell(c);
      const row = rowOfCell(c);
      farOut.view.setInt8(at, col + minCol);
      farOut.view.setInt8(at + 1, row + minRow);
      let p = putVarint(farOut, at + 2, count);
      const x0 = cellSteps(col + minCol - 1);
      const z0 = cellSteps(row + minRow - 1);
      for (let i = start; i < end; i++) {
        const id = residents[i]!;
        if (!(fstale[id]! & bit) || (id + round) % period !== 0) continue;
        p = putWhole(farOut, p, id, fqx[id]!, fqz[id]!, fheading[id]!, fspeed[id]!, x0, z0);
        if (!held[c]) fstale[id]! &= ~bit;
        fFarTick[id] = lastTick;
      }
      farLen[c] = p - at;
      at = p;
    }
  }

  /**
   * Builds each cell's coarse blobs: one at each budget, sampled by id % weight, so a weight raised
   * by a power of two keeps half of who was shown. Cheap: a few bytes per person in the street.
   */
  function buildCoarse(): void {
    let at = 0;
    for (let c = 0; c < cells; c++) {
      coarseLen[c * 2] = 0;
      coarseLen[c * 2 + 1] = 0;
      const start = residentStart[c]!;
      const end = residentStart[c + 1]!;
      let total = 0;
      for (let i = start; i < end; i++) if (fstreet[residents[i]!]) total++;
      if (!total) continue;
      const col = colOfCell(c) + minCol;
      const row = rowOfCell(c) + minRow;
      at = encodeCoarse(c * 2, at, start, end, total, col, row, COARSE_CLOSE_BUDGET);
      if (total <= COARSE_WIDE_BUDGET) {
        coarseAt[c * 2 + 1] = coarseAt[c * 2]!;
        coarseLen[c * 2 + 1] = coarseLen[c * 2]!;
      } else {
        at = encodeCoarse(c * 2 + 1, at, start, end, total, col, row, COARSE_WIDE_BUDGET);
      }
    }
  }

  function encodeCoarse(
    key: number,
    at: number,
    start: number,
    end: number,
    total: number,
    col: number,
    row: number,
    budget: number,
  ): number {
    let weight = 1;
    let chosen = total;
    while (chosen > budget) {
      weight *= 2;
      chosen = 0;
      for (let i = start; i < end; i++) {
        const id = residents[i]!;
        if (fstreet[id] && id % weight === 0) chosen++;
      }
    }
    reserve(coarseOut, at + chosen * 9 + 16);
    coarseAt[key] = at;
    let p = putCoarseHead(coarseOut, at, col, row, total, weight, chosen);
    for (let i = start; i < end; i++) {
      const id = residents[i]!;
      if (!fstreet[id] || id % weight !== 0) continue;
      p = putCoarsePerson(coarseOut, p, id, fx[id]!, fz[id]!, col, row, fcolour[id]!);
    }
    coarseLen[key] = p - at;
    return p;
  }

  /** A client's own socket: never throws, and a dropped frame means it is behind. */
  function deliver(v: Viewer, frame: Uint8Array): void {
    try {
      if (v.deliver(frame) === 0) v.behind = true;
    } catch {
      // A socket closing under us: its own close event cleans up.
    }
  }

  function writeFrame(v: Viewer, round: number): void {
    let at = 2;
    let flags = 0;
    if (v.recountBegins) {
      flags |= RECOUNT_BEGINS;
      v.recountBegins = false;
    }

    // Leaves and demotes first: a page can't hold them back, and they are small.
    leavesList.length = 0;
    demotesList.length = 0;
    if (v.goneCount) {
      forEachBit(v.goneBits, (id) => {
        forgetNear(v, id);
        const cell = figures[id] ? fcell[id]! : NOWHERE;
        (cell !== NOWHERE && fstreet[id] && inCoarse(v, cell) ? demotesList : leavesList).push(id);
      });
      v.goneBits.fill(0);
      v.goneCount = 0;
      if (demotesList.length) v.coarseHolds = true;
    }
    reserve(output, 2 + (leavesList.length + demotesList.length + 2) * 5 + 64);
    at = putIdList(at, leavesList);
    at = putIdList(at, demotesList);

    // Joins, up to a page, paced by what is queued so a catch-up can't put it behind again.
    const budget = Math.min(
      JOIN_PAGE,
      Math.max(0, BEHIND_BYTES - v.queued - HEADROOM),
      Math.max(0, joinBytesLeft),
    );
    const joinsAt = at;
    at += 3;
    const start = at;
    let joins = 0;
    const room = () => at - start < budget;
    const putJoinOf = (id: number) => {
      at = putCachedJoin(output, at, joinOf(figures[id]!));
      fJoinTick[id] = lastTick;
      fJoinSlot[id] = v.slot;
      joins++;
    };
    if (v.recount) {
      for (; v.recountCursor < v.recount.length && room(); v.recountCursor++) {
        const id = v.recount[v.recountCursor]!;
        // Gone or out of fine interest since the recount started: it has been told, or won't be.
        if (!figures[id]?.state) continue;
        const cell = fcell[id]!;
        if (cell === NOWHERE || v.watching === NOWHERE || !adjacent(v.watching, cell)) continue;
        putJoinOf(id);
      }
    }
    if (room() && v.joinCount) {
      // Nearest first when they won't all fit, worked out once for however many pages it takes.
      if (!v.order && v.joinCount * 80 > budget && work > 0) {
        v.order = ranked(v, true);
        v.orderAt = 0;
      }
      if (v.order) {
        for (; v.orderAt < v.order.length && room(); v.orderAt++) {
          const id = v.order[v.orderAt]!;
          if (!isJoining(v, id)) continue;
          unqueueJoin(v, id);
          if (figures[id]?.state) putJoinOf(id);
        }
        if (v.orderAt >= v.order.length) v.order = null;
      }
      // A few, or those who came along since the list was made: in any order.
      if (!v.order && v.joinCount * 80 <= budget) {
        for (let i = 0; i < v.joinBits.length && v.joinCount && room(); i++) {
          let word = v.joinBits[i]!;
          while (word !== 0 && room()) {
            const low = word & -word;
            word ^= low;
            const id = i * 32 + 31 - Math.clz32(low);
            unqueueJoin(v, id);
            if (figures[id]?.state) putJoinOf(id);
          }
        }
      }
    }
    const written = at - start;
    joinBytesLeft -= written;
    const ended = v.recount !== null && v.recountCursor >= v.recount.length;
    if (ended) {
      flags |= RECOUNT_ENDS;
      v.recount = null;
      v.nearDirty = true;
    }
    const countAt = putVarint(output, joinsAt, joins);
    if (countAt !== start) output.bytes.copyWithin(countAt, start, start + written);
    at = countAt + written;

    // Nothing moves for a client that is being told who is here; it starts again next frame,
    // from a whole move each.
    const moving = !v.recount && !ended && v.watching !== NOWHERE;
    let near = 0;
    if (moving) {
      if (v.nearDirty || nearCount[v.slot] === 0 || (v.slot + round) % NEAR_EVERY === 0) {
        refreshNear(v);
      }
      reserve(output, at + 8 + NEAREST * 12);
      const entries = at + 5;
      let p = entries;
      const base = v.slot * NEAREST;
      const n = nearCount[v.slot]!;
      const cx = colOfCell(v.watching) + minCol;
      const cz = rowOfCell(v.watching) + minRow;
      const x0 = cellSteps(cx - 1);
      const z0 = cellSteps(cz - 1);
      for (let k = 0; k < n; k++) {
        const id = nearIds[base + k]!;
        const qx = fqx[id]!;
        const qz = fqz[id]!;
        const heading = fheading[id]!;
        const speed = fspeed[id]!;
        const slotAt = base + k;
        if (fFarTick[id] === lastTick) {
          // Its turn too: the shared block is already saying this, whole.
          baseX[slotAt] = qx;
          baseZ[slotAt] = qz;
          baseHeading[slotAt] = heading;
          baseSpeed[slotAt] = speed;
          baseFresh[slotAt] = 0;
          continue;
        }
        const fresh = baseFresh[slotAt]!;
        if (fresh === UNHEARD && fJoinTick[id] === lastTick && fJoinSlot[id] === v.slot) {
          // New to the list and joined in this very frame: it knows just where they are.
          baseX[slotAt] = qx;
          baseZ[slotAt] = qz;
          baseHeading[slotAt] = heading;
          baseSpeed[slotAt] = speed;
          baseFresh[slotAt] = ON_CHANGE;
          continue;
        }
        if (
          fresh !== UNHEARD &&
          baseX[slotAt] === qx &&
          baseZ[slotAt] === qz &&
          baseHeading[slotAt] === heading &&
          baseSpeed[slotAt] === speed
        ) {
          continue;
        }
        p = baseFresh[slotAt]
          ? putWhole(output, p, id, qx, qz, heading, speed, x0, z0)
          : putMove(
              output,
              p,
              id,
              qx,
              qz,
              heading,
              speed,
              x0,
              z0,
              baseX[slotAt]!,
              baseZ[slotAt]!,
              baseHeading[slotAt]!,
              baseSpeed[slotAt]!,
            );
        baseFresh[slotAt] = 0;
        baseX[slotAt] = qx;
        baseZ[slotAt] = qz;
        baseHeading[slotAt] = heading;
        baseSpeed[slotAt] = speed;
        near++;
      }
      if (near) {
        output.bytes[at] = near;
        output.view.setInt16(at + 1, cx);
        output.view.setInt16(at + 3, cz);
        at = p;
      } else {
        output.bytes[at++] = 0;
      }
    } else {
      output.bytes[at++] = 0;
    }

    // Far: a copy per cell of what was encoded once for everyone this round.
    let blocks = 0;
    const blocksAt = at++;
    if (moving) {
      const col = colOfCell(v.watching);
      const row = rowOfCell(v.watching);
      for (let a = Math.max(0, col - 1); a <= Math.min(cols - 1, col + 1); a++) {
        for (let b = Math.max(0, row - 1); b <= Math.min(rows - 1, row + 1); b++) {
          const c = a * rows + b;
          const len = farLen[c]!;
          if (!len) continue;
          reserve(output, at + len + 16);
          const from = farAt[c]!;
          const { bytes } = output;
          for (let i = 0; i < len; i++) bytes[at + i] = farOut.bytes[from + i]!;
          at += len;
          blocks++;
        }
      }
    }
    output.bytes[blocksAt] = blocks;

    output.bytes[0] = TICK_TAG;
    output.bytes[1] = flags;
    if (!flags && !leavesList.length && !demotesList.length && !joins && !near && !blocks) return;
    deliver(v, output.bytes.subarray(0, at));
  }

  /**
   * A figure's join, re-encoded only when who it is or where (room, floor) has changed; its position
   * is written over the cached bytes, at most once a tick, so every frame that wants it is a copy.
   */
  function joinOf(figure: Figure): CachedJoin {
    const { id, account } = figure;
    const state = figure.state!;
    let cached = joinCache[id];
    if (
      !cached ||
      cached.name !== account.name ||
      cached.outfit !== account.outfit ||
      cached.place !== state.place ||
      cached.floor !== state.floor
    ) {
      cached = cacheJoin({ id, name: account.name, outfit: account.outfit, state });
      joinCache[id] = cached;
      joinFreshAt[id] = lastTick;
    } else if (joinFreshAt[id] !== lastTick) {
      freshenJoin(cached, state);
      joinFreshAt[id] = lastTick;
    }
    return cached;
  }

  const lookOf = (v: Viewer): [number, number] => [
    v.hasView ? v.viewX : v.figure.state ? v.figure.state.x : 0,
    v.hasView ? v.viewZ : v.figure.state ? v.figure.state.z : 0,
  ];

  function putIdList(at: number, ids: number[]): number {
    let p = putVarint(output, at, ids.length);
    for (const id of ids) p = putVarint(output, p, id);
    return p;
  }

  /** The next page of a client's coarse frame, if one is due or under way. */
  function pumpCoarse(v: Viewer, round: number): void {
    if (v.coarseDue) {
      v.coarseDue = false;
      v.coarseBusy = true;
      v.coarseCursor = 0;
      v.coarseFirst = true;
    } else if (!v.coarseBusy && (v.slot + round) % COARSE_ROUNDS === 0) {
      v.coarseBusy = true;
      v.coarseCursor = 0;
      v.coarseFirst = true;
    }
    if (!v.coarseBusy) return;
    if (v.appliedReach === 0 && !v.coarseHolds) {
      v.coarseBusy = false;
      return;
    }
    const budget = Math.min(COARSE_PAGE, BEHIND_BYTES - v.queued - HEADROOM);
    if (budget <= 0) return; // Stays busy: it goes out once the socket has room.
    const variant = v.appliedReach > COARSE_CLOSE_REACH ? 1 : 0;
    reserve(output, budget + 16);
    let at = 2;
    let cursor = v.coarseCursor;
    for (; cursor < cells; cursor++) {
      if (!inCoarse(v, cursor)) continue;
      const len = coarseLen[cursor * 2 + variant]!;
      if (!len) continue;
      if (at > 2 && at + len > budget + 2) break;
      reserve(output, at + len + 2);
      output.bytes.set(
        coarseOut.bytes.subarray(
          coarseAt[cursor * 2 + variant]!,
          coarseAt[cursor * 2 + variant]! + len,
        ),
        at,
      );
      at += len;
    }
    const finished = cursor >= cells;
    let flags = finished ? COARSE_LAST : 0;
    if (v.coarseFirst) flags |= COARSE_FIRST;
    v.coarseCursor = cursor;
    const empty = at === 2 && v.coarseFirst && finished;
    v.coarseFirst = false;
    if (finished) v.coarseBusy = false;
    // Nobody to say and nobody it could be holding: an empty frame every second says nothing.
    if (empty && !v.coarseHolds) return;
    if (!empty && at > 2) v.coarseHolds = true;
    output.bytes[0] = COARSE_TAG;
    output.bytes[1] = flags;
    deliver(v, output.bytes.subarray(0, at));
    // Told nobody, and it is listening: from now on it holds nobody, and the next can be skipped.
    if (empty && !v.behind) v.coarseHolds = false;
  }

  function fileState(figure: Figure): void {
    const state = figure.state!;
    const id = figure.id;
    grow(id);
    figures[id] = figure;
    fplaced[id] = 1;
    if (livePos[id]! < 0) {
      livePos[id] = liveCount;
      live[liveCount++] = id;
      fcell[id] = NOWHERE;
    }
    fx[id] = state.x;
    fz[id] = state.z;
    fqx[id] = stepsOf(state.x);
    fqz[id] = stepsOf(state.z);
    fheading[id] = headingSteps(state.heading);
    fspeed[id] = speedByte(state.speed, state.mode);
    fcolour[id] = rgb565(figure.account.outfit.shirt);
    fstreet[id] = state.place === '' ? 1 : 0;
    fstale[id] = everySlice;
  }

  return {
    update: fileState,

    remove(figure) {
      fplaced[figure.id] = 0;
      fstale[figure.id] = 0;
    },

    toSeers(figure, frame) {
      const cell = fcell[figure.id]!;
      if (cell === NOWHERE) return;
      forEachWatcher(cell, (v) => {
        if (v.slot >= 0 && v.figure !== figure && !v.behind) deliver(v, frame);
      });
    },

    connect(figure, send, buffered) {
      const slot = newSlot();
      nearCount[slot] = 0;
      const viewer: Viewer = {
        slot,
        figure,
        deliver: send,
        buffered,
        behind: false,
        queued: 0,
        heardOnline: -1,
        hasView: false,
        viewX: 0,
        viewZ: 0,
        viewReach: DEFAULT_REACH,
        watchedAt: Number.NEGATIVE_INFINITY,
        watching: NOWHERE,
        colFrom: 1,
        colTo: 0,
        rowFrom: 1,
        rowTo: 0,
        appliedReach: DEFAULT_REACH,
        avatarCell: NOWHERE,
        joinBits: new Uint32Array((figureCapacity >>> 5) + 1),
        goneBits: new Uint32Array((figureCapacity >>> 5) + 1),
        joinCount: 0,
        goneCount: 0,
        order: null,
        orderAt: 0,
        recount: null,
        recountCursor: 0,
        recountBegins: false,
        nearDirty: true,
        coarseDue: true,
        coarseBusy: false,
        coarseCursor: 0,
        coarseFirst: false,
        coarseHolds: false,
      };
      viewerPlace.set(viewer, viewers.length);
      viewers.push(viewer);
      return viewer;
    },

    disconnect(viewer) {
      const place = viewerPlace.get(viewer)!;
      const last = viewers.pop()!;
      if (last !== viewer) {
        viewers[place] = last;
        viewerPlace.set(last, place);
      }
      viewerPlace.delete(viewer);
      freeSlots.push(viewer.slot);
      viewer.slot = -1;
    },

    deliver,

    look(viewer, x, z, reach) {
      viewer.hasView = true;
      viewer.viewX = x;
      viewer.viewZ = z;
      viewer.viewReach = reach;
    },

    become(viewer, figure) {
      viewer.figure = figure;
      // Its client forgets everyone on `welcome`, sent just before this.
      viewer.coarseHolds = false;
      viewer.avatarCell = NOWHERE;
      startRecount(viewer);
    },

    restart: startRecount,

    prepare(time, slice) {
      work = WORK_PER_SLICE;
      fileFigures();
      buildResidents();
      for (const v of viewers) applyView(v, time);
      buildViewerCells();
      for (const v of viewers) {
        if (v.slot % slices !== slice) continue;
        const queued = v.buffered();
        v.queued = queued;
        if (v.behind) {
          // Worked out once for each who recovers: a storm of them starts a few a slice.
          if (queued < CAUGHT_UP_BYTES && work > 0) startRecount(v);
        } else if (queued > BEHIND_BYTES) {
          v.behind = true;
          clearQueue(v);
          v.recount = null;
          v.recountBegins = false;
          v.coarseBusy = false;
          nearCount[v.slot] = 0;
        }
      }
      return liveCount;
    },

    send(round, slice) {
      lastTick++;
      joinBytesLeft = JOIN_BYTES_PER_SLICE;
      buildFar(round, slice);
      let fresh = slice === 0 && (round % COARSE_ROUNDS === 0 || !coarseBuilt);
      if (!fresh) {
        for (const v of viewers) {
          if (v.slot % slices === slice && v.coarseDue && !v.behind) {
            fresh = true;
            break;
          }
        }
      }
      if (fresh && builtTick !== lastTick) {
        buildCoarse();
        builtTick = lastTick;
        coarseBuilt = true;
      }
      // From a different place each tick, so what a storm postpones isn't always the same clients'.
      const count = viewers.length;
      const from = count ? (lastTick * 127) % count : 0;
      for (let i = 0; i < count; i++) {
        const v = viewers[(from + i) % count]!;
        if (v.slot % slices !== slice || v.behind) continue;
        writeFrame(v, round);
        pumpCoarse(v, round);
      }
    },
  };
}
