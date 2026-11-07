import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DataTexture, MeshBasicMaterial, MeshToonMaterial, OrthographicCamera, Scene } from 'three';

import type { Outfit } from './character.ts';
import type { PlayerPose } from './crowd.ts';
import { WALKER } from './palette.ts';
import { createPlayers } from './players.ts';
import type { Roster, RosterEntry } from './players.ts';
import type { RiderLook, RiderPose, Riders } from './rider.ts';

/** Just enough of an element for the tags: a class, text, hidden, a style and removal. */
class FakeElement {
  className = '';
  textContent = '';
  hidden = false;
  removed = false;
  readonly children: FakeElement[] = [];
  readonly style = {
    transform: '',
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

const saved = (globalThis as { document?: unknown }).document;
beforeAll(() => {
  (globalThis as { document?: unknown }).document = { createElement: () => new FakeElement() };
});
afterAll(() => {
  (globalThis as { document?: unknown }).document = saved;
});

/** A roster the test moves by hand. */
function rosterOf(entries: RosterEntry[], poses: Map<number, PlayerPose>) {
  let version = 0;
  const roster: Roster & { bump(): void; list: RosterEntry[] } = {
    list: entries,
    bump() {
      version++;
    },
    version: () => version,
    entries: () => roster.list,
    pose(id, _now, out) {
      const at = poses.get(id);
      if (!at) return false;
      Object.assign(out, at);
      return true;
    },
    listen: () => () => {},
  };
  return roster;
}

const pose = (over: Partial<PlayerPose> = {}): PlayerPose => ({
  x: 0,
  z: 0,
  heading: 0,
  speed: 0,
  mode: 'foot',
  place: '',
  floor: 0,
  ...over,
});
const outfit = (shirt: number): Outfit => ({ ...WALKER, shirt });

function setup() {
  const scene = new Scene();
  const camera = new OrthographicCamera(-50, 50, 50, -50, 1, 4000);
  camera.position.set(0, 1000, 1000);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const canvas = { clientWidth: 800, clientHeight: 800 } as HTMLCanvasElement;
  const tags = new FakeElement();
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
    canvas,
    body: new MeshToonMaterial({ gradientMap: new DataTexture(new Uint8Array([255]), 1, 1) }),
    xray: (color) => new MeshBasicMaterial({ color }),
    tags: tags as unknown as HTMLElement,
    reducedMotion: false,
    floorAt: (at) => (at.place === '' ? 1 : at.place === 'kerk' ? 3 : null),
    riders: () => {
      asked++;
      return Promise.resolve(riders);
    },
  });
  return { scene, camera, tags, players, riders, ridden, asked: () => asked };
}

