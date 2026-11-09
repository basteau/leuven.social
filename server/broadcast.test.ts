import { describe, expect, test } from 'bun:test';

import { CELL_SIZE } from '../src/data/grid.ts';
import { decodeServerMessage, encodeClientMessage, rgb565, rgb888 } from '../src/net/protocol.ts';
import type {
  CoarseMessage,
  JoinedPlayer,
  Outfit,
  PlayerState,
  ServerMessage,
  TickMessage,
} from '../src/net/protocol.ts';
import { createWorld } from './world.ts';
import type { Account, Connection } from './world.ts';

const outfit: Outfit = { skin: 1, hair: 2, shirt: 0xfa8064, shorts: 4 };
const here: PlayerState = { x: 10, z: 20, heading: 1, speed: 2, mode: 'foot', place: '', floor: 0 };
const WIDE = [{ minX: -6000, minZ: -6000, maxX: 6000, maxZ: 6000 }];

class Socket implements Connection {
  messages: ServerMessage[] = [];
  frames: Uint8Array[] = [];
  queued = 0;
  /** A socket that holds on to what it is sent until it drains. */
  slow = false;
  /** One of a crowd nobody listens in on. */
  deaf = false;
  /** Every byte it was sent, deaf or not. */
  sent = 0;
  send(frame: Uint8Array): number {
    this.sent += frame.length;
    if (this.deaf) return frame.length;
    const copy = frame.slice();
    this.frames.push(copy);
    if (this.slow) this.queued += copy.length;
    const message = decodeServerMessage(copy);
    if (!message) throw new Error('a malformed frame');
    this.messages.push(message);
    return copy.length;
  }
  close() {}
  buffered() {
    return this.queued;
  }
  /** Drains as a slow link would. */
  drain(bytes: number) {
    this.queued = Math.max(0, this.queued - bytes);
  }
  take(): ServerMessage[] {
    const taken = this.messages;
    this.messages = [];
    this.frames = [];
    return taken;
  }
  ticks = (): TickMessage[] => this.take().filter((m): m is TickMessage => m.type === 'tick');
  coarse = (): CoarseMessage[] =>
    this.take().filter((m): m is CoarseMessage => m.type === 'coarse');
}

function setup(slices = 1) {
  let time = 1_000_000;
  const world = createWorld({
    now: () => time,
    area: WIDE,
    slices,
    rate: { limit: 1e9, period: 1000, burst: 1e9 },
  });
  let n = 0;
  const join = (name = `g${++n}`) => {
    const socket = new Socket();
    const account: Account = { userId: name, name, outfit, guest: true };
    const id = world.connect(socket, account, { address: `a${n}` });
    const welcome = socket.messages[0] as { you: number };
    return { id, you: welcome.you, socket };
  };
  const move = (id: number, x: number, z = 20, extra: Partial<PlayerState> = {}) =>
    world.receive(id, encodeClientMessage({ type: 'state', state: { ...here, x, z, ...extra } }));
  const view = (id: number, x: number, z: number, reach: number) =>
    world.receive(id, encodeClientMessage({ type: 'view', x, z, reach }));
  const tick = () => world.tick();
  return { world, join, move, view, tick, advance: (ms: number) => (time += ms) };
}

const ids = (joined: readonly JoinedPlayer[]) => joined.map((p) => p.id);
const allJoined = (ticks: TickMessage[]) => ticks.flatMap((t) => ids(t.joins));
const allLeft = (ticks: TickMessage[]) => ticks.flatMap((t) => [...t.leaves]);
const allDemoted = (ticks: TickMessage[]) => ticks.flatMap((t) => [...t.demotes]);
const coarseIds = (message: CoarseMessage) =>
  message.cells.flatMap((c) => c.people.map((p) => p.id));

async function crowd(
  env: ReturnType<typeof setup>,
  count: number,
  at: (i: number) => [number, number],
) {
  const list = Array.from({ length: count }, () => env.join());
  // Hidden tabs, heard by the rest but hearing nothing: building each one's frames would be nearly
  // all of a big test's time.
  for (const c of list) c.socket.deaf = true;
  await Promise.all(list.map((c) => env.view(c.id, 0, 0, 0)));
  await Promise.all(list.map((c, i) => env.move(c.id, ...at(i))));
  return list;
}

