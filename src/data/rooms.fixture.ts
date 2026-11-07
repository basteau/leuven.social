/** A small room for the room tests. */

import type { Room } from './rooms.ts';

/** A hall 20 m by 12 (x 0–20, z 0–12) with a door in its south wall and a gallery at its east end. */
export const HALL: Room = {
  oidn: 7,
  id: 'hall',
  name: 'The hall',
  door: { x: 10, z: 12, facing: Math.PI },
  floors: [
    {
      level: 0,
      name: 'Hall',
      y: 0,
      height: 5,
      slab: [0.5, 0.5, 19.5, 0.5, 19.5, 11.5, 0.5, 11.5],
      holes: [],
      walls: [
        { x0: 0.5, z0: 11.5, x1: 19.5, z1: 11.5, gaps: [[8.3, 10.7]] },
        { x0: 0.5, z0: 0.5, x1: 19.5, z1: 0.5, gaps: [] },
      ],
      props: [{ kind: 'pew', x: 6, z: 6, angle: -Math.PI / 2 }],
      // Up along +x, from x 11 to 17, at z 2.
      stairs: [{ to: 1, x: 14, z: 2, width: 1.6, depth: 6, angle: Math.PI / 2 }],
    },
    {
      level: 1,
      name: 'Gallery',
      y: 4,
      height: 3,
      slab: [14, 0.5, 19.5, 0.5, 19.5, 11.5, 14, 11.5],
      holes: [[14, 1.2, 17, 1.2, 17, 2.8, 14, 2.8]],
      walls: [{ x0: 14, z0: 0.5, x1: 14, z1: 11.5, gaps: [], height: 1 }],
      props: [{ kind: 'organ', x: 18.5, z: 6, angle: -Math.PI / 2 }],
      stairs: [],
    },
  ],
};
