import { LineSegments, Mesh } from 'three';
import type { Material, Scene } from 'three';

import type { City } from '../data/city.ts';
import { inRing, ringBox, ringDistance } from '../data/cell-grid.ts';
import { RoomGrid } from '../data/room-grid.ts';
import { Router } from '../data/route.ts';
import { ROOMS_FILE, RoomLoadError, ceiling, parseRooms, standing } from '../data/rooms.ts';
import type { Room } from '../data/rooms.ts';
import { LineBuilder, MeshBuilder } from './mesh-builder.ts';
import { addLining, addUnderfloor, buildDoor, buildFloor } from './room-mesh.ts';

/**
 * The rooms in the scene: rooms.json fetched, each room's floors built as meshes in the city's
 * material and ink (the ground floor with the building's own walls, cut down to the room's
 * ceiling, in its draw call), its grids and routes per floor, and a door on the street. A chunk
 * of its own, loaded when the avatar comes near a landmark. Same world space as the street: no
 * second scene, no teleport.
 */

/** What the rooms take from the engine. */
export interface InteriorsKit {
  scene: Scene;
  /** The city's material and ink: rooms are lit, shadowed, dithered and inked like the city. */
  material: Material;
  ink: Material;
  city: Pick<City, 'buildings'>;
  /** The ground as drawn at a spot (m). */
  groundAt(x: number, z: number): number;
  /** Writes a landmark's walls, cut down to `top`, into a room's builders. */
  openWalls(id: number, top: number, mesh: MeshBuilder, lines: LineBuilder): boolean;
  /** What casts shadows changed. */
  shadowsChanged(): void;
}

/** A floor drawn: its mesh and ink, two draw calls. */
interface Drawn {
  level: number;
  objects: [Mesh, LineSegments];
}

export interface Interiors {
  readonly rooms: readonly Room[];
  byId(id: string): Room | undefined;
  /** The building a room is in: its footprint. */
  footprint(room: Room): ArrayLike<number>;
  /** The room whose footprint holds (x, z), if any. */
  roomAt(x: number, z: number): Room | undefined;
  /** The room whose building stands within `reach` of (x, z), or round it, if any. */
  beside(x: number, z: number, reach: number): Room | undefined;
  /** A floor's walk grid and its router, built the first time they are asked for. */
  grid(room: Room, level: number): RoomGrid;
  router(room: Room, level: number): Router;
  /**
   * Where the avatar stands at (x, z) on floor `level`: the floor it counts as and the height of
   * its feet (m, in the street's frame), up the ramp of a stair or over the door's threshold.
   */
  standing(room: Room, level: number, x: number, z: number): { level: number; y: number };
  /** Where a room's floor is (m): its foot, over the highest ground drawn under it. */
  foot(room: Room): number;
  /** How high its walls stand once it is open (m, in the street's frame). */
  top(room: Room): number;
  /** Builds a room's floors ahead of a visit, if they aren't yet. */
  prewarm(room: Room): void;
  /** Shows the floors of `room` up to `level`, and every other room's door; null: only doors. */
  show(room: Room | null, level: number): void;
  dispose(): void;
}

/** How finely the ground under a room is sampled for its floor's height (m). */
const SAMPLE = 3;
/** The threshold: the floor rises from the street's to the room's over this far in (m). */
const RAMP = 2;

const smooth = (t: number) => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

/** Fetches rooms.json and builds what the rooms need; a failure is a `RoomLoadError`. */
export async function loadInteriors(kit: InteriorsKit, base: string): Promise<Interiors> {
  let rooms: Room[];
  try {
    const response = await fetch(`${base}${ROOMS_FILE}`);
    if (!response.ok) throw new Error(`rooms.json: HTTP ${response.status}`);
    rooms = parseRooms(await response.json());
  } catch (error) {
    throw error instanceof RoomLoadError ? error : new RoomLoadError(error);
  }
  return createInteriors(kit, rooms);
}

