/**
 * The side (m) of the square cells that divide the city, for everything that works cell by cell:
 * the renderer's meshes (src/scene/cells.ts) and which players the server tells a client about
 * (src/net/interest.ts). Cell (i, j) spans [i, i + 1) × [j, j + 1) of these from the origin.
 */
export const CELL_SIZE = 350;
