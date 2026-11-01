/**
 * Small, pure rules for the HUD's input. The React shell and the shortcuts wire them up.
 */

/**
 * The keys that go by where they sit (`event.code`), not by what they type, so W A S D and Q E
 * keep their shape on AZERTY (Belgium's own layout). Shown with QWERTY's letters until the
 * keyboard says what they type.
 */
export const KEYCAPS = { KeyW: 'W', KeyA: 'A', KeyS: 'S', KeyD: 'D', KeyQ: 'Q', KeyE: 'E' };
export type Keycaps = typeof KEYCAPS;

/** The Keyboard API's layout map (Chromium only): what the key at each code types. */
export interface KeyboardLayout {
  getLayoutMap(): Promise<{ get(code: string): string | undefined }>;
}

/**
 * What the positional keys type on this keyboard, as keycaps: `Z Q S D` and `A E` on AZERTY.
 * Without the Keyboard API, or where it's refused (an iframe), QWERTY's letters.
 */
export async function layoutKeycaps(keyboard?: KeyboardLayout): Promise<Keycaps> {
  const caps = { ...KEYCAPS };
  try {
    const layout = await keyboard?.getLayoutMap();
    for (const code of Object.keys(caps) as (keyof Keycaps)[]) {
      const key = layout?.get(code)?.trim();
      if (key) caps[code] = key.toUpperCase();
    }
  } catch {
    // Not allowed here: the letters stay QWERTY's.
  }
  return caps;
}

/**
 * A button that appears where another was just pressed (Walk, then Cancel and Start here under
 * it) would take the rest of a double-click or double-tap. Ignore the second click of a
 * multi-click and any pointer press in its first moments; keyboard presses (detail 0) always go.
 */
export const SETTLE_MS = 300;

export function strayPress(detail: number, sinceMount: number): boolean {
  return detail > 1 || (detail > 0 && sinceMount < SETTLE_MS);
}
