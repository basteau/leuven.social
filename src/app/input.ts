/**
 * Small, pure rules for the app's input. The React shell and the shortcuts wire them up.
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

/** A key as pressed, with the modifiers held. */
interface Chord {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/**
 * Whether a key opens the menu: ⌘K or Ctrl+K, as in most apps that have one, ⌘P or Ctrl+P, as in
 * editors, and `/` or `?` on their own, as on sites with search and keyboard help. A chord also
 * closes it again; `/` and `?` are typed into its search instead.
 */
export function menuKey(event: Chord): 'chord' | 'key' | null {
  if (event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.metaKey || event.ctrlKey) return key === 'k' || key === 'p' ? 'chord' : null;
  return key === '/' || key === '?' ? 'key' : null;
}

/** The keys whose auto-repeat does something: zoom goes on while + or - is held. */
const REPEATING = /^[-+=]$/;

/**
 * Whether a keydown is a held key's auto-repeat that does nothing. Everything but zoom is one
 * press however long the key is held: held keys walk and turn by their keydown and keyup, and a
 * repeat mustn't press a toggle again (W walking straight back in after Esc, F getting off the
 * bike it just got on, M muting and unmuting).
 */
export function idleRepeat(event: { key: string; repeat: boolean }): boolean {
  return event.repeat && !REPEATING.test(event.key);
}

/** The menu's chord as this platform writes it: ⌘ on Apple's, Ctrl everywhere else. */
export function modKey(platform: string): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? '⌘' : 'Ctrl';
}

/**
 * A button that appears where something was just pressed (the Ride pill, under a tap on the map
 * by a bike) would take the rest of a double-click or double-tap. Ignore the second click of a
 * multi-click and any pointer press in its first moments; keyboard presses (detail 0) always go.
 */
export const SETTLE_MS = 300;

export function strayPress(detail: number, sinceMount: number): boolean {
  return detail > 1 || (detail > 0 && sinceMount < SETTLE_MS);
}

/**
 * A turn control or key held this long keeps turning; let go sooner, it was a tap: one step,
 * as ever. Just past the map's 280 ms quarter turn, so a tap's turn has landed first.
 */
export const HOLD_MS = 300;

export interface Turner {
  /** One step: a quarter of the way round. */
  rotate(direction: 1 | -1): void;
  /** Keeps turning while held: -1 left, 1 right, 0 lets go. */
  spin(direction: number): void;
}

export interface TurnHold {
  /** A turn control or key went down: a step at once, then turning on while it's held. */
  press(source: string, direction: 1 | -1, turner: Turner | null): void;
  /** That control or key came up (another's hold is left be); with none named, any let go. */
  release(source?: string): void;
}

/** Runs `then` after `ms`, and returns what cancels it. */
const after = (then: () => void, ms: number) => clearTimeout.bind(null, setTimeout(then, ms));

/**
 * Press and hold for the turn controls and keys. One hold at a time: a new press takes over, and
 * only what started a hold ends it, so a key let go doesn't stop a held button.
 */
export function createTurnHold(wait = after): TurnHold {
  let holder: string | undefined;
  let turner: Turner | null = null;
  let spinning = false;
  let cancel: (() => void) | undefined;
  const release = (source?: string) => {
    if (holder === undefined || (source !== undefined && source !== holder)) return;
    cancel?.();
    holder = undefined;
    if (spinning) turner?.spin(0);
    spinning = false;
  };
  return {
    press(source, direction, to) {
      release();
      [holder, turner] = [source, to];
      to?.rotate(direction);
      cancel = wait(() => {
        spinning = true;
        to?.spin(direction);
      }, HOLD_MS);
    },
    release,
  };
}
