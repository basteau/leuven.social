import { useEffect } from 'react';
import type { RefObject } from 'react';

import type { Viewer } from '../scene/viewer.ts';
import { idleRepeat, menuKey } from './input.ts';
import type { TurnHold } from './input.ts';

/**
 * Keys held to walk, by where they sit rather than what they type, so W A S D and Q E keep their
 * shape on AZERTY (Belgium's own layout) as on QWERTY. Walking keys are screen directions (right,
 * up); turning keys turn the map (left -1, right 1); Shift runs. The arrows do nothing: the map
 * pans by dragging, and one way to walk is easier to remember than two.
 */
const WALK_KEYS: Record<string, readonly [number, number]> = {
  KeyW: [0, 1],
  KeyS: [0, -1],
  KeyA: [-1, 0],
  KeyD: [1, 0],
};
const TURN_KEYS: Record<string, 1 | -1> = { KeyQ: -1, KeyE: 1 };
const RUN_KEYS = new Set(['ShiftLeft', 'ShiftRight']);

export interface ShortcutTarget {
  app: RefObject<HTMLElement | null>;
  viewer: RefObject<Viewer | null>;
  /** The Run toggle: on, Shift isn't needed. */
  running: RefObject<boolean>;
  /** A walking key went down: someone is walking with the keyboard. */
  onWalkKey: () => void;
  toggleSound: () => void;
  /** N: the minimap on or off. */
  toggleMinimap: () => void;
  /** T steps to the next time of day; P lets the day pass, or holds it. */
  nextTime: () => void;
  togglePassing: () => void;
  /** Q and E: a tap turns the map a quarter; held, they keep turning. */
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
 * The keyboard, one map of keys with no modes: + and - zoom, Q and E turn the map,
 * held W A S D walk the avatar (Shift runs), F takes or leaves a bike and B rings its bell, Space
 * (or Esc) brings the view back to the avatar, R turns north up and back to you, M mutes, N shows
 * or hides the minimap, and T and
 * P set the time of day. ⌘K and its kin open the menu. Shortcuts act while focus is anywhere in the app
 * except the menu, not in the rest of the page.
 */
export function useShortcuts(target: ShortcutTarget): void {
  useEffect(() => {
    const app = target.app.current;
    if (!app) return;
    const held = new Set<string>();
    const steer = () => {
      let [right, up] = [0, 0];
      for (const key of held) {
        const [r, u] = WALK_KEYS[key] ?? [0, 0];
        [right, up] = [right + r, up + u];
      }
      const viewer = target.viewer.current;
      viewer?.steer(Math.sign(right), Math.sign(up));
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
      const walking = Object.hasOwn(WALK_KEYS, code) || RUN_KEYS.has(code);
      if (walking) {
        target.onWalkKey();
        event.preventDefault();
        if (!held.has(code)) {
          held.add(code);
          steer();
        }
        return;
      }
      // Turning goes by position too, like walking; the rest are named for what they do (M mutes,
      // R resets), so they go by letter.
      // A held key's repeats are no new presses: the hold goes by its keydown and keyup, and only
      // zoom goes on while its key is held.
      if (idleRepeat(event)) return;
      const turn = TURN_KEYS[code];
      if (turn) {
        target.turnHold.press(code, turn, viewer);
        return;
      }
      const byCode: Record<string, () => void> = {
        // F gets on the nearest bike (or off it) and B rings its bell.
        KeyF: () => viewer.ride('toggle'),
        KeyB: () => viewer.ride('bell'),
      };
      // Space on a focused button or link presses that instead.
      const onControl = event.target instanceof Element && !!event.target.closest('button, a');
      const byKey: Record<string, () => void> = {
        '+': () => viewer.zoomBy(1.25),
        '=': () => viewer.zoomBy(1.25),
        '-': () => viewer.zoomBy(0.8),
        m: target.toggleSound,
        n: target.toggleMinimap,
        t: target.nextTime,
        p: target.togglePassing,
        r: () => viewer.resetView(),
        // Space brings the view back to you, as in games with a free camera; Escape too. Enter
        // goes into the building beside you, or out of it.
        ...(!onControl && { ' ': () => viewer.recentre(), enter: () => viewer.door() }),
        escape: () => viewer.recentre(),
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