describe('a client that has fallen behind', () => {
  test(
    'recovers without being wiped, and a recount can’t put it behind again',
    { timeout: 60_000 },
    async () => {
      const env = setup(2);
      const { world, join, move, advance } = env;
      const others = await crowd(env, 2500, (i) => [
        100 + (i % 80) * 3,
        100 + Math.floor(i / 80) * 3,
      ]);
      const slow = join('slow');
      await env.view(slow.id, 200, 200, 200);
      world.tick();
      world.tick();
      slow.socket.take();
      const drainBytes = 8 * 1024; // 160 kB/s at 20 ticks a second
      let biggest = 0;
      let begins = 0;
      let ends = 0;
      let welcomes = 0;
      const recount = (m: ServerMessage) => {
        if (m.type === 'welcome') welcomes++;
        if (m.type === 'tick') {
          if (m.beginsRecount) begins++;
          if (m.endsRecount) ends++;
        }
      };
      // It stopped reading for a moment: 100 kB sit in its socket.
      slow.socket.slow = true;
      slow.socket.queued = 100 * 1024;
      for (let t = 0; t < 6 * 20; t++) {
        if (t % 4 === 0) {
          // eslint-disable-next-line no-await-in-loop -- ticks follow one another
          await Promise.all(
            others.slice(0, 50).map((c, i) => move(c.id, 100 + (i % 80) * 3 + (t % 8), 100)),
          );
        }
        advance(50);
        world.tick();
        slow.socket.drain(drainBytes);
        for (const frame of slow.socket.frames) biggest = Math.max(biggest, frame.length);
        for (const m of slow.socket.take()) recount(m);
      }
      // The bug: a recovery frame of everyone at once is bigger than the 64 kB that puts a client
      // behind, so it fell behind again the moment it recovered, and never moved again.
      expect(biggest).toBeLessThanOrEqual(64 * 1024);
      expect(begins).toBeGreaterThanOrEqual(1);
      expect(begins).toBeLessThanOrEqual(2);
      expect(ends).toBe(begins);
      expect(welcomes).toBe(0);
    },
  );

  test('a recount reconciles by id, in pages, nearest first, and nobody is told twice', async () => {
    const env = setup();
    const { world, join, advance } = env;
    await crowd(env, 800, (i) => [(i % 40) * 2, 20 + Math.floor(i / 40) * 2]);
    const slow = join('slow');
    await env.move(slow.id, 0, 20);
    world.tick();
    for (let t = 0; t < 10; t++) world.tick();
    slow.socket.take();
    slow.socket.queued = 100 * 1024;
    world.tick(); // Behind now.
    slow.socket.queued = 0;
    const ticks: TickMessage[] = [];
    let biggest = 0;
    for (let t = 0; t < 8; t++) {
      advance(50);
      world.tick();
      for (const frame of slow.socket.frames) biggest = Math.max(biggest, frame.length);
      ticks.push(...slow.socket.ticks());
    }
    expect(biggest).toBeLessThan(17 * 1024);
    expect(ticks[0]?.beginsRecount).toBe(true);
    expect(ticks.some((t) => t.endsRecount)).toBe(true);
    const joined = allJoined(ticks);
    expect(new Set(joined).size).toBe(joined.length);
    expect(joined.length).toBe(800);
    expect(ticks[0]!.joins.length).toBeLessThan(800);
    const first = ticks[0]!.joins[0]!;
    expect(Math.abs(first.state.x) + Math.abs(first.state.z - 20)).toBeLessThan(20);
    // No move goes out for those it is still being told of.
    expect(ticks[0]!.near).toEqual([]);
  });
});

