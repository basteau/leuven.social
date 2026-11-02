import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  ShapeUtils,
  Sphere,
  Vector2,
  Vector3,
} from 'three';

import type { Corner, Polygon, Terrain } from '../data/terrain.ts';

export type V3 = readonly [number, number, number];

/**
 * A lifted object's height reaches the shaders in this unit (m), in the spare fourth byte of
 * each normal (the `lift` attribute): the walls' windows count their storeys from it. Lift a
 * house by whole steps of it and they start exactly at its foot.
 */
export const LIFT_UNIT = 0.5;

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

/** Bytes of vertex and index data in a geometry, before its arrays are let go. */
export function geometryBytes(geometry: BufferGeometry): number {
  const buffers = new Set(
    Object.values(geometry.attributes).map((a) =>
      'isInterleavedBufferAttribute' in a ? a.data.array : a.array,
    ),
  );
  if (geometry.index) buffers.add(geometry.index.array);
  return [...buffers].reduce((sum, array) => sum + array.byteLength, 0);
}

/** Corners a geometry draws, three per triangle (two per line): the unit of its draw range. */
export function corners(geometry: BufferGeometry): number {
  return (geometry.index ?? geometry.getAttribute('position')).count;
}

/**
 * A builder's geometry with each triangle's (or segment's) corners written out in turn, as it
 * draws them: what tests and tools read triangle by triangle. Its bounds come along.
 */
export function unindexed(geometry: BufferGeometry): BufferGeometry {
  const soup = geometry.toNonIndexed();
  soup.boundingBox = geometry.boundingBox;
  soup.boundingSphere = geometry.boundingSphere;
  return soup;
}

/**
 * The smallest index array that holds `count` indices into `vertices` vertices. Index 65535 is
 * left out of 16-bit indices: WebGL 2 always reads it as a primitive restart.
 */
function indexAttribute(indices: Uint32Array, count: number, vertices: number): BufferAttribute {
  const array = vertices < 65535 ? new Uint16Array(count) : new Uint32Array(count);
  array.set(indices.subarray(0, count));
  return new BufferAttribute(array, 1).onUpload(release);
}

/** A growable index list. */
class Indices {
  array = new Uint32Array(1 << 15);
  count = 0;

  /** Adds two or three indices: a segment, or a triangle. */
  push(i: number, j: number, k = -1): void {
    if (this.count + 3 > this.array.length) {
      const next = new Uint32Array(this.array.length * 2);
      next.set(this.array);
      this.array = next;
    }
    const a = this.array;
    a[this.count++] = i;
    a[this.count++] = j;
    if (k >= 0) a[this.count++] = k;
  }
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
 * Accumulates flat-shaded, vertex-coloured triangles into one indexed geometry, so a whole layer
 * of the city is a single draw call. Each triangle takes an outward hint and is flipped to face
 * it, which keeps winding bugs out of every caller. Writes straight into growable typed arrays:
 * the city has ~2.5M vertices, and this runs inside the startup task.
 *
 * A vertex takes 24 bytes: its position as floats, its normal as signed bytes, its colour as the
 * palette's sRGB bytes (see `linearVertexColors`), and the `facade` float the shaders read. Flat
 * shading needs a vertex per face, so only corners within one flat face share a vertex: a quad's
 * four, a polygon's ring. Draw ranges count indices, three per triangle.
 */
export class MeshBuilder {
  /**
   * Where what's written next stands. With `drape`, flat ground follows the terrain: each
   * polygon is cut along the terrain's triangles (`Terrain.clip`) and every corner lifted by the
   * ground under it, and faces turned up keep an upward normal, so a slope is lit like level
   * ground and its pieces share their vertices. Otherwise everything is raised by `lift`: a
   * rigid thing, such as a house, standing at one height.
   */
  drape: Terrain | null = null;
  #lift = 0;
  /** The lift in LIFT_UNITs, as written into each normal's fourth byte. */
  #liftCode = 0;
  /** Whether the face being written is draped ground facing up, whose normal is straight up. */
  #up = false;
  #capacity = 1 << 14;
  #count = 0;
  #positions = new Float32Array(this.#capacity * 3);
  #normals = new Int8Array(this.#capacity * 4);
  #colors = new Uint8Array(this.#capacity * 4);
  #facades = new Float32Array(this.#capacity);
  #indices = new Indices();
  #color = 0;
  /** The normal of the face being written, as the bytes it's stored as. */
  #nx = 0;
  #ny = 0;
  #nz = 0;
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

