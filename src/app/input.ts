/**
 * Small, pure rules for the HUD's input. The React shell and the shortcuts wire them up.
 */

/**
 * A button that appears where another was just pressed (Walk, then Cancel and Start here under
 * it) would take the rest of a double-click or double-tap. Ignore the second click of a
 * multi-click and any pointer press in its first moments; keyboard presses (detail 0) always go.
 */
export const SETTLE_MS = 300;

export function strayPress(detail: number, sinceMount: number): boolean {
  return detail > 1 || (detail > 0 && sinceMount < SETTLE_MS);
}
