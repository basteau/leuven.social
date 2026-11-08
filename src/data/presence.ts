/**
 * Who is on the map: a list of positions, each flagged `self` for the one this browser controls.
 * The viewer publishes it, the minimap and the map draw from it, and the scene marks only the
 * `self` entry with its plumbob. Remote players (multiplayer) are further entries with
 * `self: false`: nothing else changes.
 */

export interface Presence {
  id: string;
  /** Local metres, as `City` has them: x east, z south. */
  x: number;
  z: number;
  /** Which way it faces, clockwise from north (radians). */
  heading: number;
  self: boolean;
}

/** The own player's entry, if it is in the list. */
export const selfOf = (list: readonly Presence[]): Presence | undefined => list.find((p) => p.self);

/** Only the own player is marked (the plumbob); everyone else is drawn plain. */
export const marked = (p: Presence): boolean => p.self;