  /** Indices so far, three per triangle: where a draw range starts or ends. */
  get indices(): number {
    return this.#indices.count;
  }

  get lift(): number {
    return this.#lift;
  }

  set lift(y: number) {
    this.#lift = y;
    this.foot = y;
  }

  /**
   * Where the facade shader counts storeys from (m), to the nearest LIFT_UNIT: `lift` sets it
   * too. A house stands at its exact ground but counts its storeys from that ground floored to
   * a LIFT_UNIT (`footing` in buildings.ts), so neighbours of nearly the same base keep the
   * same rows of windows. Set it after `lift`.
   */
  set foot(y: number) {
    this.#liftCode = Math.max(-128, Math.min(127, Math.round(y / LIFT_UNIT)));
  }

  /**
   * Makes the normal of the triangle a, b, c, turned to face `hint`, the face being written.
   * Returns -1 if its corners go in as a, c, b to face that way, 1 if as a, b, c, and 0 for a
   * triangle too thin to have a normal.
   */
  #face(a: V3, b: V3, c: V3, hint: V3): number {
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
    if (len < 1e-9) return 0;
    const flip = nx * hint[0] + ny * hint[1] + nz * hint[2] < 0 ? -1 : 1;
    if (this.#up) {
      [this.#nx, this.#ny, this.#nz] = [0, 127, 0];
      return flip;
    }
    nx = (nx / len) * flip;
    ny = (ny / len) * flip;
    nz = (nz / len) * flip;
    // Normalized int8 normals: exact enough for flat shading.
    this.#nx = Math.round(nx * 127);
    this.#ny = Math.round(ny * 127);
    this.#nz = Math.round(nz * 127);
    return flip;
  }

  /** Whether vertex `i` has the normal of the face being written. */
  #faces(i: number): boolean {
    const j = i * 4;
    const n = this.#normals;
    return n[j] === this.#nx && n[j + 1] === this.#ny && n[j + 2] === this.#nz;
  }

  /** Writes a vertex with the current face's normal and colour, and returns its index. */
  #vertex(v: V3, facade: number): number {
    if (this.#count === this.#capacity) this.#grow();
    const i = this.#count * 3;
    this.#positions[i] = v[0];
    this.#positions[i + 1] = v[1] + this.#lift;
    this.#positions[i + 2] = v[2];
    // As stored, so the bounds match what three would compute from the buffer.
    this.#bounds.add(this.#positions[i]!, this.#positions[i + 1]!, this.#positions[i + 2]!);
    const j = this.#count * 4;
    this.#normals[j] = this.#nx;
    this.#normals[j + 1] = this.#ny;
    this.#normals[j + 2] = this.#nz;
    this.#normals[j + 3] = this.#liftCode;
    const color = this.#color;
    this.#colors[j] = color >> 16;
    this.#colors[j + 1] = (color >> 8) & 255;
    this.#colors[j + 2] = color & 255;
    this.#facades[this.#count] = facade;
    return this.#count++;
  }

