import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Sphere,
  Vector3,
} from 'three';

export type V3 = readonly [number, number, number];

/**
 * Patches a material's vertex shader for the colours `MeshBuilder` writes: sRGB bytes, as in the
 * palette, which the shader turns linear exactly as three's `Color.setHex` would. Every material
 * that draws a builder's geometry with `vertexColors` needs it.
 */
export function linearVertexColors(vertexShader: string): string {
  return vertexShader.replace(
    '#include <color_vertex>',
    `#include <color_vertex>
    #ifdef USE_COLOR
      vColor.rgb = mix(
        vColor.rgb * 0.0773993808,
        pow(vColor.rgb * 0.9478672986 + 0.0521327014, vec3(2.4)),
        vec3(greaterThan(vColor.rgb, vec3(0.04045)))
      );
    #endif`,
  );
}

/** Lets the garbage collector take an attribute's array once the GPU has its copy. */
function release(this: { array: unknown }): void {
  this.array = null;
}

/** Bytes of vertex data in a geometry, before its arrays are let go. */
export function geometryBytes(geometry: BufferGeometry): number {
  const buffers = new Set(
    Object.values(geometry.attributes).map((a) =>
      'isInterleavedBufferAttribute' in a ? a.data.array : a.array,
    ),
  );
  return [...buffers].reduce((sum, array) => sum + array.byteLength, 0);
}

/**
 * Three bytes padded to four: the GPU reads 4-byte aligned vertex data directly, where WebGL on
 * Metal (Safari, Chrome on a Mac) would otherwise convert the whole buffer first.
 */
export function padded(array: Int8Array | Uint8Array): InterleavedBufferAttribute {
  return new InterleavedBufferAttribute(new InterleavedBuffer(array, 4), 3, 0, true);
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
 * the city has ~2M vertices, and this runs inside the startup task.
 *
 * A vertex takes 24 bytes: its position as floats, its normal as signed bytes, its colour as the
 * palette's sRGB bytes (see `linearVertexColors`), and the `facade` float the shaders read.
 */
export class MeshBuilder {
  #capacity = 1 << 14;
  #count = 0;
  #positions = new Float32Array(this.#capacity * 3);
  #normals = new Int8Array(this.#capacity * 4);
  #colors = new Uint8Array(this.#capacity * 4);
  #facades = new Float32Array(this.#capacity);
  #color = 0;
  #bounds = new Bounds();

  #grow(): void {
    this.#capacity *= 2;
    const grow = <T extends Float32Array | Int8Array | Uint8Array>(a: T, size: number): T => {
      const next = new (a.constructor as new (n: number) => T)(this.#capacity * size);
      next.set(a);
      return next;
    };
    this.#positions = grow(this.#positions, 3);
    this.#normals = grow(this.#normals, 4);
    this.#colors = grow(this.#colors, 4);
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
    // Normalized int8 normals: exact enough for flat shading.
    const j = this.#count * 4;
    this.#normals[j] = Math.round(nx * 127);
    this.#normals[j + 1] = Math.round(ny * 127);
    this.#normals[j + 2] = Math.round(nz * 127);
    const color = this.#color;
    this.#colors[j] = color >> 16;
    this.#colors[j + 1] = (color >> 8) & 255;
    this.#colors[j + 2] = color & 255;
    this.#facades[this.#count] = facade;
    this.#count++;
  }

  /**
   * `facade` is the wall-top height the window shader reads, or on the ground a negative surface
   * or paint code (see paint.ts); paint gives each vertex its own.
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
    this.#color = color;
    const [fa, fb, fc] = typeof facade === 'number' ? [facade, facade, facade] : facade;
    this.#vertex(a, nx, ny, nz, fa);
    if (flip < 0) {
      this.#vertex(c, nx, ny, nz, fc);
      this.#vertex(b, nx, ny, nz, fb);
    } else {
      this.#vertex(b, nx, ny, nz, fb);
      this.#vertex(c, nx, ny, nz, fc);
    }
  }

  /** Corners in order; `facade` as for `triangle`, or one value per corner. */
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

  /**
   * `facade` adds the wall-top attribute the window shader reads; only buildings need it. The
   * arrays are let go once uploaded: after that only the GPU needs them.
   */
  build({ facade = false } = {}): BufferGeometry {
    const n = this.#count;
    const geometry = new BufferGeometry();
    const position = new BufferAttribute(this.#positions.slice(0, n * 3), 3);
    const normal = padded(this.#normals.slice(0, n * 4));
    const color = padded(this.#colors.slice(0, n * 4));
    geometry.setAttribute('position', position.onUpload(release));
    geometry.setAttribute('normal', normal);
    normal.data.onUpload(release);
    geometry.setAttribute('color', color);
    color.data.onUpload(release);
    if (facade) {
      const value = new BufferAttribute(this.#facades.slice(0, n), 1);
      geometry.setAttribute('facade', value.onUpload(release));
    }
    this.#bounds.applyTo(geometry);
    return geometry;
  }
}

/** Collects line segments (pairs of points) for an outline geometry. */
export class LineBuilder {
  #points = new Float32Array(6 << 10);
  #length = 0;
  #bounds = new Bounds();

  /** Segments so far: a mark for drawing only part of the outlines (see `setDrawRange`). */
  get segments(): number {
    return this.#length / 6;
  }

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
    const points = new BufferAttribute(this.#points.slice(0, this.#length), 3);
    geometry.setAttribute('position', points.onUpload(release));
    this.#bounds.applyTo(geometry);
    return geometry;
  }
}
