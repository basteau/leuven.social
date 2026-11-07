/**
 * A press that moves less than TAP_SLOP (px) and lifts within TAP_MS is a tap or a click, not a
 * drag: it sends the avatar there. The viewer's one tap test, beside the map controls' pan, pinch
 * and wheel, so a pan is never a tap.
 */
export const TAP_SLOP = 8;
export const TAP_MS = 600;

export const isTap = (dx: number, dy: number, ms: number) =>
  Math.hypot(dx, dy) < TAP_SLOP && ms < TAP_MS;
