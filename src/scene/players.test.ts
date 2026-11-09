import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { Mock } from 'bun:test';
import { DataTexture, MeshBasicMaterial, MeshToonMaterial, OrthographicCamera, Scene } from 'three';
import type { InstancedMesh } from 'three';

import { createPeople } from '../net/people.ts';
import type { Roster } from '../net/people.ts';
import type { Outfit } from './character.ts';
import type { Fade } from './character-material.ts';
import { RIG_WIN, groundRect } from './lod.ts';
import { WALKER } from './palette.ts';
import { IDLE, SLOW, FAST, createPlayers } from './players.ts';
import type { PlayersView } from './players.ts';
import type { RiderLook, RiderPose, Riders } from './rider.ts';

/** Just enough of an element for the tags: a class, text, a style, and being removed. */
class FakeElement {
  className = '';
  textContent = '';
  removed = false;
  dataset: Record<string, string> = {};
  offsetWidth = 40;
  offsetHeight = 18;
  readonly children: FakeElement[] = [];
  readonly style = {
    transform: '',
    opacity: '',
    zIndex: '',
    props: new Map<string, string>(),
    setProperty(name: string, value: string) {
      this.props.set(name, value);
    },
  };
  append(child: FakeElement) {
    this.children.push(child);
  }
  remove() {
    this.removed = true;
  }
}

/** A 2D canvas that records the markers stamped on it, and answers to anything else. */
class FakeCanvas {
  width = 0;
  height = 0;
  stamped = 0;
  cleared = 0;
  getContext() {
    const pen: Record<string, unknown> = {
      globalAlpha: 1,
      drawImage: () => this.stamped++,
      clearRect: () => this.cleared++,
    };
    return new Proxy(pen, {
      get: (target, name) => (name in target ? target[name as string] : () => {}),
    });
  }
}

const saved = (globalThis as { document?: unknown }).document;
const savedWindow = (globalThis as { window?: unknown }).window;
let clock: Mock<() => number>;
let time = 0;
beforeAll(() => {
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => (tag === 'canvas' ? new FakeCanvas() : new FakeElement()),
    visibilityState: 'visible',
  };
  (globalThis as { window?: unknown }).window = { devicePixelRatio: 2 };
  clock = spyOn(performance, 'now').mockImplementation(() => time);
});
afterAll(() => {
  (globalThis as { document?: unknown }).document = saved;
  (globalThis as { window?: unknown }).window = savedWindow;
  clock.mockRestore();
});

const outfit = (shirt: number): Outfit => ({ ...WALKER, shirt });
const state = (x = 0, z = 0, speed = 0, more: object = {}) => ({
  x,
  z,
  heading: 0,
  speed,
  mode: 'foot' as const,
  place: '',
  floor: 0,
  ...more,
});

function rosterOf(cap = 600, marks: FakeCanvas | null = null) {
  const people = createPeople();
  const looks: number[][] = [];
  const roster: Roster = {
    people,
    look: (x, z, reach) => looks.push([x, z, reach]),
    listen: () => () => {},
  };
  const scene = new Scene();
  const camera = new OrthographicCamera(-50, 50, 50, -50, 1, 4000);
  camera.position.set(0, 1000, 1000);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const tags = new FakeElement();
  const fades: Fade[] = [];
  const ridden: { look: RiderLook; at: RiderPose }[] = [];
  const riders: Riders = {
    meshes: [],
    count: 0,
    pose: (i, at) => (ridden[i] = { ...ridden[i]!, at: { ...at } }),
    dress: (i, look) => (ridden[i] = { ...ridden[i]!, look: { ...look } }),
    dispose: () => {},
  };
  let asked = 0;
  const players = createPlayers({
    scene,
    camera,
    material: (fade: Fade) => {
      fades.push(fade);
      return new MeshToonMaterial({ gradientMap: new DataTexture(new Uint8Array([255]), 1, 1) });
    },
    xray: (color) => new MeshBasicMaterial({ color }),
    crowd: () => ({ body: new MeshBasicMaterial(), xray: new MeshBasicMaterial() }),
    tags: tags as unknown as HTMLElement,
    marks: marks as unknown as HTMLCanvasElement | null,
    reducedMotion: false,
    floorAt: (at) => (at.place === '' ? 1 : at.place === 'kerk' ? 3 : null),
    groundAt: () => 1,
    riders: () => {
      asked++;
      return Promise.resolve(riders);
    },
    cap,
  });
  players.use(roster);
  return { people, players, scene, tags, ridden, riders, looks, fades, asked: () => asked, roster };
}