describe('a recount', () => {
  test('tells of a stop that fell inside it, to someone far from the viewer', async () => {
    const env = setup();
    const { world, join, move, view, advance } = env;
    const viewer = join('viewer');
    await view(viewer.id, 10, 20, 180);
    await move(viewer.id, 10, 20);
    // Forty right beside the viewer: the walker, further off, is outside its 32 nearest, and a
    // long tail behind them keeps the recount going over several pages.
    await crowd(env, 40, (i) => [10 + i * 0.01, 20]);
    const walker = join('walker');
    walker.socket.deaf = true;
    await move(walker.id, 40, 20);
    await crowd(env, 1600, (i) => [100 + i * 0.1, 20]);
    for (let t = 0; t < 12; t++) {
      advance(300);
      world.tick();
    }
    viewer.socket.queued = 70_000;
    world.tick();
    viewer.socket.queued = 0;
    viewer.socket.take();
    // The first page tells of the walker: where it stands now, which is about to change.
    world.tick();
    const first = viewer.socket.ticks()[0]!;
    expect(ids(first.joins)).toContain(walker.you);
    expect(first.endsRecount).toBe(false);
    // Its stop falls inside the recount: nobody it is still telling of hears a move.
    viewer.socket.queued = 50_000;
    let stopped = 40;
    let ended = false;
    for (let t = 0; t < 400 && !ended; t++) {
      advance(100);
      if (t < 3) {
        stopped = 41 + t;
        // eslint-disable-next-line no-await-in-loop -- one step at a time
        await move(walker.id, stopped, 20);
      }
      world.tick();
      for (const message of viewer.socket.ticks()) ended ||= Boolean(message.endsRecount);
    }
    expect(ended).toBe(true);
    viewer.socket.queued = 0;
    // Before the fix, this stop was sent to everyone else on its turn and to the viewer never.
    let last: number | null = null;
    for (let t = 0; t < 30; t++) {
      advance(100);
      world.tick();
      for (const message of viewer.socket.ticks()) {
        for (const entry of [...message.near, ...message.far.flatMap((block) => block.moves)]) {
          if (entry.id === walker.you && 'state' in entry) last = entry.state.x;
        }
      }
    }
    expect(last).not.toBeNull();
    expect(last!).toBeCloseTo(stopped, 1);
  });
});

describe('a crowd', () => {
  test('nobody who stopped is lost, however many are moving', { timeout: 30_000 }, async () => {
    const env = setup();
    const { world, join, move, tick, advance } = env;
    const viewer = join('viewer');
    await move(viewer.id, 10, 20);
    // A cell far more crowded than a frame's share of movers: 2000 in one 350 m cell.
    const others = await crowd(env, 2000, (i) => [
      12 + (i % 100) * 3,
      22 + Math.floor(i / 100) * 3,
    ]);
    const last = others.at(-1)!;
    world.tick();
    viewer.socket.take();
    // The furthest one takes one last step, and stops; everyone else keeps walking.
    advance(100);
    await Promise.all(
      others.map((c, i) => move(c.id, 12.5 + (i % 100) * 3, 22 + Math.floor(i / 100) * 3)),
    );
    tick();
    viewer.socket.take();
    const finalX = 12.5 + (1999 % 100) * 3;
    let heard = false;
    for (let t = 0; t < 40 && !heard; t++) {
      advance(100);
      // eslint-disable-next-line no-await-in-loop -- ticks follow one another
      await Promise.all(
        others.map((c, i) =>
          c === last
            ? null
            : move(c.id, 12 + (i % 100) * 3 + (t % 2) * 0.5, 22 + Math.floor(i / 100) * 3),
        ),
      );
      tick();
      for (const message of viewer.socket.ticks()) {
        for (const block of message.far) {
          for (const entry of block.moves) {
            if (entry.id === last.you && Math.abs(entry.state.x - finalX) < 0.1) heard = true;
          }
        }
      }
    }
    expect(heard).toBe(true);
  });

  test(
    'joins are paged, nearest first, and a frame is at most a page and a bit',
    { timeout: 30_000 },
    async () => {
      const env = setup();
      const { world, join } = env;
      await crowd(env, 1500, (i) => [1000 - (i % 40) * 3, 1000 - Math.floor(i / 40) * 3]);
      world.tick();
      const viewer = join('viewer');
      await env.view(viewer.id, 1000, 1000, 200);
      world.tick();
      const first = viewer.socket.ticks()[0]!;
      expect(first.joins.length).toBeGreaterThan(50);
      expect(first.joins.length).toBeLessThan(1500);
      // Nearest first: the first page is all from the ones close by.
      const furthest = Math.max(
        ...first.joins.map((p) => Math.hypot(p.state.x - 1000, p.state.z - 1000)),
      );
      expect(furthest).toBeLessThan(120);
      let total = first.joins.length;
      for (let t = 0; t < 30; t++) {
        world.tick();
        for (const message of viewer.socket.ticks()) total += message.joins.length;
      }
      expect(total).toBe(1500);
    },
  );
});

