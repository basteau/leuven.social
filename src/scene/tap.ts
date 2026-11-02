/**
 * A press that moves less than TAP_SLOP (px) and lifts within TAP_MS is a tap or a click, not a
 * drag: on the map it starts a walk, on foot it walks somewhere. Shared by the viewer (the map's
 * first load) and walk mode, so both tell a tap from a pan the same way.
 */
export const TAP_SLOP = 8;
export const TAP_MS = 600;

export const isTap = (dx: number, dy: number, ms: number) =>
  Math.hypot(dx, dy) < TAP_SLOP && ms < TAP_MS;