/** A view at (x, z) `height` css px tall, zoomed to show figures `pixels` tall. */
function viewAt(
  x: number,
  z: number,
  pixels: number,
  height = 800,
  place = '',
  floor = 0,
): PlayersView {
  const zoom = (pixels * 352) / height;
  const span = 560 / zoom;
  return {
    rect: groundRect(x, z, span, 1, 0, 10),
    span,
    width: height,
    height,
    place,
    floor,
  };
}

/** A frame, after `dt` milliseconds, as the map draws one. */
function frame(players: ReturnType<typeof createPlayers>, view: PlayersView, dt = 16) {
  time += dt;
  const pace = players.step(dt / 1000);
  players.place(view);
  return pace;
}

const crowdOf = (scene: Scene) =>
  scene.children.find((c) => (c as InstancedMesh).isInstancedMesh && c.renderOrder === 2) as
    InstancedMesh | undefined;
const figures = (scene: Scene) =>
  scene.children.filter((c) => !(c as InstancedMesh).isInstancedMesh);

describe('createPlayers', () => {
  test('zoomed in, someone heard of in full wears a figure and a name', () => {
    const { people, players, scene, tags } = rosterOf();
    people.join(time, 1, 'ana', outfit(0x123456), state(2, 3, 5.4));
    frame(players, viewAt(0, 0, 40));
    for (let i = 0; i < 20; i++) frame(players, viewAt(0, 0, 40), 16);
    expect(players.calls).toBe(2);
    expect(players.drawn).toBe(1);
    expect(figures(scene)[0]!.visible).toBe(true);
    expect(tags.children[0]!.textContent).toBe('ana');
    expect(tags.children[0]!.style.props.get('--shirt')).toBe('#123456');
    expect(tags.children[0]!.dataset.shown).toBe('1');
    expect(tags.children[0]!.style.transform).toContain('translate3d(');
    // A frame later, standing, its tag is not written again.
    const before = tags.children[0]!.style.transform;
    tags.children[0]!.style.transform = 'kept';
    people.move(time, 1, state(2, 3, 0));
    frame(players, viewAt(0, 0, 40));
    expect(tags.children[0]!.style.transform).toBe('kept');
    expect(before).not.toBe('kept');
    // Fine-only: figures only go to those heard of in full; a coarse person is the crowd's.
    people.beginCoarse();
    people.coarse(time, 2, 8, 8, 0xff0000, 1);
    people.endCoarse(time);
    for (let i = 0; i < 20; i++) frame(players, viewAt(0, 0, 40), 16);
    expect(players.calls).toBe(4);
    expect(crowdOf(scene)!.count).toBe(1);
  });

  test('zoomed out past the band of figures, nobody is drawn in the scene at all', () => {
    const { people, players, scene } = rosterOf();
    people.join(time, 1, 'ana', outfit(1), state(1, 1));
    frame(players, viewAt(0, 0, 40));
    frame(players, viewAt(0, 0, 3));
    expect(players.calls).toBe(0);
    expect(players.drawn).toBe(1);
    expect(figures(scene)[0]?.visible ?? false).toBe(false);
    expect(crowdOf(scene)?.visible ?? false).toBe(false);
  });

  test('those out of view, or indoors elsewhere, are nobody the street draws', () => {
    const { people, players } = rosterOf();
    people.join(time, 1, 'ana', outfit(1), state(1, 1));
    people.join(time, 2, 'bo', outfit(2), state(3, 3, 0, { place: 'kerk' }));
    people.join(time, 3, 'cy', outfit(3), state(9000, 0));
    frame(players, viewAt(0, 0, 40));
    frame(players, viewAt(0, 0, 40));
    expect(players.drawn).toBe(1);
    // In the same room, its floor: those inside draw in the room with you.
    frame(players, viewAt(0, 0, 40, 800, 'kerk', 0));
    expect(players.drawn).toBe(2);
  });

  test('the nearest 24 are figures, the rest a crowd, in one draw call however many', () => {
    const { people, players, scene, tags } = rosterOf();
    for (let id = 1; id <= 30; id++) people.join(time, id, `p${id}`, outfit(id), state(id / 5, 0));
    frame(players, viewAt(0, 0, 40));
    // Two figures are dressed a frame: the rest are the crowd's in the meantime, and none absent.
    expect(players.drawn).toBe(30);
    for (let i = 0; i < 30; i++) frame(players, viewAt(0, 0, 40));
    expect(players.calls).toBe(RIG_WIN * 2 + 2);
    expect(crowdOf(scene)!.count).toBe(6);
    expect(tags.children).toHaveLength(RIG_WIN);
  });

  test('someone at the edge of the nearest keeps their figure: no flip-flop', () => {
    const { people, players, scene } = rosterOf();
    for (let id = 1; id <= 30; id++) people.join(time, id, `p${id}`, outfit(id), state(id / 5, 0));
    for (let i = 0; i < 40; i++) frame(players, viewAt(0, 0, 40));
    const dressed = figures(scene).filter((m) => m.visible).length;
    // The one in a figure at rank 24 drifts to rank 28: still its own, for that's within 30.
    people.move(time, 24, state(5.5, 0));
    people.move(time, 25, state(4.7, 0));
    for (let i = 0; i < 80; i++) frame(players, viewAt(0, 0, 40));
    expect(figures(scene).filter((m) => m.visible).length).toBe(dressed);
    expect(players.calls).toBe(RIG_WIN * 2 + 2);
  });

  test('the zoom hands a figure on: part rig, part crowd figure, its complement', () => {
    const { people, players, scene } = rosterOf();
    people.join(time, 1, 'ana', outfit(1), state(1, 1));
    for (let i = 0; i < 40; i++) frame(players, viewAt(0, 0, 40));
    const crowd = () => crowdOf(scene);
    // Halfway through the band, both are drawn, and the crowd figure draws what's left.
    frame(players, viewAt(0, 0, 12));
    frame(players, viewAt(0, 0, 12));
    expect(players.calls).toBe(4);
    expect(crowd()!.count).toBe(1);
    const fade = crowd()!.geometry.getAttribute('motion').getZ(0);
    expect(fade).toBeLessThan(0);
    expect(-fade).toBeCloseTo(0.5, 2);
    // Past the band, only the crowd's figure.
    frame(players, viewAt(0, 0, 9.4));
    expect(players.calls).toBe(2);
    expect(crowd()!.geometry.getAttribute('motion').getZ(0)).toBeCloseTo(1, 5);
    // Back in: the very same figure, no waiting for anything to happen.
    for (let i = 0; i < 40; i++) frame(players, viewAt(0, 0, 40));
    expect(players.calls).toBe(2);
  });

  test('a crowd past the cap falls to markers, none go missing', () => {
    const { people, players, scene } = rosterOf(5);
    for (let id = 1; id <= 30; id++) people.join(time, id, `p${id}`, outfit(id), state(id / 4, 0));
    // Below the band of full figures, everyone's a crowd figure or a marker.
    for (let i = 0; i < 30; i++) frame(players, viewAt(0, 0, 9.4));
    expect(crowdOf(scene)!.count).toBeLessThanOrEqual(5);
    expect(players.drawn).toBe(30);
  });

  test('news: a marker is the overlay’s, a moving figure is worth a frame', () => {
    const { people, players } = rosterOf();
    people.join(time, 1, 'ana', outfit(1), state(1, 1, 3));
    const close = viewAt(0, 0, 40);
    frame(players, close);
    for (let i = 0; i < 40; i++) {
      time += 16;
      people.move(time, 1, state(1 + i * 0.05, 1, 3));
      players.step(0.016);
      players.place(close);
    }
    // Someone in a full figure is walking, and on screen.
    expect(players.step(0.016)).toBe(FAST);
    time += 2000;
    people.move(time, 1, state(9, 1, 3));
    expect(players.news(close)).toBe(FAST);
    // Far out, the map draws nothing for it: only the markers' own timer.
    const far = viewAt(0, 0, 3);
    frame(players, far);
    expect(players.news(far)).toBe(IDLE);
    // The crowd walking alone asks for a frame now and then.
    const crowdOnly = viewAt(0, 0, 9.4);
    for (let i = 0; i < 20; i++) {
      time += 50;
      people.move(time, 1, state(9 + i * 0.1, 1, 3));
      frame(players, crowdOnly, 0);
    }
    expect(players.pace()).toBe(SLOW);
    people.move(time + 1, 1, state(10, 1, 0));
    time += 3000;
    for (let i = 0; i < 6; i++) frame(players, crowdOnly);
    expect(players.pace()).toBe(IDLE);
  });

  test('markers: stamped in the layer over the map, for the far-out view, by themselves', async () => {
    const canvas = new FakeCanvas();
    const { people, players } = rosterOf(600, canvas);
    for (let id = 1; id <= 6; id++)
      people.join(time, id, `p${id}`, outfit(id * 1000), state(id, 0, 2));
    const far = viewAt(0, 0, 3);
    frame(players, far, 300);
    frame(players, far, 300);
    expect(canvas.width).toBe(1600);
    const stamped = canvas.stamped;
    expect(stamped).toBeGreaterThan(0);
    // News of someone walking is the layer's: no frame, but it's stamped again soon on its own.
    people.move(time + 16, 1, state(1.1, 0, 2));
    expect(players.news(far)).toBe(IDLE);
    time += 16;
    await new Promise((settled) => setTimeout(settled, 320));
    expect(canvas.stamped).toBeGreaterThan(stamped);
    // Close in, the layer is wiped and left alone.
    const before = canvas.cleared;
    for (let i = 0; i < 30; i++) frame(players, viewAt(0, 0, 40));
    expect(canvas.cleared).toBeGreaterThan(before);
    // Back out, the band where a marker fades in over a figure still paints both.
    frame(players, viewAt(0, 0, 8.4));
    expect(canvas.stamped).toBeGreaterThan(stamped);
    players.dispose();
  });

  test('a cap in the street hands those over it to markers, even close in', () => {
    const canvas = new FakeCanvas();
    const { people, players, scene } = rosterOf(3, canvas);
    for (let id = 1; id <= 12; id++) {
      people.join(time, id, `p${id}`, outfit(id * 1000), state(id / 2, 0));
    }
    for (let i = 0; i < 40; i++) frame(players, viewAt(0, 0, 40));
    // Twelve are FINE and near: rigs for up to 12 of them.
    expect(players.calls).toBeGreaterThan(0);
    // At the crowd figures' band only three instances exist; the rest are stamped.
    const before = canvas.stamped;
    for (let i = 0; i < 40; i++) frame(players, viewAt(0, 0, 9.4));
    expect(crowdOf(scene)!.count).toBeLessThanOrEqual(3);
    expect(canvas.stamped).toBeGreaterThan(before);
    players.dispose();
  });

  test('riders: loaded once, dressed, faded with the band', async () => {
    const { people, players, riders, ridden, asked } = rosterOf();
    people.join(time, 7, 'cy', outfit(0xabcdef), state(1, 0, 10, { mode: 'bike' as const }));
    frame(players, viewAt(0, 0, 40));
    frame(players, viewAt(0, 0, 40));
    expect(asked()).toBe(1);
    await Promise.resolve();
    for (let i = 0; i < 40; i++) frame(players, viewAt(0, 0, 40));
    expect(riders.count).toBe(1);
    expect(ridden[0]!.look.shirt).toBe(0xabcdef);
    expect(ridden[0]!.at.y).toBe(1);
    expect(ridden[0]!.at.fade).toBeGreaterThan(0.9);
    people.move(time, 7, state(1, 0, 0));
    for (let i = 0; i < 20; i++) frame(players, viewAt(0, 0, 40));
    expect(riders.count).toBe(0);
  });

  test('a failed download of the riders isn’t asked for again every frame', async () => {
    let tries = 0;
    const people = createPeople();
    const flaky = createPlayers({
      scene: new Scene(),
      camera: new OrthographicCamera(),
      material: () => new MeshToonMaterial(),
      xray: (color) => new MeshBasicMaterial({ color }),
      crowd: () => ({ body: new MeshBasicMaterial(), xray: new MeshBasicMaterial() }),
      tags: null,
      marks: null,
      reducedMotion: true,
      floorAt: () => 0,
      groundAt: () => 0,
      cap: 8,
      riders: () => {
        tries++;
        return Promise.reject(new Error('offline'));
      },
    });
    flaky.use({ people, look: () => {}, listen: () => () => {} });
    people.join(time, 1, 'x', WALKER, state(0, 0, 8, { mode: 'bike' as const }));
    frame(flaky, viewAt(0, 0, 40));
    await Promise.resolve();
    await Promise.resolve();
    frame(flaky, viewAt(0, 0, 40));
    expect(tries).toBe(1);
    flaky.dispose();
  });

  test('a frame the camera drew keeps asking while figures are still being dressed', () => {
    const { people, players, scene } = rosterOf();
    for (let id = 1; id <= 30; id++) people.join(time, id, `p${id}`, outfit(id), state(id / 5, 0));
    const close = viewAt(0, 0, 40);
    frame(players, close);
    // Two figures a frame: the rest of the 24 are waiting, standing or not.
    expect(figures(scene).length).toBeLessThan(RIG_WIN);
    expect(players.pace()).toBe(FAST);
    for (let i = 0; i < 500; i++) frame(players, close);
    expect(figures(scene).length).toBe(RIG_WIN);
    // Dressed, standing and settled: the frames stop.
    expect(players.pace()).toBe(IDLE);
  });

  test('news: someone who left, or came, or went in through a door is news without a new version', () => {
    const { people, players } = rosterOf();
    people.join(time, 1, 'ana', outfit(1), state(2, 2));
    const view = viewAt(0, 0, 8.5);
    for (let i = 0; i < 40; i++) frame(players, view);
    expect(players.news(view)).toBe(IDLE);
    people.leave(time, 1);
    time += 16;
    expect(players.news(view)).toBe(SLOW);
    for (let i = 0; i < 40; i++) frame(players, view);
    expect(people.count).toBe(0);
    expect(players.pace()).toBe(IDLE);
    people.join(time, 2, 'bo', outfit(2), state(2, 2));
    for (let i = 0; i < 40; i++) frame(players, view);
    time += 16;
    expect(players.news(view)).toBe(IDLE);
    // Through a door, with nothing else to say: at a spot of its own, in another room.
    people.jump(time, 2, state(8, 8, 0, { place: 'kerk' }));
    expect(players.news(view)).not.toBe(IDLE);
  });

  test('a first joiner draws their whole fade-in: frames continue while they show at 0', () => {
    const { people, players, scene } = rosterOf();
    const view = viewAt(0, 0, 8.5);
    frame(players, view);
    people.join(time, 1, 'ana', outfit(1), state(2, 2));
    frame(players, view, 0);
    expect(players.pace()).toBe(SLOW);
    for (let i = 0; i < 40; i++) frame(players, view);
    expect(crowdOf(scene)!.geometry.getAttribute('motion').getZ(0)).toBeCloseTo(1, 5);
    expect(players.pace()).toBe(IDLE);
  });

  test('news: someone walking in another room is nothing to draw', () => {
    const { people, players } = rosterOf();
    people.join(time, 1, 'ana', outfit(1), state(2, 2, 3, { place: 'kerk' }));
    const view = viewAt(0, 0, 40);
    for (let i = 0; i < 20; i++) frame(players, view);
    for (let i = 0; i < 8; i++) {
      time += 100;
      people.move(time, 1, state(2 + i, 2, 3));
      expect(players.news(view)).toBe(IDLE);
    }
  });

  test('the rig at a zoom a marker takes over from still shows as a marker', () => {
    const canvas = new FakeCanvas();
    const { people, players } = rosterOf(600, canvas);
    for (let id = 1; id <= 6; id++) people.join(time, id, `p${id}`, outfit(id), state(id * 15, 0));
    for (let i = 0; i < 80; i++) frame(players, viewAt(0, 0, 40));
    const before = canvas.stamped;
    frame(players, viewAt(0, 0, 6.4));
    // All six, though their figures have yet to be given back.
    expect(canvas.stamped - before).toBeGreaterThanOrEqual(6);
    players.dispose();
  });

  test('a marker goes when nobody is left to mark', async () => {
    const canvas = new FakeCanvas();
    const { people, players } = rosterOf(600, canvas);
    people.join(time, 1, 'ana', outfit(1), state(3, 3));
    const far = viewAt(0, 0, 3);
    for (let i = 0; i < 20; i++) frame(players, far);
    expect(canvas.stamped).toBeGreaterThan(0);
    people.forget();
    players.news(far);
    const cleared = canvas.cleared;
    await new Promise((settled) => setTimeout(settled, 300));
    expect(canvas.cleared).toBeGreaterThan(cleared);
    players.dispose();
  });

  test('a long gap between frames is one frame of a swap, not the whole of it', () => {
    const { people, players, fades } = rosterOf();
    const close = viewAt(0, 0, 40);
    frame(players, close);
    people.join(time, 1, 'ana', outfit(1), state(1, 1));
    // A first frame for the list to say they're there at all.
    for (let i = 0; i < 20; i++) frame(players, close);
    expect(fades[0]!.value).toBeCloseTo(1, 5);
    // Back out and in, with nothing drawn for three seconds in between.
    frame(players, viewAt(0, 0, 9.4));
    time += 3000;
    frame(players, close, 16);
    expect(fades[0]!.value).toBeGreaterThan(0);
    expect(fades[0]!.value).toBeLessThanOrEqual(0.5);
  });

  test('what’s per person follows them as the list packs its slots', () => {
    const { people, players, scene } = rosterOf(1);
    const view = viewAt(0, 0, 9.4);
    people.join(time, 1, 'a', outfit(1), state(0.1, 0));
    people.join(time, 2, 'b', outfit(2), state(5, 0));
    people.join(time, 3, 'c', outfit(3), state(60, 0));
    for (let i = 0; i < 40; i++) frame(players, view);
    const crowd = crowdOf(scene)!;
    expect(crowd.count).toBe(1);
    expect(crowd.instanceMatrix.array[12]).toBeCloseTo(0.1, 1);
    // The nearest goes; the farthest, a marker, is moved down into its slot and stays a marker.
    people.leave(time, 1);
    while (people.count > 2) frame(players, view);
    frame(players, view);
    expect(crowd.instanceMatrix.array[12]).toBeCloseTo(5, 1);
  });

  test('a door is a short dither where they went in, not a pop or a figure left behind', () => {
    const { people, players, scene, fades } = rosterOf();
    people.join(time, 1, 'ana', outfit(1), state(2, 3));
    const close = viewAt(0, 0, 40);
    for (let i = 0; i < 30; i++) frame(players, close);
    const body = figures(scene)[0]!;
    expect(body.position.x).toBeCloseTo(2, 3);
    people.jump(time, 1, state(4, 6, 0, { place: 'kerk' }));
    frame(players, close);
    // The rig is partway gone, where they stood, not at the new spot in the church.
    expect(fades[0]!.value).toBeGreaterThan(0);
    expect(fades[0]!.value).toBeLessThan(1);
    expect(body.position.x).toBeCloseTo(2, 3);
    for (let i = 0; i < 20; i++) frame(players, close);
    expect(body.visible).toBe(false);
    expect(players.drawn).toBe(0);
    // The crowd's figure does the same, a share at a time.
    const { people: p2, players: q, scene: s2 } = rosterOf();
    p2.join(time, 1, 'ana', outfit(1), state(2, 3));
    const band = viewAt(0, 0, 9.4);
    for (let i = 0; i < 30; i++) frame(q, band);
    p2.jump(time, 1, state(4, 6, 0, { place: 'kerk' }));
    frame(q, band);
    const instance = crowdOf(s2)!;
    expect(instance.count).toBe(1);
    expect(instance.instanceMatrix.array[12]).toBeCloseTo(2, 3);
    expect(instance.geometry.getAttribute('motion').getZ(0)).toBeLessThan(1);
    for (let i = 0; i < 20; i++) frame(q, band);
    expect(instance.count).toBe(0);
  });

  test('signed out, everyone goes and the frames stop', () => {
    const { people, players, scene } = rosterOf();
    people.join(time, 1, 'ana', outfit(1), state(1, 1));
    for (let i = 0; i < 40; i++) frame(players, viewAt(0, 0, 40));
    players.use(null);
    expect(players.drawn).toBe(0);
    expect(players.calls).toBe(0);
    expect(players.people()).toBeNull();
    expect(figures(scene).filter((c) => c.visible)).toHaveLength(0);
    expect(players.step(0.016)).toBe(IDLE);
    expect(players.news(viewAt(0, 0, 40))).toBe(IDLE);
    players.dispose();
  });
});