describe('the near list', () => {
  test('is the true 32 nearest, across a cell corner', { timeout: 30_000 }, async () => {
    const env = setup();
    const { world, join, move, view, advance } = env;
    // A dense patch round the corner of four cells, the ring search's hardest place to be exact.
    const others = await crowd(env, 900, (i) => {
      const angle = i * 2.399963;
      const radius = 1.5 * Math.sqrt(i);
      return [CELL_SIZE + Math.cos(angle) * radius, CELL_SIZE + Math.sin(angle) * radius];
    });
    const viewer = join('viewer');
    const lookX = CELL_SIZE - 3;
    const lookZ = CELL_SIZE + 2;
    await view(viewer.id, lookX, lookZ, 200);
    await move(viewer.id, lookX, lookZ);
    for (let t = 0; t < 12; t++) {
      advance(300);
      world.tick();
    }
    viewer.socket.take();
    const truth = new Set(
      others
        .map((c, i) => {
          const angle = i * 2.399963;
          const radius = 1.5 * Math.sqrt(i);
          const x = CELL_SIZE + Math.cos(angle) * radius;
          const z = CELL_SIZE + Math.sin(angle) * radius;
          return { id: c.you, d: (x - lookX) ** 2 + (z - lookZ) ** 2 };
        })
        .toSorted((a, b) => a.d - b.d)
        .slice(0, 32)
        .map((c) => c.id),
    );
    // Everyone takes a tiny step, so the near list has something to say about each.
    advance(1000);
    await Promise.all(
      others.map((c, i) => {
        const angle = i * 2.399963;
        const radius = 1.5 * Math.sqrt(i) + 0.05;
        return move(
          c.id,
          CELL_SIZE + Math.cos(angle) * radius,
          CELL_SIZE + Math.sin(angle) * radius,
        );
      }),
    );
    world.tick();
    const heard = new Set(viewer.socket.ticks().flatMap((m) => m.near.map((e) => e.id)));
    expect(heard.size).toBeGreaterThanOrEqual(26);
    for (const id of heard) expect(truth.has(id)).toBe(true);
  });
});

describe('a storm of joins', () => {
  test('is spread over ticks, and everyone still hears everyone', { timeout: 30_000 }, async () => {
    const env = setup();
    const { world, join, view, advance } = env;
    await crowd(env, 1500, (i) => [100 + (i % 40) * 2, 100 + Math.floor(i / 40) * 2]);
    world.tick();
    const watchers = Array.from({ length: 600 }, () => join());
    for (const w of watchers) w.socket.deaf = true;
    await Promise.all(watchers.map((w) => view(w.id, 100, 100, 200)));
    const sent = () => watchers.reduce((total, w) => total + w.socket.sent, 0);
    const welcomed = sent();
    let biggest = 0;
    let last = welcomed;
    for (let t = 0; t < 40; t++) {
      advance(t ? 50 : 300);
      world.tick();
      const now = sent();
      biggest = Math.max(biggest, now - last);
      last = now;
    }
    // Six hundred clients would have 16 kB each in one tick, were it not for the slice's share.
    expect(biggest).toBeLessThan(8.5 * 1024 * 1024);
    expect(biggest).toBeGreaterThan(0);
    // A join is at least 32 bytes: all 1500 reached all 600, with the frames around them.
    expect(last - welcomed).toBeGreaterThan(1500 * 600 * 32);
  });
});

