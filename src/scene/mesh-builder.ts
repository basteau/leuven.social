import { BufferAttribute, BufferGeometry, Color } from 'three';

export type V3 = readonly [number, number, number];

/**
 * Accumulates flat-shaded, vertex-coloured triangles into one geometry, so a whole layer of
 * the city is a single draw call. Each triangle takes an outward hint and is flipped to face it,
 * which keeps winding bugs out of every caller. Writes straight into growable typed arrays:
 * the city has ~250k vertices, and this runs inside the startup task.
 */
export class MeshBuilder {
  #capacity = 1 << 14;
  #count = 0;
  #positions = new Float32Array(this.#capacity * 3);
  #normals = new Int8Array(this.#capacity * 3);
  #colors = new Float32Array(this.#capacity * 3);
  #facades = new Float32Array(this.#capacity);
  #color = new Color();

  #grow(): void {
    this.#capacity *= 2;
    const grow = <T extends Float32Array | Int8Array>(a: T, size: number): T => {
      const next = new (a.constructor as new (n: number) => T)(this.#capacity * size);
      next.set(a);
      return next;
    };
    this.#positions = grow(this.#positions, 3);
    this.#normals = grow(this.#normals, 3);
    this.#colors = grow(this.#colors, 3);
    this.#facades = grow(this.#facades, 1);
  }

  #vertex(v: V3, nx: number, ny: number, nz: number, facade: number): void {
    if (this.#count === this.#capacity) this.#grow();
    const i = this.#count * 3;
    this.#positions[i] = v[0];
    this.#positions[i + 1] = v[1];
    this.#positions[i + 2] = v[2];
    // Normalized int8 normals: a quarter of the memory, and exact enough for flat shading.
    this.#normals[i] = Math.round(nx * 127);
    this.#normals[i + 1] = Math.round(ny * 127);
    this.#normals[i + 2] = Math.round(nz * 127);
    this.#colors[i] = this.#color.r;
    this.#colors[i + 1] = this.#color.g;
    this.#colors[i + 2] = this.#color.b;
    this.#facades[this.#count] = facade;
    this.#count++;
  }

  /**
   * `facade` is the attribute the facade shader reads: one value for the whole triangle, or one
   * per corner (a, b, c) where it varies across the face.
   */
  triangle(a: V3, b: V3, c: V3, color: number, hint: V3, facade: number | V3 = 0): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    const flip = nx * hint[0] + ny * hint[1] + nz * hint[2] < 0 ? -1 : 1;
    nx = (nx / len) * flip;
    ny = (ny / len) * flip;
    nz = (nz / len) * flip;
    this.#color.setHex(color);
    const [fa, fb, fc] = typeof facade === 'number' ? [facade, facade, facade] : facade;
    this.#vertex(a, nx, ny, nz, fa);
    this.#vertex(flip < 0 ? c : b, nx, ny, nz, flip < 0 ? fc : fb);
    this.#vertex(flip < 0 ? b : c, nx, ny, nz, flip < 0 ? fb : fc);
  }

  quad(
    a: V3,
    b: V3,
    c: V3,
    d: V3,
    color: number,
    hint: V3,
    facade: number | readonly [number, number, number, number] = 0,
  ): void {
    const [fa, fb, fc, fd] = typeof facade === 'number' ? [facade, facade, facade, facade] : facade;
    this.triangle(a, b, c, color, hint, [fa, fb, fc]);
    this.triangle(a, c, d, color, hint, [fa, fc, fd]);
  }

  /** `facade` adds the wall-top attribute the window shader reads; only buildings need it. */
  build({ facade = false } = {}): BufferGeometry {
    const n = this.#count;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.#positions.slice(0, n * 3), 3));
    geometry.setAttribute('normal', new BufferAttribute(this.#normals.slice(0, n * 3), 3, true));
    geometry.setAttribute('color', new BufferAttribute(this.#colors.slice(0, n * 3), 3));
    if (facade) geometry.setAttribute('facade', new BufferAttribute(this.#facades.slice(0, n), 1));
    geometry.computeBoundingSphere();
    return geometry;
  }
}

/** Collects line segments (pairs of points) for an outline geometry. */
export class LineBuilder {
  #points: number[] = [];

  /** Segments so far: a mark for drawing only part of the outlines (see `setDrawRange`). */
  get segments(): number {
    return this.#points.length / 6;
  }

  segment(a: V3, b: V3): void {
    this.#points.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  }

  build(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.#points), 3));
    geometry.computeBoundingSphere();
    return geometry;
  }
}