export function createInteriors(kit: InteriorsKit, rooms: Room[]): Interiors {
  const { scene } = kit;
  const rings = new Map(
    rooms.map((r) => [r, kit.city.buildings.find((b) => b.id === r.oidn)?.ring ?? []]),
  );
  const feet = new Map<Room, number>();
  const foot = (room: Room) => {
    let y = feet.get(room);
    if (y === undefined) {
      // Level: over the highest ground drawn under its slab, so the street never shows through.
      // The ground is no plane under a church: sampled every few metres over the slab as well as
      // at its corners, since the top of a slope may lie inside it.
      const slab = room.floors.find((f) => f.level === 0)?.slab ?? [];
      y = -Infinity;
      for (let i = 0; i < slab.length; i += 2)
        y = Math.max(y, kit.groundAt(slab[i]!, slab[i + 1]!));
      const box = ringBox(slab);
      for (let x = box.minX; x <= box.maxX; x += SAMPLE) {
        for (let z = box.minZ; z <= box.maxZ; z += SAMPLE) {
          if (inRing(slab, x, z)) y = Math.max(y, kit.groundAt(x, z));
        }
      }
      feet.set(room, (y = Math.max(y, kit.groundAt(room.door.x, room.door.z)) + 0.03));
    }
    return y;
  };
  const top = (room: Room) => foot(room) + ceiling(room);

  const grids = new Map<string, RoomGrid>();
  const routers = new Map<string, Router>();
  const grid = (room: Room, level: number) => {
    const k = `${room.id} ${level}`;
    let g = grids.get(k);
    if (!g) grids.set(k, (g = new RoomGrid(room, level)));
    return g;
  };

  // Each room's door on the street, shown while nobody is inside it.
  const doors = new Map(
    rooms.map((room) => {
      const mesh = new Mesh(
        buildDoor(room, kit.groundAt(room.door.x, room.door.z)).build({ keep: true }),
        kit.material,
      );
      mesh.receiveShadow = true;
      scene.add(mesh);
      return [room, mesh];
    }),
  );

  const drawn = new Map<Room, Drawn[]>();
  /** The room whose floors show, if any. */
  let showing: Room | null = null;
  function discard(room: Room): void {
    for (const { objects } of drawn.get(room) ?? []) {
      for (const o of objects) {
        scene.remove(o);
        o.geometry.dispose();
      }
    }
    drawn.delete(room);
  }
  function prewarm(room: Room): Drawn[] {
    let floors = drawn.get(room);
    if (floors) return floors;
    // One room built ahead at a time, besides the one shown: what is held stays bounded.
    for (const other of drawn.keys()) if (other !== showing) discard(other);
    floors = room.floors.map((floor) => {
      const mesh = new MeshBuilder();
      const lines = new LineBuilder();
      // The ground floor stands inside the building's walls, cut to the room's ceiling.
      if (floor.level === 0) {
        kit.openWalls(room.oidn, top(room), mesh, lines);
        addUnderfloor(mesh, rings.get(room) ?? [], foot(room));
        addLining(mesh, rings.get(room) ?? [], foot(room), top(room));
      }
      buildFloor(room, floor, foot(room), mesh, lines);
      const surfaces = new Mesh(mesh.build({ facade: true, keep: true }), kit.material);
      surfaces.receiveShadow = surfaces.castShadow = true;
      // The view's and the shadow's layers both.
      surfaces.layers.enable(1);
      const ink = new LineSegments(lines.build({ keep: true }), kit.ink);
      for (const o of [surfaces, ink]) o.visible = false;
      scene.add(surfaces, ink);
      return { level: floor.level, objects: [surfaces, ink] };
    });
    drawn.set(room, floors);
    return floors;
  }

  return {
    rooms,
    byId: (id) => rooms.find((r) => r.id === id),
    footprint: (room) => rings.get(room) ?? [],
    roomAt: (x, z) => rooms.find((r) => inRing(rings.get(r) ?? [], x, z)),
    beside: (x, z, reach) =>
      rooms.find((r) => {
        const ring = rings.get(r) ?? [];
        return ring.length > 0 && (inRing(ring, x, z) || ringDistance(ring, x, z) <= reach);
      }),
    grid,
    router(room, level) {
      const k = `${room.id} ${level}`;
      let r = routers.get(k);
      if (!r) routers.set(k, (r = new Router(grid(room, level))));
      return r;
    },
    standing(room, level, x, z) {
      const at = standing(room, level, x, z);
      let y = foot(room) + at.y;
      if (at.level === 0 && at.y === 0) {
        // Over the threshold the floor eases up (or down) from the street's.
        const { door } = room;
        const into = (x - door.x) * Math.sin(door.facing) + (z - door.z) * Math.cos(door.facing);
        const street = kit.groundAt(door.x, door.z);
        y = street + (y - street) * smooth(into / RAMP);
      }
      return { level: at.level, y };
    },
    foot,
    top,
    prewarm: (room) => void prewarm(room),
    show(room, level) {
      showing = room;
      for (const [r, door] of doors) door.visible = r !== room;
      for (const [r, floors] of drawn) {
        for (const f of floors) {
          const on = r === room && f.level <= level;
          for (const o of f.objects) o.visible = on;
        }
      }
      if (room)
        for (const f of prewarm(room)) for (const o of f.objects) o.visible = f.level <= level;
      kit.shadowsChanged();
    },
    dispose() {
      for (const door of doors.values()) {
        scene.remove(door);
        door.geometry.dispose();
      }
      for (const room of drawn.keys()) discard(room);
    },
  };
}