describe('interest', () => {
  test('a look zigzagging over a cell edge doesn’t bring anyone in and out', async () => {
    const env = setup();
    const { world, join, move, advance } = env;
    const west = join('west');
    const east = join('east');
    await move(west.id, -CELL_SIZE + 10);
    await move(east.id, CELL_SIZE * 2 + 10);
    const walker = join('walker');
    await env.view(walker.id, CELL_SIZE - 20, 20, 300);
    world.tick();
    walker.socket.take();
    for (const x of [CELL_SIZE + 20, CELL_SIZE - 20, CELL_SIZE + 30, CELL_SIZE - 30]) {
      advance(300);
      // eslint-disable-next-line no-await-in-loop -- one look at a time
      await env.view(walker.id, x, 20, 300);
      world.tick();
    }
    const frames = walker.socket.ticks();
    expect(allJoined(frames)).toEqual([]);
    expect(allLeft(frames)).toEqual([]);
    // Well past the edge: now it moves over.
    advance(300);
    await env.view(walker.id, CELL_SIZE + 60, 20, 300);
    world.tick();
    const moved = walker.socket.ticks();
    expect(allJoined(moved)).toEqual([east.you]);
    expect(allLeft(moved)).toEqual([west.you]);
  });

  test('a zoom out gets its coarse frame on the very next tick', async () => {
    const env = setup();
    const { world, join, move, view, advance } = env;
    const near = join('near');
    const far = join('far');
    const quiet = join('quiet');
    await move(near.id, 30, 20);
    await move(far.id, CELL_SIZE * 8, 20);
    await move(quiet.id, -CELL_SIZE * 5, 20);
    const viewer = join('viewer');
    await view(viewer.id, 10, 20, 300);
    world.tick();
    viewer.socket.take();
    advance(250);
    await view(viewer.id, 10, 20, CELL_SIZE * 10);
    world.tick();
    const heard = viewer.socket.take();
    const coarse = heard.find((m): m is CoarseMessage => m.type === 'coarse');
    expect(coarse).toBeDefined();
    expect(coarse!.first).toBe(true);
    expect(coarse!.last).toBe(true);
    expect(coarseIds(coarse!).toSorted()).toEqual([near.you, far.you, quiet.you].toSorted());
    expect(coarse!.cells.find((c) => c.people.some((p) => p.id === far.you))?.total).toBe(1);
    // A figure it knew in full is still known, as the same person, now coarsely.
    const ticks = heard.filter((m): m is TickMessage => m.type === 'tick');
    expect(allDemoted(ticks)).toEqual([near.you]);
    expect(allLeft(ticks)).toEqual([]);
    // Every coarse person is there, and only in the street.
    await move(far.id, CELL_SIZE * 8, 20, { place: 'stadhuis' });
    advance(1000);
    for (let t = 0; t < 25; t++) world.tick();
    const later = viewer.socket.coarse().at(-1)!;
    expect(coarseIds(later)).not.toContain(far.you);
    expect(coarseIds(later)).toContain(near.you);
  });

  test('coarse frames thin a crowded cell by id, keeping half as the weight doubles', async () => {
    const env = setup();
    const { world, join, view } = env;
    await crowd(env, 500, (i) => [100 + (i % 20) * 3, 100 + Math.floor(i / 20) * 3]);
    world.tick();
    const close = join('close');
    const wide = join('wide');
    await view(close.id, 1000, 100, 1000);
    await view(wide.id, 1000, 100, 3000);
    world.tick();
    const closeCell = close.socket.coarse()[0]!.cells.find((c) => c.total === 500)!;
    const wideCell = wide.socket.coarse()[0]!.cells.find((c) => c.total === 500)!;
    expect(closeCell.weight).toBe(2);
    expect(closeCell.people.length).toBeLessThanOrEqual(256);
    expect(wideCell.weight).toBe(8);
    expect(wideCell.people.length).toBeLessThanOrEqual(64);
    const closeIds = new Set(closeCell.people.map((p) => p.id));
    for (const p of wideCell.people) expect(closeIds.has(p.id)).toBe(true);
  });

  test('a hidden tab hears nobody move, coarsely or not', async () => {
    const env = setup();
    const { world, join, move, view, advance } = env;
    const near = join('near');
    await move(near.id, 30, 20);
    const hidden = join('hidden');
    await move(hidden.id, 10, 20);
    await view(hidden.id, 10, 20, 0);
    advance(1000);
    world.tick();
    hidden.socket.take();
    advance(250);
    await move(near.id, 40, 20);
    for (let t = 0; t < 12; t++) {
      advance(100);
      world.tick();
    }
    const heard = hidden.socket.take();
    expect(heard.filter((m) => m.type === 'tick')).toEqual([]);
    expect(heard.filter((m) => m.type === 'coarse')).toEqual([]);
  });

  test(
    'a coarse crowd keeps coming while its joins are still paging',
    { timeout: 30_000 },
    async () => {
      const env = setup();
      const { world, join, view, advance } = env;
      await crowd(env, 1500, (i) => [CELL_SIZE * 2 + (i % 40) * 3, 20 + Math.floor(i / 40) * 3]);
      const viewer = join('viewer');
      await view(viewer.id, 10, 20, CELL_SIZE * 8);
      world.tick();
      viewer.socket.take();
      // Zooming in on them: the joins can't all fit in a frame.
      advance(1000);
      await view(viewer.id, CELL_SIZE * 2 + 10, 20, 200);
      world.tick();
      const heard = viewer.socket.take();
      const coarse = heard.find((m): m is CoarseMessage => m.type === 'coarse')!;
      expect(coarse.cells.some((c) => c.total === 1500)).toBe(true);
      const joined = heard.flatMap((m) => (m.type === 'tick' ? ids(m.joins) : []));
      expect(joined.length).toBeGreaterThan(0);
      expect(joined.length).toBeLessThan(1500);
      // Once the page is done, its next coarse frame is the wider rest, and no longer covers them.
      for (let t = 0; t < 40; t++) {
        advance(50);
        world.tick();
      }
      const later = viewer.socket.coarse().at(-1);
      expect(later === undefined || !later.cells.some((c) => c.total === 1500)).toBe(true);
    },
  );

  test('a coarse frame too big for a page comes in pages, from first to last', async () => {
    const env = setup();
    const { world, join, view } = env;
    // Two to a cell over the whole of a 34 × 34 cell area: more than one 16 kB page, spread out.
    await crowd(env, 2312, (i) => {
      const cell = Math.floor(i / 2);
      return [
        (Math.floor(cell / 34) - 17) * CELL_SIZE + 20 + (i % 2) * 10,
        ((cell % 34) - 17) * CELL_SIZE + 20,
      ];
    });
    const viewer = join('viewer');
    await view(viewer.id, 0, 0, 12_000);
    world.tick();
    const first = viewer.socket.coarse();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ first: true, last: false });
    expect(viewer.socket.frames.length).toBe(0);
    const seen = new Set(coarseIds(first[0]!));
    let last = first[0]!.last;
    for (let t = 0; t < 10 && !last; t++) {
      world.tick();
      for (const page of viewer.socket.coarse()) {
        expect(page.first).toBe(false);
        for (const id of coarseIds(page)) seen.add(id);
        last ||= page.last;
      }
    }
    expect(last).toBe(true);
    expect(seen.size).toBeGreaterThanOrEqual(2312);
  });

  test('someone out of fine interest and still in coarse is demoted, else left', async () => {
    const env = setup();
    const { world, join, move, view, advance } = env;
    const viewer = join('viewer');
    // Its own figure is off to the side: the minimap keeps that 3×3 in its coarse interest.
    await move(viewer.id, CELL_SIZE * 3 + 10, 20);
    await view(viewer.id, 10, 20, 200);
    const walker = join('walker');
    const away = join('away');
    await move(walker.id, CELL_SIZE * 2 - 5, 20);
    await move(away.id, -CELL_SIZE + 10, 20);
    world.tick();
    expect(allJoined(viewer.socket.ticks()).toSorted()).toEqual([walker.you, away.you].toSorted());
    // Into the avatar's coarse 3×3, and out to nowhere it sees.
    advance(1000);
    await move(walker.id, CELL_SIZE * 2 + 5, 20);
    await move(away.id, -CELL_SIZE - 10, 20);
    world.tick();
    const ticks = viewer.socket.ticks();
    expect(allDemoted(ticks)).toEqual([walker.you]);
    expect(allLeft(ticks)).toEqual([away.you]);
  });

  test('going through a door out of fine interest is a leave, not a demote', async () => {
    const env = setup();
    const { world, join, move, view, advance } = env;
    const viewer = join('viewer');
    await move(viewer.id, CELL_SIZE * 5, 20);
    await view(viewer.id, 10, 20, 200);
    const walker = join('walker');
    await move(walker.id, 30, 20);
    world.tick();
    viewer.socket.take();
    advance(4000);
    await move(walker.id, CELL_SIZE * 5 + 2, 20, { place: 'stadhuis', floor: 1 });
    world.tick();
    const ticks = viewer.socket.ticks();
    expect(allDemoted(ticks)).toEqual([]);
    expect(allLeft(ticks)).toEqual([walker.you]);
  });

  test('an id used again starts over: joined, then a whole move, no delta from the last holder', async () => {
    const env = setup();
    const { world, join, move, advance } = env;
    const viewer = join('viewer');
    await move(viewer.id, 10, 20);
    const first = join('first');
    await move(first.id, 12, 20);
    world.tick();
    viewer.socket.take();
    for (const x of [12.5, 13, 13.5]) {
      advance(100);
      // eslint-disable-next-line no-await-in-loop -- one step at a time
      await move(first.id, x, 20);
      world.tick();
    }
    viewer.socket.take();
    world.disconnect(first.id);
    world.tick();
    expect(allLeft(viewer.socket.ticks())).toEqual([first.you]);
    const second = join('second');
    expect(second.you).toBe(first.you);
    await move(second.id, 40, 20);
    world.tick();
    expect(allJoined(viewer.socket.ticks())).toEqual([second.you]);
    advance(100);
    await move(second.id, 40.5, 20);
    world.tick();
    const [entry] = viewer.socket.ticks().flatMap((t) => t.near);
    if (!entry) throw new Error('no move heard');
    expect('state' in entry).toBe(true);
  });

  test('a join says who someone is and where they are now, name, clothes, room and floor', async () => {
    const env = setup();
    const { world, join, move, view, advance } = env;
    const walker = join('walker');
    walker.socket.deaf = true;
    await move(walker.id, 30, 20);
    const first = join('first');
    await view(first.id, 10, 20, 200);
    world.tick();
    expect(first.socket.ticks().flatMap((t) => t.joins)[0]).toMatchObject({
      name: 'walker',
      state: { x: 30 },
    });
    // What changes, and a brand new viewer must hear all of it, not the bytes cached for the first.
    world.setName('walker', 'walked');
    world.setOutfit('walker', { ...outfit, shirt: 0x00ff00 });
    advance(1000);
    await move(walker.id, 32, 20, { place: 'stadhuis', floor: 2 });
    world.tick();
    const second = join('second');
    await view(second.id, 10, 20, 200);
    advance(300);
    world.tick();
    const heard = second.socket.ticks().flatMap((t) => t.joins);
    expect(heard).toHaveLength(1);
    expect(heard[0]!).toMatchObject({
      name: 'walked',
      outfit: { shirt: 0x00ff00 },
      state: { x: 32, place: 'stadhuis', floor: 2 },
    });
    // Just a step: the same bytes, the numbers written over.
    advance(1000);
    await move(walker.id, 33, 20, { place: 'stadhuis', floor: 0 });
    world.tick();
    const third = join('third');
    await view(third.id, 10, 20, 200);
    advance(300);
    world.tick();
    expect(third.socket.ticks().flatMap((t) => t.joins)[0]).toMatchObject({
      name: 'walked',
      state: { x: 33, place: 'stadhuis', floor: 0 },
    });
    // Out of the room: the same bytes won't do for a viewer who wasn't there before.
    advance(1000);
    await move(walker.id, 34, 20);
    world.tick();
    const fourth = join('fourth');
    await view(fourth.id, 10, 20, 200);
    advance(300);
    world.tick();
    expect(fourth.socket.ticks().flatMap((t) => t.joins)[0]).toMatchObject({
      name: 'walked',
      state: { x: 34, place: '', floor: 0 },
    });
  });

  test('someone demoted who goes before a coarse frame named them is taken off the map', async () => {
    const env = setup();
    const { world, join, move, view, advance } = env;
    const viewer = join('viewer');
    // The look stays in the first of two cells (the 40 m past its edge); the figure's own cell
    // puts the next column along in its coarse interest and the column before that in its fine.
    await view(viewer.id, CELL_SIZE * 2 - 5, 20, 300);
    await move(viewer.id, CELL_SIZE * 2 - 5, 20);
    let ticks = 0;
    const step = (ms = 100) => {
      advance(ms);
      world.tick();
      ticks++;
    };
    for (let t = 0; t < 5; t++) step();
    await view(viewer.id, CELL_SIZE * 2 + 10, 20, 300);
    await move(viewer.id, CELL_SIZE * 2 + 10, 20);
    const x = join('x');
    x.socket.deaf = true;
    await move(x.id, CELL_SIZE * 3 - 10, 20);
    for (let t = 0; t < 12; t++) step(300);
    viewer.socket.take();
    // Slot 0's coarse turn comes every 10th round: step just past it, so no coarse frame can name
    // the figure between the demote and its going.
    const untilTurn = (11 - (ticks % 10)) % 10;
    for (let t = 0; t < untilTurn; t++) step();
    viewer.socket.take();
    await move(x.id, CELL_SIZE * 3 + 10, 20);
    step();
    expect(allDemoted(viewer.socket.ticks())).toEqual([x.you]);
    world.disconnect(x.id);
    for (let t = 0; t < 15; t++) step();
    const frames = viewer.socket.coarse();
    const said = frames.flatMap((m) => m.cells.flatMap((c) => c.people.map((p) => p.id)));
    expect(said).not.toContain(x.you);
    // The empty frame that says nobody is left; before the fix, there were none at all.
    expect(frames.some((m) => m.first && m.last && m.cells.length === 0)).toBe(true);
    // Once told, the emptiness is not said again every second.
    viewer.socket.take();
    for (let t = 0; t < 25; t++) step();
    expect(viewer.socket.coarse()).toEqual([]);
  });

  test('a coarse frame cut off by another still clears what its first page said', async () => {
    const env = setup();
    const { world, join, view, advance } = env;
    await crowd(env, 2312, (i) => {
      const cell = Math.floor(i / 2);
      return [
        (Math.floor(cell / 34) - 17) * CELL_SIZE + 20 + (i % 2) * 10,
        ((cell % 34) - 17) * CELL_SIZE + 20,
      ];
    });
    const viewer = join('viewer');
    await view(viewer.id, 0, 0, 12_000);
    world.tick();
    const pages = viewer.socket.coarse();
    expect(pages[0]).toMatchObject({ first: true, last: false });
    expect(coarseIds(pages[0]!).length).toBeGreaterThan(0);
    // It looks away before the rest of the frame: the people of that first page have to go.
    advance(1000);
    await view(viewer.id, 0, 0, 0);
    world.tick();
    const next = viewer.socket.coarse();
    expect(next.some((m) => m.first && m.last && m.cells.length === 0)).toBe(true);
  });

  test('a shirt that changes shows in the coarse frames too', async () => {
    const env = setup();
    const { world, join, move, view, advance } = env;
    const near = join('near');
    await move(near.id, CELL_SIZE * 8, 20);
    const viewer = join('viewer');
    await view(viewer.id, 10, 20, CELL_SIZE * 12);
    world.tick();
    expect(viewer.socket.coarse()[0]!.cells[0]!.people[0]!.colour).toBe(
      rgb888(rgb565(outfit.shirt)),
    );
    world.setOutfit('near', { ...outfit, shirt: 0x0000ff });
    advance(1000);
    for (let t = 0; t < 25; t++) world.tick();
    expect(viewer.socket.coarse().at(-1)!.cells[0]!.people[0]!.colour).toBe(0x0000ff);
  });
});