describe('createPlayers', () => {
  test('draws each player near the view as a figure in their clothes, their name over them', () => {
    const { scene, tags, players } = setup();
    const poses = new Map([
      [1, pose({ x: 2, z: 3, speed: 5.4, heading: 1 })],
      [2, pose({ x: -4, z: 0 })],
    ]);
    const roster = rosterOf(
      [
        { id: 1, name: 'ana', outfit: outfit(0x123456) },
        { id: 2, name: 'bo', outfit: outfit(0x654321) },
      ],
      poses,
    );
    players.use(roster);
    expect(players.frame(0, 1 / 60, true, 0, 0, '', 0)).toBe(true);
    expect(players.drawn).toBe(2);
    expect(scene.children).toHaveLength(2);
    const [ana] = scene.children;
    expect(ana!.visible).toBe(true);
    expect([ana!.position.x, ana!.position.z]).toEqual([2, 3]);
    expect(ana!.position.y).toBeGreaterThan(1);
    expect(ana!.rotation.y).toBe(1);
    // Their names, in their shirts' colours, placed over them on screen.
    expect(tags.children.map((t) => t.textContent)).toEqual(['ana', 'bo']);
    expect(tags.children[0]!.style.props.get('--shirt')).toBe('#123456');
    expect(tags.children[0]!.hidden).toBe(false);
    expect(tags.children[0]!.style.transform).toContain('translate3d(');
    // A frame later, standing still, the tag isn't written again.
    const before = tags.children[1]!.style.transform;
    tags.children[1]!.style.transform = 'kept';
    players.frame(16, 1 / 60, true, 0, 0, '', 0);
    expect(tags.children[1]!.style.transform).toBe('kept');
    expect(before).not.toBe('kept');
  });

  test('zoomed out, in another room, or unknown: not drawn, no tag', () => {
    const { scene, tags, players } = setup();
    const poses = new Map([[1, pose({ place: 'kerk' })]]);
    players.use(rosterOf([{ id: 1, name: 'ana', outfit: WALKER }], poses));
    players.frame(0, 0.1, true, 0, 0, '', 0);
    expect(players.drawn).toBe(0);
    expect(scene.children[0]!.visible).toBe(false);
    expect(tags.children[0]!.hidden).toBe(true);
    // In the same room, on its floor.
    players.frame(0, 0.1, true, 0, 0, 'kerk', 0);
    expect(players.drawn).toBe(1);
    expect(scene.children[0]!.position.y).toBeGreaterThan(3);
    // Too far out for figures.
    players.frame(0, 0.1, false, 0, 0, 'kerk', 0);
    expect(players.drawn).toBe(0);
    // A room the map can't place them in.
    poses.set(1, pose({ place: 'elsewhere' }));
    players.frame(0, 0.1, true, 0, 0, 'elsewhere', 0);
    expect(players.drawn).toBe(0);
    // Nothing known of them yet.
    poses.delete(1);
    players.frame(0, 0.1, true, 0, 0, '', 0);
    expect(players.drawn).toBe(0);
    // Off the screen, the tag hides.
    poses.set(1, pose({ x: 5000 }));
    players.frame(0, 0.1, true, 0, 0, '', 0);
    expect(tags.children[0]!.hidden).toBe(true);
  });

  test('joins, leaves and new clothes follow the roster; only the nearest are drawn', () => {
    const { scene, tags, players } = setup();
    const poses = new Map<number, PlayerPose>();
    const entries: RosterEntry[] = [];
    for (let id = 1; id <= 30; id++) {
      poses.set(id, pose({ x: id, z: 0 }));
      entries.push({ id, name: `p${id}`, outfit: WALKER });
    }
    const roster = rosterOf(entries, poses);
    players.use(roster);
    players.frame(0, 0.1, true, 0, 0, '', 0);
    // 24 at most, the nearest the view.
    expect(players.drawn).toBe(24);
    expect(scene.children.filter((c) => c.visible)).toHaveLength(24);
    expect(scene.children.at(-1)!.visible).toBe(false);
    // One leaves, one changes shirt and name.
    const renamed: RosterEntry = { id: 1, name: 'ana', outfit: outfit(0xff0000) };
    roster.list = [renamed, ...entries.slice(1, -1)];
    roster.bump();
    players.frame(0, 0.1, true, 0, 0, '', 0);
    expect(scene.children).toHaveLength(29);
    expect(tags.children.filter((t) => t.removed)).toHaveLength(1);
    expect(tags.children[0]!.textContent).toBe('ana');
    expect(tags.children[0]!.style.props.get('--shirt')).toBe('#ff0000');
    // Signed out: everyone goes.
    players.use(null);
    expect(scene.children).toHaveLength(0);
    expect(players.frame(0, 0.1, true, 0, 0, '', 0)).toBe(false);
    players.dispose();
  });

  test('riders ride: the riders load once, each on a bike, in their clothes', async () => {
    const { scene, players, riders, ridden, asked } = setup();
    const poses = new Map([[7, pose({ x: 1, speed: 10, mode: 'bike' as const })]]);
    players.use(rosterOf([{ id: 7, name: 'cy', outfit: outfit(0xabcdef) }], poses));
    players.frame(0, 0.1, true, 0, 0, '', 0);
    // Loading: the figure stays hidden meanwhile.
    expect(scene.children[0]!.visible).toBe(false);
    players.frame(0, 0.1, true, 0, 0, '', 0);
    expect(asked()).toBe(1);
    await Promise.resolve();
    players.frame(0, 0.1, true, 0, 0, '', 0);
    expect(riders.count).toBe(1);
    expect(ridden[0]!.look.shirt).toBe(0xabcdef);
    expect(ridden[0]!.at.x).toBe(1);
    expect(ridden[0]!.at.y).toBe(1);
    expect(ridden[0]!.at.pedal).toBeGreaterThan(0);
    // Off the bike again: no riders.
    poses.set(7, pose({ x: 1 }));
    players.frame(0, 0.1, true, 0, 0, '', 0);
    expect(riders.count).toBe(0);
    expect(scene.children[0]!.visible).toBe(true);
    players.use(null);
    players.dispose();
  });

  test('a failed download of the riders is tried again when someone next rides', async () => {
    const { players } = setup();
    let tries = 0;
    const flaky = createPlayers({
      scene: new Scene(),
      camera: new OrthographicCamera(),
      canvas: { clientWidth: 1, clientHeight: 1 } as HTMLCanvasElement,
      body: new MeshToonMaterial(),
      xray: (color) => new MeshBasicMaterial({ color }),
      tags: null,
      reducedMotion: true,
      floorAt: () => 0,
      riders: () => {
        tries++;
        return Promise.reject(new Error('offline'));
      },
    });
    flaky.use(
      rosterOf([{ id: 1, name: 'x', outfit: WALKER }], new Map([[1, pose({ mode: 'bike' })]])),
    );
    flaky.frame(0, 0.1, true, 0, 0, '', 0);
    await Promise.resolve();
    await Promise.resolve();
    flaky.frame(0, 0.1, true, 0, 0, '', 0);
    expect(tries).toBe(2);
    flaky.dispose();
    players.dispose();
  });
});
