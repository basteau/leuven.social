import { useEffect } from 'react';
import type { RefObject } from 'react';

import type { Viewer, WalkMode } from '../scene/viewer.ts';
import { idleRepeat, menuKey } from './input.ts';
import type { TurnHold } from './input.ts';

/**
 * Keys held while walking, by where they sit rather than what they type, so W A S D and Q E
 * keep their shape on AZERTY (Belgium's own layout) as on QWERTY. Walking keys are screen
 * directions (right, up); turning keys turn the view (left -1, right 1); Shift runs.
 */
const WALK_KEYS: Record<string, readonly [number, number]> = {
  KeyW: [0, 1],
  ArrowUp: [0, 1],
  KeyS: [0, -1],
  ArrowDown: [0, -1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};
const LOOK_KEYS: Record<string, 1 | -1> = { KeyQ: -1, KeyE: 1 };
const RUN_KEYS = new Set(['ShiftLeft', 'ShiftRight']);

export interface ShortcutTarget {
  app: RefObject<HTMLElement | null>;
  viewer: RefObject<Viewer | null>;
  mode: RefObject<WalkMode>;
  /** The Run toggle: on, Shift isn't needed. */
  running: RefObject<boolean>;
  startWalk: () => void;
  /** A walking key went down: someone is walking with the keyboard. */
  onWalkKey: () => void;
  toggleSound: () => void;
  /** Q and E on the map: a tap turns a quarter; held, they keep turning. */
  turnHold: TurnHold;
  /** ⌘K, Ctrl+K, ⌘P, Ctrl+P and `/` open the menu at its list; `?` at the controls. */
  openMenu: (page: 'list' | 'help') => void;
  /** The menu is open or on its way: its keys aren't the map's. */
  menuOpen: RefObject<boolean>;
  /** Calls off a menu that is still on its way. */
  closeMenu: () => void;
  /** A character typed while the menu was on its way, for its search. */
  typeAhead: (key: string) => void;
}

/**
 * The keyboard: arrows pan, + and - zoom, Q and E turn, M mutes, R resets and W walks on the map
 * (Q, E and W by position, like walking's keys); held keys walk, run and look while walking, and
 * ride a bike after F (W pedals, S brakes, A and D steer, Shift sprints, B rings the bell).
 * ⌘K and its kin open the menu. Shortcuts act while focus is anywhere in the app except the
 * menu, not in the rest of the page.
 */
export function useShortcuts(target: ShortcutTarget): void {
  useEffect(() => {
    const app = target.app.current;
    if (!app) return;
    const held = new Set<string>();
    const steer = () => {
      let [right, up, look] = [0, 0, 0];
      for (const key of held) {
        const [r, u] = WALK_KEYS[key] ?? [0, 0];
        [right, up, look] = [right + r, up + u, look + (LOOK_KEYS[key] ?? 0)];
      }
      const viewer = target.viewer.current;
      viewer?.steer(Math.sign(right), Math.sign(up));
      viewer?.look(Math.sign(look));
      viewer?.run(target.running.current || [...held].some((code) => RUN_KEYS.has(code)));
    };
    const release = () => {
      target.turnHold.release();
      if (!held.size) return;
      held.clear();
      steer();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // The menu's own keys (its search, arrows, Escape) are the menu's.
      if (event.target instanceof Element && event.target.closest('dialog')) return;
      // From the moment it's asked for, too: a search typed before its code arrives goes into
      // its search, and mustn't walk or mute. Escape or the chord again calls it off, as they
      // would close it once it's open.
      if (target.menuOpen.current) {
        event.preventDefault();
        if (event.key === 'Escape' || menuKey(event) === 'chord') {
          if (!event.repeat) target.closeMenu();
          return;
        }
        const typed = event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
        if (typed) target.typeAhead(event.key);
        return;
      }
      const menu = menuKey(event);
      if (menu && target.viewer.current) {
        event.preventDefault(); // ⌘P would print
        if (event.repeat) return;
        release();
        target.openMenu(event.key === '?' ? 'help' : 'list');
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        release(); // a shortcut of the browser's own, not a step
        return;
      }
      const viewer = target.viewer.current;
      if (!viewer) return;
      const key = event.key.toLowerCase();
      const { code } = event;
      const mode = target.mode.current;
      const walking =
        Object.hasOwn(WALK_KEYS, code) || Object.hasOwn(LOOK_KEYS, code) || RUN_KEYS.has(code);
      if (mode === 'walk' && walking) {
        target.onWalkKey();
        event.preventDefault();
        if (!held.has(code)) {
          held.add(code);
          steer();
        }
        return;
      }
      // Turning and walking go by position here too, so a key does the same on the map as on
      // foot; the rest are named for what they do (M mutes, R resets), so they go by letter.
      // A held key's repeats are no new presses: the hold goes by its keydown and keyup, and only
      // zoom goes on while its key is held.
      if (idleRepeat(event)) return;
      const turn = LOOK_KEYS[code];
      if (turn) {
        target.turnHold.press(code, turn, viewer);
        return;
      }
      const byCode: Record<string, () => void> = {
        ...(mode === 'map' && { KeyW: target.startWalk }),
        // On foot, F gets on the nearest bike (or off it) and B rings its bell.
        ...(mode === 'walk' && {
          KeyF: () => viewer.ride('toggle'),
          KeyB: () => viewer.ride('bell'),
        }),
      };
      // Enter on a focused button or link presses that instead.
      const onControl = event.target instanceof Element && !!event.target.closest('button, a');
      const byKey: Record<string, () => void> = {
        '+': () => viewer.zoomBy(1.25),
        '=': () => viewer.zoomBy(1.25),
        '-': () => viewer.zoomBy(0.8),
        m: target.toggleSound,
        ...(mode !== 'walk' && { r: () => viewer.resetView() }),
        ...(mode === 'map' && !onControl && { enter: target.startWalk }),
        ...(mode !== 'map' && { escape: () => viewer.stopWalking() }),
      };
      (byCode[code] ?? byKey[key])?.();
    };
    // Releases are heard anywhere: focus may have left the app while a key was down.
    const onKeyUp = (event: KeyboardEvent) => {
      // macOS sends no keyup for keys released while ⌘ is down.
      if (event.key === 'Meta') release();
      else if (held.delete(event.code)) steer();
      else target.turnHold.release(event.code);
    };
    app.addEventListener('keydown', onKeyDown);
    globalThis.addEventListener('keyup', onKeyUp);
    // A key released while the window is in the background never sends its keyup.
    globalThis.addEventListener('blur', release);
    document.addEventListener('visibilitychange', release);
    return () => {
      document.removeEventListener('visibilitychange', release);
      app.removeEventListener('keydown', onKeyDown);
      globalThis.removeEventListener('keyup', onKeyUp);
      globalThis.removeEventListener('blur', release);
    };
    // The target's members are refs and stable callbacks: bound once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
