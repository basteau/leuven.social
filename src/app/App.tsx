import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { CITY_URL, loadCity } from '../data/load.ts';
import { CREDITS } from '../data/providers.ts';
import type { Viewer, WalkMode } from '../scene/viewer.ts';
import {
  CloseIcon,
  MapIcon,
  PinIcon,
  ResetIcon,
  RotateLeftIcon,
  RotateRightIcon,
  RunIcon,
  WalkIcon,
} from './icons.tsx';

type Status = { state: 'loading' } | { state: 'ready' } | { state: 'error'; message: string };

/** A stalled network must end in the retry state, never in an endless "Building Leuven…". */
const LOAD_TIMEOUT_MS = 20_000;

const CREDITS_VISIBLE_MS = 5_000;

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

const MAP_LABEL =
  'Map of Leuven’s centre around Grote Markt, Oude Markt and Ladeuzeplein. Drag or use the arrow keys to pan; scroll, pinch or press plus and minus to zoom; Q and E turn the view; W starts a walk.';
const MAP_LABELS: Record<WalkMode, string> = {
  map: MAP_LABEL,
  pick: 'Map of Leuven. Click or tap a street to start walking there, or press Enter to start in the middle of the view. Escape cancels.',
  walk: 'Walking in Leuven. W, A, S and D or the arrow keys walk, and hold Shift to run; drag to look around; click or tap a street to walk there; hold Q or E to turn the view; Escape returns to the map.',
};

/** Walk mode downloads on first use; say so only if that takes long enough to notice. */
const WALK_LOADING_MS = 250;

type WalkLoad = 'idle' | 'loading' | 'failed';

const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Publishes app state on <html> for CSS, the smoke test and anyone debugging. */
function publish(status: Status, viewer?: Viewer): void {
  const data = document.documentElement.dataset;
  data.state = status.state;
  if (viewer) {
    const { drawCalls, triangles } = viewer.stats();
    data.drawCalls = String(drawCalls);
    data.triangles = String(triangles);
  }
}

/** Hands the service worker everything this visit loaded, so the first visit already works offline. */
function cacheForOffline(): void {
  const urls = [
    location.pathname,
    ...performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((url) => url.startsWith(location.origin)),
  ];
  navigator.serviceWorker?.ready
    .then((registration) => registration.active?.postMessage({ type: 'cache', urls }))
    .catch(() => {});
}

