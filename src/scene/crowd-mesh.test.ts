import { describe, expect, test } from 'bun:test';
import { MeshBasicMaterial, Scene } from 'three';
import type { BufferAttribute, InstancedMesh } from 'three';

import { TINT_ROLE, createCrowdMesh, crowdFigureGeometry } from './crowd-mesh.ts';
import { CHARACTER_SCALE } from './figure.ts';
import { WALKER } from './palette.ts';

describe('the crowd figure', () => {
  const geometry = crowdFigureGeometry();

  test('is a small figure of about the walker’s height', () => {
    const triangles = geometry.index!.count / 3;
    expect(triangles).toBeGreaterThan(90);
    expect(triangles).toBeLessThanOrEqual(160);
    const { min, max } = geometry.boundingBox!;
    // Its feet at the ground, its head where the walker's is, within a bit for the hull.
    expect(min.y).toBeCloseTo(-0.035, 2);
    expect(max.y).toBeGreaterThan(1.8);
    expect(max.y).toBeLessThan(2.05);
    // A small figure's arms out to about the walker's shoulder span.
    expect(max.x).toBeLessThan(0.45);
  });

  test('every vertex says which limb it is and what it wears', () => {
    const facade = geometry.getAttribute('facade') as BufferAttribute;
    const roles = new Set<number>();
    const bones = new Set<number>();
    for (let i = 0; i < facade.count; i++) {
      const value = facade.getX(i);
      bones.add(Math.floor(value));
      roles.add(Math.round((value % 1) * 8));
    }
    expect(roles.has(TINT_ROLE.shirt)).toBe(true);
    expect(roles.has(TINT_ROLE.ink)).toBe(true);
    expect(roles.has(TINT_ROLE.skin)).toBe(true);
    expect(roles.has(TINT_ROLE.hair)).toBe(true);
    // The torso, the head, both arms, both legs, the root for the blob.
    expect([...bones].toSorted((a, b) => a - b)).toEqual([0, 2, 3, 4, 5, 8, 9]);
  });
});

function setup(cap = 4) {
  const scene = new Scene();
  const mesh = createCrowdMesh(
    { scene, body: new MeshBasicMaterial(), xray: new MeshBasicMaterial(), ink: { value: 0 } },
    cap,
  );
  return { scene, mesh };
}
const bodyOf = (scene: Scene) => scene.children[0] as InstancedMesh;

describe('createCrowdMesh', () => {
  test('writes an instance facing its heading, its feet just over the ground', () => {
    const { scene, mesh } = setup();
    mesh.place(0, 10, 2, 20, 0, 0.5, 1, 0.75, 0xff0000, null);
    mesh.finish(1, 0.1);
    const body = bodyOf(scene);
    expect(body.count).toBe(1);
    expect(body.visible).toBe(true);
    const m = body.instanceMatrix.array;
    expect(m[0]).toBeCloseTo(CHARACTER_SCALE, 5);
    expect(m[12]).toBe(10);
    expect(m[13]).toBeCloseTo(2.04, 5);
    expect(m[14]).toBe(20);
    expect(body.geometry.getAttribute('motion').getX(0)).toBeCloseTo(0.5, 5);
    expect(body.geometry.getAttribute('motion').getY(0)).toBe(1);
    expect(body.geometry.getAttribute('motion').getZ(0)).toBeCloseTo(0.75, 5);
    // Red in the shirt, the walker's clothes otherwise.
    expect(body.geometry.getAttribute('shirt').getX(0)).toBe(1);
    expect(body.geometry.getAttribute('look').getX(0)).toBe(WALKER.shorts);
    expect(scene.children).toHaveLength(2);
    mesh.dispose();
    expect(scene.children).toHaveLength(0);
  });

  test('writes a colour only when what the instance is painted changes', () => {
    const { scene, mesh } = setup();
    const shirt = () => bodyOf(scene).geometry.getAttribute('shirt') as BufferAttribute;
    const look = () => bodyOf(scene).geometry.getAttribute('look') as BufferAttribute;
    mesh.place(0, 0, 0, 0, 0, 0, 0, 1, 0xff0000, null);
    const shirts = shirt().version;
    const looks = look().version;
    // Next frame, the same: nothing uploaded.
    mesh.place(0, 1, 0, 0, 0, 0, 0, 1, 0xff0000, null);
    expect(shirt().version).toBe(shirts);
    expect(look().version).toBe(looks);
    // A shirt changing alone is the shirt's business.
    mesh.place(0, 1, 0, 0, 0, 0, 0, 1, 0x00ff00, null);
    expect(shirt().version).toBeGreaterThan(shirts);
    expect(look().version).toBe(looks);
    // Known by their clothes now (a coarse person heard of in full), the shirt the same: written.
    const outfit = { ...WALKER, shirt: 0x00ff00, shorts: 0x112233, skin: 0x445566, hair: 0x778899 };
    mesh.place(0, 1, 0, 0, 0, 0, 0, 1, 0x00ff00, outfit);
    expect(look().version).toBeGreaterThan(looks);
    expect([look().getX(0), look().getY(0), look().getZ(0)]).toEqual([
      0x112233, 0x445566, 0x778899,
    ]);
    // Someone else takes the instance with the same shirt: their own clothes, not the last person's.
    mesh.place(0, 1, 0, 0, 0, 0, 0, 1, 0x00ff00, null);
    expect(look().getX(0)).toBe(WALKER.shorts);
    mesh.dispose();
  });

  test('none drawn: nothing to render', () => {
    const { scene, mesh } = setup();
    mesh.finish(0, 0);
    expect(bodyOf(scene).visible).toBe(false);
    mesh.dispose();
  });

  test('its materials go with it', () => {
    const body = new MeshBasicMaterial();
    const xray = new MeshBasicMaterial();
    let disposed = 0;
    body.addEventListener('dispose', () => disposed++);
    xray.addEventListener('dispose', () => disposed++);
    createCrowdMesh({ scene: new Scene(), body, xray, ink: { value: 0 } }, 2).dispose();
    expect(disposed).toBe(2);
  });
});