  /** Adds the triangle of vertices i, j, k, as i, k, j when `flip` says so. */
  #triangle(i: number, j: number, k: number, flip: number): void {
    if (flip < 0) this.#indices.push(i, k, j);
    else this.#indices.push(i, j, k);
  }

  /**
   * `facade` is the wall-top height the window shader reads, or on the ground a negative surface
   * or paint code (see paint.ts); paint gives each vertex its own.
   */
  triangle(a: V3, b: V3, c: V3, color: number, hint: V3, facade: number | V3 = 0): void {
    const [fa, fb, fc] = typeof facade === 'number' ? [facade, facade, facade] : facade;
    if (this.drape) {
      const ring = [
        [...a, fa],
        [...b, fb],
        [...c, fc],
      ];
      this.#drape(ring, color, hint, typeof facade === 'number' ? facade : undefined);
      return;
    }
    const flip = this.#face(a, b, c, hint);
    if (!flip) return;
    this.#color = color;
    this.#triangle(this.#vertex(a, fa), this.#vertex(b, fb), this.#vertex(c, fc), flip);
  }

  /**
   * Corners in order, drawn as the triangles a, b, c and a, c, d; `facade` as for `triangle`, or
   * one value per corner. Four vertices when both triangles get the same normal, as flat ones do.
   */
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
    if (this.drape) {
      const ring = [
        [...a, fa],
        [...b, fb],
        [...c, fc],
        [...d, fd],
      ];
      this.#drape(ring, color, hint, typeof facade === 'number' ? facade : undefined);
      return;
    }
    const first = this.#face(a, b, c, hint);
    const nx = this.#nx;
    const ny = this.#ny;
    const nz = this.#nz;
    const second = this.#face(a, c, d, hint);
    if (!first || !second || nx !== this.#nx || ny !== this.#ny || nz !== this.#nz) {
      this.triangle(a, b, c, color, hint, [fa, fb, fc]);
      this.triangle(a, c, d, color, hint, [fa, fc, fd]);
      return;
    }
    this.#color = color;
    const i = this.#vertex(a, fa);
    const j = this.#vertex(b, fb);
    const k = this.#vertex(c, fc);
    const l = this.#vertex(d, fd);
    this.#triangle(i, j, k, first);
    this.#triangle(i, k, l, second);
  }

  /**
   * A polygon, as the triangles `faces` lists by corner (as `ShapeUtils.triangulateShape` gives
   * them), each turned to face `hint`. Triangles share a corner's vertex where they get the same
   * normal: on a flat polygon, there's one vertex per corner. Draped, `points` must be a ring
   * lying flat, in order: each piece of it is triangulated again.
   */
  polygon(
    points: readonly V3[],
    faces: readonly (readonly number[])[],
    color: number,
    hint: V3,
    facade = 0,
  ): void {
    if (this.drape) {
      this.#drape(points, color, hint, facade, true);
      return;
    }
    this.#color = color;
    const written = new Int32Array(points.length).fill(-1);
    const vertex = (corner: number) => {
      let i = written[corner]!;
      if (i < 0 || !this.#faces(i)) written[corner] = i = this.#vertex(points[corner]!, facade);
      return i;
    };
    for (const [a, b, c] of faces) {
      const flip = this.#face(points[a!]!, points[b!]!, points[c!]!, hint);
      if (flip) this.#triangle(vertex(a!), vertex(b!), vertex(c!), flip);
    }
  }

  /**
   * A polygon (convex, or with `ring` any flat ring) draped on the terrain: cut along its
   * triangles, each corner lifted by the ground under it. With one `facade` for all of it, the
   * pieces are written as one polygon, so a cut point is one vertex wherever the normals agree;
   * otherwise each corner carries its own (the fourth value) and every piece is a fan.
   */
  #drape(polygon: Polygon, color: number, hint: V3, facade?: number, ring = false): void {
    const [terrain, lift] = [this.drape!, this.#lift];
    const onGround = (p: Corner): V3 => [p[0]!, p[1]! + terrain.height(p[0]!, p[2]!), p[2]!];
    [this.drape, this.lift] = [null, 0];
    this.#up = hint[0] === 0 && hint[2] === 0 && hint[1] > 0;
    const pieces = terrain.clip(polygon);
    if (facade === undefined) {
      for (const piece of pieces) {
        const [p, ...rest] = piece;
        for (let i = 0; i + 1 < rest.length; i++) {
          const [q, r] = [rest[i]!, rest[i + 1]!];
          this.triangle(onGround(p!), onGround(q), onGround(r), color, hint, [
            p![3]!,
            q[3]!,
            r[3]!,
          ]);
        }
      }
    } else {
      const index = new Map<string, number>();
      const points: V3[] = [];
      const faces: number[][] = [];
      for (const piece of pieces) {
        const ids = piece.map((p) => {
          const key = `${p[0]},${p[1]},${p[2]}`;
          let id = index.get(key);
          if (id === undefined) index.set(key, (id = points.push(onGround(p)) - 1));
          return id;
        });
        const triangles = ring
          ? ShapeUtils.triangulateShape(
              piece.map((p) => new Vector2(p[0], p[2])),
              [],
            )
          : ids.slice(2).map((_, i) => [0, i + 1, i + 2]);
        for (const [a, b, c] of triangles) faces.push([ids[a!]!, ids[b!]!, ids[c!]!]);
      }
      this.polygon(points, faces, color, hint, facade);
    }
    this.#up = false;
    [this.drape, this.lift] = [terrain, lift];
  }

  /**
   * `facade` adds the wall-top attribute the window shader reads, and the lift its storeys
   * count from; only buildings need them. The arrays are let go once uploaded, as only the GPU
   * needs them, unless `keep`: a mesh nothing rebuilds after a lost GPU context (the figure,
   * the spawn marker, the route hint) has to upload them again.
   */
  build({ facade = false, keep = false } = {}): BufferGeometry {
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
      // The normal's spare byte: no more memory, on the GPU or off it.
      geometry.setAttribute('lift', new InterleavedBufferAttribute(normal.data, 1, 3, false));
    }
    geometry.setIndex(indexAttribute(this.#indices.array, this.#indices.count, n));
    this.#bounds.applyTo(geometry);
    if (keep) {
      for (const a of [geometry.index!, ...Object.values(geometry.attributes)]) {
        ('data' in a ? a.data : a).onUploadCallback = () => {};
      }
    }
    return geometry;
  }
}

/**
 * Collects line segments (pairs of points) for an indexed outline geometry. Segments that meet
 * share their point: a hash of its position finds the one already written.
 */
export class LineBuilder {
  #points = new Float32Array(3 << 11);
  /** The same floats as bits, for the hash. */
  #bits = new Uint32Array(this.#points.buffer);
  #count = 0;
  #indices = new Indices();
  /** Open addressing, kept under half full: a point's index plus one, or 0 for an empty slot. */
  #slots = new Int32Array(1 << 13);
  #bounds = new Bounds();
  /** As for `MeshBuilder`: a line draped on the terrain, or lifted by one height. */
  drape: Terrain | null = null;
  lift = 0;

  /** Segments so far: a mark for drawing only part of the outlines (see `setDrawRange`). */
  get segments(): number {
    return this.#indices.count / 2;
  }

  /** Where the hash of point `i` starts looking. */
  #hash(i: number): number {
    const b = this.#bits;
    const h = Math.imul(
      b[i]! ^ Math.imul(b[i + 1]! ^ Math.imul(b[i + 2]!, 0x9e3779b1), 0x85ebca77),
      0xc2b2ae3d,
    );
    return (h ^ (h >>> 16)) & (this.#slots.length - 1);
  }

  /** The index of a point, written first at the end of the points if it's new. */
  #point(v: V3): number {
    if ((this.#count + 1) * 3 > this.#points.length) {
      const old = this.#points;
      this.#points = new Float32Array(old.length * 2);
      this.#points.set(old);
      this.#bits = new Uint32Array(this.#points.buffer);
    }
    const p = this.#points;
    const end = this.#count * 3;
    // Rounded to floats as stored, so equal points compare equal.
    p[end] = v[0];
    p[end + 1] = v[1] + this.lift;
    p[end + 2] = v[2];
    const x = p[end]!;
    const y = p[end + 1]!;
    const z = p[end + 2]!;
    const slots = this.#slots;
    const mask = slots.length - 1;
    for (let s = this.#hash(end); ; s = (s + 1) & mask) {
      const found = slots[s]! - 1;
      if (found < 0) {
        const added = this.#count++;
        slots[s] = added + 1;
        this.#bounds.add(x, y, z);
        if (this.#count * 2 > slots.length) this.#rehash();
        return added;
      }
      const i = found * 3;
      if (p[i] === x && p[i + 1] === y && p[i + 2] === z) return found;
    }
  }

  #rehash(): void {
    const slots = new Int32Array(this.#slots.length * 2);
    this.#slots = slots;
    const mask = slots.length - 1;
    for (let i = 0; i < this.#count; i++) {
      let s = this.#hash(i * 3);
      while (slots[s]) s = (s + 1) & mask;
      slots[s] = i + 1;
    }
  }

  segment(a: V3, b: V3): void {
    if (!this.drape) {
      const i = this.#point(a);
      this.#indices.push(i, this.#point(b));
      return;
    }
    const [terrain, lift] = [this.drape, this.lift];
    this.lift = 0;
    let last = -1;
    for (const p of terrain.cut(a, b)) {
      const i = this.#point([p[0]!, p[1]! + terrain.height(p[0]!, p[2]!), p[2]!]);
      if (last >= 0) this.#indices.push(last, i);
      last = i;
    }
    this.lift = lift;
  }

  build(): BufferGeometry {
    const geometry = new BufferGeometry();
    const points = new BufferAttribute(this.#points.slice(0, this.#count * 3), 3);
    geometry.setAttribute('position', points.onUpload(release));
    geometry.setIndex(indexAttribute(this.#indices.array, this.#indices.count, this.#count));
    this.#bounds.applyTo(geometry);
    return geometry;
  }
}
