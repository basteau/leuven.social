import { useEffect } from 'react';
import type { RefObject } from 'react';

import type { Viewer, WalkMode } from '../scene/viewer.ts';

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
const LOOK_KEYS: Record<string, number> = { KeyQ: -1, KeyE: 1 };
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
}

/**
 * The keyboard: arrows pan, + and - zoom, Q and E turn, R resets and W walks on the map; held
 * keys walk, run and look while walking. Shortcuts act while focus is anywhere in the app, not
 * in the rest of the page.
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
      if (!held.size) return;
      held.clear();
      steer();
    };
    const onKeyDown = (event: KeyboardEvent) => {
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
      // Enter on a focused button or link presses that instead.
      const onControl = event.target instanceof Element && !!event.target.closest('button, a');
      const actions: Record<string, () => void> = {
        q: () => viewer.rotate(-1),
        e: () => viewer.rotate(1),
        '+': () => viewer.zoomBy(1.25),
        '=': () => viewer.zoomBy(1.25),
        '-': () => viewer.zoomBy(0.8),
        ...(mode === 'map' && { r: () => viewer.resetView(), w: target.startWalk }),
        ...(mode === 'pick' && !onControl && { enter: () => viewer.walkFromCentre() }),
        ...(mode !== 'map' && { escape: () => viewer.stopWalking() }),
      };
      actions[key]?.();
    };
    // Releases are heard anywhere: focus may have left the app while a key was down.
    const onKeyUp = (event: KeyboardEvent) => {
      // macOS sends no keyup for keys released while ⌘ is down.
      if (event.key === 'Meta') release();
      else if (held.delete(event.code)) steer();
    };
    app.addEventListener('keydown', onKeyDown);
    globalThis.addEventListener('keyup', onKeyUp);
    // A key released while the window is in the background never sends its keyup.
    globalThis.addEventListener('blur', release);
    return () => {
      app.removeEventListener('keydown', onKeyDown);
      globalThis.removeEventListener('keyup', onKeyUp);
      globalThis.removeEventListener('blur', release);
    };
    // The target's members are refs and stable callbacks: bound once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