export function App() {
  const appRef = useRef<HTMLElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const [status, setStatus] = useState<Status>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retryRef = useRef<HTMLButtonElement>(null);
  const [walkMode, setWalkMode] = useState<WalkMode>('map');
  const walkModeRef = useRef(walkMode);
  const [blocked, setBlocked] = useState(0);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(running);
  const [walkLoad, setWalkLoad] = useState<WalkLoad>('idle');
  const walkLoadTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Starts walk mode, saying it's getting ready if its download is slow. */
  const startWalkRef = useRef(() => {
    clearTimeout(walkLoadTimer.current);
    setWalkLoad('idle');
    walkLoadTimer.current = setTimeout(() => setWalkLoad('loading'), WALK_LOADING_MS);
    viewerRef.current?.pickWalkStart();
  });

  useEffect(() => {
    const map = mapRef.current;
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!map || !canvas || !overlay) return;
    const abort = new AbortController();
    setStatus({ state: 'loading' });
    publish({ state: 'loading' });

    // A retry skips any cached failure.
    const url = attempt === 0 ? CITY_URL : `${CITY_URL}?retry=${attempt}`;
    // The 3D engine is its own chunk: it downloads alongside the city while the HUD paints.
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(LOAD_TIMEOUT_MS)]);
    Promise.all([loadCity(url, signal), import('../scene/viewer.ts')])
      .then(([city, { createViewer }]) => {
        if (abort.signal.aborted) return;
        const viewer = createViewer({
          canvas,
          keyTarget: map,
          overlay,
          city,
          reducedMotion: reducedMotion() ?? false,
          onWalkModeChange: (mode) => {
            clearTimeout(walkLoadTimer.current);
            setWalkLoad('idle');
            walkModeRef.current = mode;
            setWalkMode(mode);
            setBlocked(0);
            // The buttons that started or ended the walk are gone: keep the keys working. The
            // browser shows the ring only if a key pressed that button.
            map.focus();
          },
          onWalkBlocked: () => setBlocked(performance.now()),
          onWalkUnavailable: () => {
            clearTimeout(walkLoadTimer.current);
            setWalkLoad('failed');
          },
        });
        viewerRef.current = viewer;
        // Keyboard users can pan and use shortcuts at once, without a focus ring flashing up.
        map.focus({ focusVisible: false } as FocusOptions);
        setStatus({ state: 'ready' });
        publish({ state: 'ready' }, viewer);
        cacheForOffline();
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        // People get a plain cause and a next step; the console keeps the technical detail.
        const message =
          error instanceof Error && error.message.includes('WebGL')
            ? 'This browser can’t show 3D right now. Turn on hardware acceleration and reload.'
            : 'Leuven couldn’t load. Check your connection and try again.';
        console.error(error);
        setStatus({ state: 'error', message });
        publish({ state: 'error', message });
      });

    return () => {
      abort.abort();
      viewerRef.current?.dispose();
      viewerRef.current = null;
    };
  }, [attempt]);

  useEffect(() => {
    if (status.state === 'error') retryRef.current?.focus();
  }, [status.state]);

  // Shortcuts work while focus is anywhere in the app, not in the rest of the page.
  useEffect(() => {
    const app = appRef.current;
    if (!app) return;
    const held = new Set<string>();
    const steer = () => {
      let [right, up, look] = [0, 0, 0];
      for (const key of held) {
        const [r, u] = WALK_KEYS[key] ?? [0, 0];
        [right, up, look] = [right + r, up + u, look + (LOOK_KEYS[key] ?? 0)];
      }
      const viewer = viewerRef.current;
      viewer?.steer(Math.sign(right), Math.sign(up));
      viewer?.look(Math.sign(look));
      viewer?.run(runningRef.current || [...held].some((code) => RUN_KEYS.has(code)));
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
      const viewer = viewerRef.current;
      if (!viewer) return;
      const key = event.key.toLowerCase();
      const { code } = event;
      const mode = walkModeRef.current;
      const walking =
        Object.hasOwn(WALK_KEYS, code) || Object.hasOwn(LOOK_KEYS, code) || RUN_KEYS.has(code);
      if (mode === 'walk' && walking) {
        setBlocked(0);
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
        ...(mode === 'map' && { r: () => viewer.resetView(), w: () => startWalkRef.current() }),
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
  }, []);

  const toggleRun = () => {
    runningRef.current = !runningRef.current;
    setRunning(runningRef.current);
    viewerRef.current?.run(runningRef.current);
  };

  // "Can't walk there" stays until the next try, so nobody misses it.
  useEffect(() => {
    const map = mapRef.current;
    if (!blocked || !map) return;
    const clear = () => setBlocked(0);
    map.addEventListener('pointerdown', clear, { once: true, passive: true });
    return () => map.removeEventListener('pointerdown', clear);
  }, [blocked]);

  const ready = status.state === 'ready';

  // OSM's attribution guidelines: show the credit at start, then it may collapse to a button
  // after five seconds or once the map is used.
  const [creditsOpen, setCreditsOpen] = useState(true);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const collapse = () => setCreditsOpen(false);
    const timer = setTimeout(collapse, CREDITS_VISIBLE_MS);
    const events = ['pointerdown', 'wheel', 'keydown'] as const;
    for (const type of events) map.addEventListener(type, collapse, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const type of events) map.removeEventListener(type, collapse);
    };
  }, [ready]);

  return (
    <main ref={appRef} className="app" data-walk={walkMode}>
      <div
        ref={mapRef}
        className="map"
        tabIndex={0}
        role="application"
        aria-roledescription="map"
        aria-label={MAP_LABELS[walkMode]}
      >
        <canvas ref={canvasRef} className="city" />
      </div>
      <div ref={overlayRef} className="overlay" aria-hidden="true" />
      {walkMode === 'pick' && <Reticle />}

      <header className="hud hud-top">
        <div className="panel brand">
          <h1>Leuven</h1>
        </div>
        <Credits open={creditsOpen} onToggle={() => setCreditsOpen((open) => !open)} />
      </header>

      {/* One region for loading and errors, so screen readers hear every change. */}
      <output className="panel notice" hidden={ready}>
        {status.state === 'error' ? (
          <>
            <span>{status.message}</span>
            <button
              ref={retryRef}
              type="button"
              className="button"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Try again
            </button>
          </>
        ) : (
          'Building Leuven…'
        )}
      </output>

      <footer className="hud hud-bottom">
        {/* Always rendered, empty on the map, so screen readers hear the hint change. */}
        <output className="panel hint">
          {walkMode === 'map' ? (
            walkLoad === 'loading' ? (
              'Getting ready to walk…'
            ) : walkLoad === 'failed' ? (
              'Walking couldn’t load. Check your connection and try again.'
            ) : null
          ) : blocked ? (
            'Can’t walk there. Pick a street or square.'
          ) : walkMode === 'pick' ? (
            'Pick a street to start walking.'
          ) : (
            <>
              <span className="hint-keys">
                W&nbsp;A&nbsp;S&nbsp;D to walk, hold Shift to run, drag to look. Click a street to
                go there.
              </span>
              <span className="hint-touch">
                Drag on the left to walk, on the right to look. Tap a street to go there.
              </span>
            </>
          )}
        </output>
        {walkMode === 'map' && (
          <div className="dock">
            <div className="panel toolbar">
              <ToolButton
                label="Walk"
                shortcut="W"
                disabled={!ready}
                busy={walkLoad === 'loading'}
                onPress={() => startWalkRef.current()}
                onWarm={() => viewerRef.current?.preloadWalk()}
              >
                <WalkIcon />
              </ToolButton>
            </div>
            <fieldset className="panel toolbar">
              <legend className="sr-only">View</legend>
              <ToolButton
                label="Turn left"
                shortcut="Q"
                disabled={!ready}
                onPress={() => viewerRef.current?.rotate(-1)}
              >
                <RotateLeftIcon />
              </ToolButton>
              <ToolButton
                label="Turn right"
                shortcut="E"
                disabled={!ready}
                onPress={() => viewerRef.current?.rotate(1)}
              >
                <RotateRightIcon />
              </ToolButton>
              <ToolButton
                label="Reset"
                shortcut="R"
                disabled={!ready}
                onPress={() => viewerRef.current?.resetView()}
              >
                <ResetIcon />
              </ToolButton>
            </fieldset>
          </div>
        )}
        {walkMode === 'pick' && (
          <fieldset className="panel toolbar">
            <legend className="sr-only">Start walking</legend>
            <ToolButton
              label="Start here"
              shortcut="↵"
              keys="Enter"
              disabled={!ready}
              onPress={() => viewerRef.current?.walkFromCentre()}
            >
              <PinIcon />
            </ToolButton>
            <ToolButton
              label="Cancel"
              shortcut="Esc"
              keys="Escape"
              disabled={!ready}
              onPress={() => viewerRef.current?.stopWalking()}
            >
              <CloseIcon />
            </ToolButton>
          </fieldset>
        )}
        {walkMode === 'walk' && (
          <fieldset className="panel toolbar">
            <legend className="sr-only">Walking</legend>
            <ToolButton
              label="Run"
              shortcut="Shift"
              hold
              pressed={running}
              disabled={!ready}
              onPress={toggleRun}
            >
              <RunIcon />
            </ToolButton>
            <ToolButton
              label="Turn left"
              shortcut="Q"
              disabled={!ready}
              onPress={() => viewerRef.current?.rotate(-1)}
            >
              <RotateLeftIcon />
            </ToolButton>
            <ToolButton
              label="Turn right"
              shortcut="E"
              disabled={!ready}
              onPress={() => viewerRef.current?.rotate(1)}
            >
              <RotateRightIcon />
            </ToolButton>
            {/* Last, away from where a left thumb steers. */}
            <ToolButton
              label="Map"
              shortcut="Esc"
              keys="Escape"
              disabled={!ready}
              onPress={() => viewerRef.current?.stopWalking()}
            >
              <MapIcon />
            </ToolButton>
          </fieldset>
        )}
      </footer>
    </main>
  );
}

