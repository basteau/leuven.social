/**
 * The marks someone drops on the map and keeps: a spot, an optional name and a colour from a
 * small set. Pure: the app stores them as JSON in localStorage and draws them on the map, the
 * minimap and the radar's rim.
 */

export const WAYPOINT_COLOURS = ['#d2553f', '#e8b94a', '#4a9a5c', '#4a77a8', '#8a5aa8'] as const;
export type WaypointColour = (typeof WAYPOINT_COLOURS)[number];

export interface Waypoint {
  id: string;
  x: number;
  z: number;
  name: string;
  colour: WaypointColour;
}

export const MAX_WAYPOINTS = 60;
export const NAME_MAX = 40;
export const WAYPOINTS_KEY = 'leuven-waypoints';

/** A new waypoint appended; a name is trimmed and cut, an empty one becomes "Mark n". */
export function addWaypoint(
  list: readonly Waypoint[],
  spot: { x: number; z: number; name?: string; colour?: WaypointColour },
  id: string,
): Waypoint[] {
  const name = (spot.name ?? '').trim().slice(0, NAME_MAX) || `Mark ${list.length + 1}`;
  const colour = spot.colour ?? WAYPOINT_COLOURS[list.length % WAYPOINT_COLOURS.length]!;
  const next = {
    id,
    x: Math.round(spot.x * 10) / 10,
    z: Math.round(spot.z * 10) / 10,
    name,
    colour,
  };
  return [...list, next].slice(-MAX_WAYPOINTS);
}

export const removeWaypoint = (list: readonly Waypoint[], id: string): Waypoint[] =>
  list.filter((w) => w.id !== id);

/** Waypoints back from stored JSON: anything malformed is dropped, never thrown on. */
export function parseWaypoints(json: string | null): Waypoint[] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: Waypoint[] = [];
  for (const w of raw as Record<string, unknown>[]) {
    if (
      w &&
      typeof w.id === 'string' &&
      typeof w.x === 'number' &&
      typeof w.z === 'number' &&
      Number.isFinite(w.x) &&
      Number.isFinite(w.z) &&
      typeof w.name === 'string' &&
      WAYPOINT_COLOURS.includes(w.colour as WaypointColour)
    ) {
      out.push({
        id: w.id,
        x: w.x,
        z: w.z,
        name: w.name.slice(0, NAME_MAX),
        colour: w.colour as WaypointColour,
      });
    }
  }
  return out.slice(0, MAX_WAYPOINTS);
}

/** Storage can throw (private windows, blocked site data): then marks last for the visit only. */
export function loadWaypoints(): Waypoint[] {
  try {
    return parseWaypoints(localStorage.getItem(WAYPOINTS_KEY));
  } catch {
    return [];
  }
}
export function saveWaypoints(list: readonly Waypoint[]): void {
  try {
    localStorage.setItem(WAYPOINTS_KEY, JSON.stringify(list));
  } catch {
    // Kept for this visit only: harmless.
  }
}

/** The waypoint nearest a spot within `reach` metres, or undefined. */
export function waypointNear(
  list: readonly Waypoint[],
  x: number,
  z: number,
  reach: number,
): Waypoint | undefined {
  let best: Waypoint | undefined;
  let nearest = reach;
  for (const w of list) {
    const d = Math.hypot(w.x - x, w.z - z);
    if (d <= nearest) [best, nearest] = [w, d];
  }
  return best;
}
