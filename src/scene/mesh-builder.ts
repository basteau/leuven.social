import { Box3, BufferAttribute, BufferGeometry, Color, Sphere, Vector3 } from 'three';

export type V3 = readonly [number, number, number];

/** Linear RGB of each palette colour, converted from sRGB once rather than per triangle. */
const linear = new Map<number, Color>();
function linearOf(hex: number): Color {
  let color = linear.get(hex);
  if (!color) linear.set(hex, (color = new Color().setHex(hex)));
  return color;
}

/**
 * Tracks the bounds of what a builder wrote, so its geometry gets them without another pass over
 * the vertices. The sphere is centred where three would centre it (the box's centre), which is
 * what the renderer sorts by; its radius is the box's, a little looser than three's.
 */
class Bounds {
  min = [Infinity, Infinity, Infinity];
  max = [-Infinity, -Infinity, -Infinity];

  add(x: number, y: number, z: number): void {
    const { min, max } = this;
    if (x < min[0]!) min[0] = x;
    if (x > max[0]!) max[0] = x;
    if (y < min[1]!) min[1] = y;
    if (y > max[1]!) max[1] = y;
    if (z < min[2]!) min[2] = z;
    if (z > max[2]!) max[2] = z;
  }

  applyTo(geometry: BufferGeometry): void {
    const box = new Box3(new Vector3(...this.min), new Vector3(...this.max));
    geometry.boundingBox = box;
    geometry.boundingSphere = box.isEmpty()
      ? new Sphere(new Vector3(), 0)
      : box.getBoundingSphere(new Sphere());
  }
}

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
  #color = linearOf(0);
  #bounds = new Bounds();

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

  /** Vertices so far: three per triangle. */
  get vertices(): number {
    return this.#count;
  }

  #vertex(v: V3, nx: number, ny: number, nz: number, facade: number): void {
    if (this.#count === this.#capacity) this.#grow();
    const i = this.#count * 3;
    this.#positions[i] = v[0];
    this.#positions[i + 1] = v[1];
    this.#positions[i + 2] = v[2];
    // As stored, so the bounds match what three would compute from the buffer.
    this.#bounds.add(this.#positions[i]!, this.#positions[i + 1]!, this.#positions[i + 2]!);
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

  triangle(a: V3, b: V3, c: V3, color: number, hint: V3, facade = 0): void {
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
    this.#color = linearOf(color);
    this.#vertex(a, nx, ny, nz, facade);
    this.#vertex(flip < 0 ? c : b, nx, ny, nz, facade);
    this.#vertex(flip < 0 ? b : c, nx, ny, nz, facade);
  }

  quad(a: V3, b: V3, c: V3, d: V3, color: number, hint: V3, facade = 0): void {
    this.triangle(a, b, c, color, hint, facade);
    this.triangle(a, c, d, color, hint, facade);
  }

  /** `facade` adds the wall-top attribute the window shader reads; only buildings need it. */
  build({ facade = false } = {}): BufferGeometry {
    const n = this.#count;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.#positions.slice(0, n * 3), 3));
    geometry.setAttribute('normal', new BufferAttribute(this.#normals.slice(0, n * 3), 3, true));
    geometry.setAttribute('color', new BufferAttribute(this.#colors.slice(0, n * 3), 3));
    if (facade) geometry.setAttribute('facade', new BufferAttribute(this.#facades.slice(0, n), 1));
    this.#bounds.applyTo(geometry);
    return geometry;
  }
}

/** Collects line segments (pairs of points) for an outline geometry. */
export class LineBuilder {
  #points = new Float32Array(6 << 10);
  #length = 0;
  #bounds = new Bounds();

  segment(a: V3, b: V3): void {
    if (this.#length + 6 > this.#points.length) {
      const next = new Float32Array(this.#points.length * 2);
      next.set(this.#points);
      this.#points = next;
    }
    const p = this.#points;
    const i = this.#length;
    p[i] = a[0];
    p[i + 1] = a[1];
    p[i + 2] = a[2];
    p[i + 3] = b[0];
    p[i + 4] = b[1];
    p[i + 5] = b[2];
    this.#length += 6;
    this.#bounds.add(p[i]!, p[i + 1]!, p[i + 2]!);
    this.#bounds.add(p[i + 3]!, p[i + 4]!, p[i + 5]!);
  }

  build(): BufferGeometry {
    const geometry = new BufferGeometry();
    const points = this.#points.slice(0, this.#length);
    geometry.setAttribute('position', new BufferAttribute(points, 3));
    this.#bounds.applyTo(geometry);
    return geometry;
  }
}