function ToolButton(props: {
  label: string;
  /** The key as shown; `keys` names it for assistive tech when the two differ. */
  shortcut: string;
  keys?: string;
  /** For a toggle: whether it's on. */
  pressed?: boolean;
  /** The key is held for the same effect rather than pressed for this button: not its shortcut. */
  hold?: boolean;
  /** Its action is under way (walk mode downloading). */
  busy?: boolean;
  disabled: boolean;
  onPress: () => void;
  /** About to be pressed (hovered or focused): a chance to get ready. */
  onWarm?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="button"
      aria-keyshortcuts={props.hold ? undefined : (props.keys ?? props.shortcut)}
      aria-pressed={props.pressed}
      aria-busy={props.busy || undefined}
      disabled={props.disabled}
      onClick={props.onPress}
      onPointerEnter={props.onWarm}
      onFocus={props.onWarm}
    >
      {props.children}
      <span>{props.label}</span>
      <kbd aria-hidden="true">{props.shortcut}</kbd>
    </button>
  );
}

/** Marks the middle of the view, where "Start here" begins the walk. Decorative. */
function Reticle() {
  return (
    <svg className="reticle" width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
      <path className="reticle-halo" d="M16 3v9M16 20v9M3 16h9M20 16h9" />
      <path d="M16 3v9M16 20v9M3 16h9M20 16h9" />
    </svg>
  );
}

/**
 * Data credits required by the licences (ODbL, GRB), in the least space that stays legible.
 * They come from the source manifest, so a new provider can't ship uncredited.
 */
function Credits(props: { open: boolean; onToggle: () => void }) {
  return (
    <div className="credits">
      <p id="credits-text" hidden={!props.open}>
        {CREDITS.map((c) => (
          <a key={c.href} href={c.href}>
            {c.label}
          </a>
        ))}
      </p>
      <button
        type="button"
        className="credits-toggle"
        aria-expanded={props.open}
        aria-controls="credits-text"
        aria-label="Map data credits"
        onClick={props.onToggle}
      >
        ©
      </button>
    </div>
  );
}
