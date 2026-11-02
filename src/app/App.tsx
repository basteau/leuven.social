import { useCallback, useEffect, useRef, useState } from 'react';

import { sound } from '../audio/sound.ts';
import { CITY_URL, loadCity } from '../data/load.ts';
import type { RideState, Viewer, WalkMode } from '../scene/viewer.ts';
import { ActionButton, RoundButton } from './controls.tsx';
import { Credits } from './credits.tsx';
import {
  BackIcon,
  BellIcon,
  BikeIcon,
  CompassIcon,
  GableIcon,
  MinusIcon,
  PinIcon,
  PlusIcon,
  RotateLeftIcon,
  RotateRightIcon,
  RunIcon,
  SoundIcon,
  WalkIcon,
} from './icons.tsx';
import { createTurnHold, KEYCAPS, layoutKeycaps, movesMap } from './input.ts';
import type { KeyboardLayout, Keycaps } from './input.ts';
import { useShortcuts } from './shortcuts.ts';
import { StreetSign } from './street-sign.tsx';

type Status = { state: 'loading' } | { state: 'ready' } | { state: 'error'; message: string };

/** A stalled network must end in the retry state, never in an endless "Building Leuven…". */
const LOAD_TIMEOUT_MS = 20_000;

const CREDITS_VISIBLE_MS = 5_000;

/** The map's description, naming the keys as this keyboard types them. */
const mapLabels = (k: Keycaps): Record<WalkMode, string> => ({
  map: `Map of Leuven’s centre around Grote Markt, Oude Markt and Ladeuzeplein. Drag or use the arrow keys to pan; scroll, pinch or press plus and minus to zoom; ${k.KeyQ} and ${k.KeyE} turn the view; ${k.KeyW} starts a walk.`,
  pick: 'Map of Leuven. Click or tap a street to start walking there, or press Enter to start in the middle of the view. Escape cancels.',
  walk: `Walking in Leuven. ${k.KeyW}, ${k.KeyA}, ${k.KeyS} and ${k.KeyD} or the arrow keys walk, and hold Shift to run; drag to look around; click or tap a street to walk there; hold ${k.KeyQ} or ${k.KeyE} to turn the view; F rides the nearest bike; Escape returns to the map.`,
});
/** Riding, the map says how. */
const rideLabel = (k: Keycaps) =>
  `Riding a bike in Leuven. ${k.KeyW} pedals, ${k.KeyS} brakes and backs up, ${k.KeyA} and ${k.KeyD} steer, Shift sprints, B rings the bell and F gets off; click or tap a street to ride there.`;

/** Walk mode downloads on first use; say so only if that takes long enough to notice. */
const WALK_LOADING_MS = 250;

/**
 * How to walk is shown on the first walk, until a few seconds after the first step, and then
 * not again on this device: the keys are on the buttons' tips, and the gestures are a game's.
 */
const COACHED_KEY = 'leuven-walk-coached';
const COACH_AFTER_STEP_MS = 4_000;
/** The first ride is coached for a few seconds, once per device. */
const RIDE_COACHED_KEY = 'leuven-ride-coached';
const RIDE_COACH_MS = 7_000;

type WalkLoad = 'idle' | 'loading' | 'failed';

const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Storage can throw (private windows, blocked site data); the coach then shows each time. */
function coached(key = COACHED_KEY): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function rememberCoached(key = COACHED_KEY): void {
  try {
    localStorage.setItem(key, '1');
  } catch {
    // Shown again next time: harmless.
  }
}

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
  // Turn buttons and, on the map, Q and E: a tap is a step; held, they keep turning.
  const [turnHold] = useState(createTurnHold);
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
  const [street, setStreet] = useState<string | null>(null);
  const [soundOn, setSoundOn] = useState(sound.on);
  /** Sound coming back is heard (rising); muting is silent. */
  const toggleSoundRef = useRef(() => {
    sound.setOn(!sound.on);
    setSoundOn(sound.on);
    sound.toggle(true);
  });
  useEffect(() => sound.attach(), []);
  const [coach, setCoach] = useState(() => !coached());
  const [ride, setRide] = useState<RideState>('');
  const [rideCoach, setRideCoach] = useState(() => !coached(RIDE_COACHED_KEY));
  const riding = ride === 'riding';
  useEffect(() => {
    if (!riding || !rideCoach) return;
    const timer = setTimeout(() => {
      setRideCoach(false);
      rememberCoached(RIDE_COACHED_KEY);
    }, RIDE_COACH_MS);
    return () => clearTimeout(timer);
  }, [riding, rideCoach]);
  // The shortcuts go by where keys sit; the hints say what those keys type here (Z Q S D on AZERTY).
  const [keys, setKeys] = useState(KEYCAPS);
  useEffect(() => {
    const { keyboard } = navigator as Navigator & { keyboard?: KeyboardLayout };
    void layoutKeycaps(keyboard).then(setKeys);
  }, []);
  const coachTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The compass turns with every frame of a rotation: written straight to its style, not state.
  const compassRef = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef(0);
  const turnCompass = useCallback((button: HTMLButtonElement | null) => {
    compassRef.current = button;
    button?.style.setProperty('--heading', `${-headingRef.current}rad`);
  }, []);

  /** Starts walk mode, saying it's getting ready if its download is slow. */
  const startWalkRef = useRef(() => {
    clearTimeout(walkLoadTimer.current);
    setWalkLoad('idle');
    walkLoadTimer.current = setTimeout(() => setWalkLoad('loading'), WALK_LOADING_MS);
    viewerRef.current?.pickWalkStart();
  });
  /** Someone took a first step: the coach has done its job, and goes after a moment. */
  const steppedRef = useRef(() => {
    setBlocked(0);
    if (coachTimer.current !== undefined) return;
    coachTimer.current = setTimeout(() => {
      setCoach(false);
      rememberCoached();
    }, COACH_AFTER_STEP_MS);
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
            turnHold.release(); // a held turn ends with the mode it began in
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
          onStreetChange: setStreet,
          onRideChange: setRide,
          onHeading: (heading) => {
            headingRef.current = heading;
            compassRef.current?.style.setProperty('--heading', `${-heading}rad`);
          },
        });
        viewerRef.current = viewer;
        return viewer.ready.then(() => {
          if (abort.signal.aborted) return;
          // Keyboard users can pan and use shortcuts at once, without a focus ring flashing up.
          map.focus({ focusVisible: false } as FocusOptions);
          setStatus({ state: 'ready' });
          publish({ state: 'ready' }, viewer);
          cacheForOffline();
        });
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
  }, [attempt, turnHold]);

  useEffect(() => {
    // Focus moved there for the person, not by a click: show where it went.
    if (status.state === 'error') retryRef.current?.focus({ focusVisible: true } as FocusOptions);
  }, [status.state]);

  useShortcuts({
    app: appRef,
    viewer: viewerRef,
    mode: walkModeRef,
    running: runningRef,
    startWalk: () => startWalkRef.current(),
    onWalkKey: () => steppedRef.current(),
    toggleSound: () => toggleSoundRef.current(),
    turnHold,
  });

  const toggleRun = () => {
    runningRef.current = !runningRef.current;
    setRunning(runningRef.current);
    viewerRef.current?.run(runningRef.current);
  };

  // "Can't walk there" stays until the next try, so nobody misses it. A touch while walking is a
  // step (the thumb stick), a look or a tap to go somewhere: the coach can go too.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || (!blocked && !(walkMode === 'walk' && coach))) return;
    const clear = () => {
      setBlocked(0);
      if (walkModeRef.current === 'walk') steppedRef.current();
    };
    map.addEventListener('pointerdown', clear, { once: true, passive: true });
    return () => map.removeEventListener('pointerdown', clear);
  }, [blocked, walkMode, coach]);

  const ready = status.state === 'ready';
  const viewer = () => viewerRef.current;

  // OSM's attribution guidelines: show the credit at start, then it may collapse to a button
  // after five seconds or once the map is used.
  const [creditsOpen, setCreditsOpen] = useState(true);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const collapse = () => setCreditsOpen(false);
    // Only keys that move the map: Tab must still reach the links.
    const onKey = (event: KeyboardEvent) => {
      if (movesMap(event)) collapse();
    };
    const timer = setTimeout(collapse, CREDITS_VISIBLE_MS);
    const events = ['pointerdown', 'wheel'] as const;
    for (const type of events) map.addEventListener(type, collapse, { passive: true });
    map.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      for (const type of events) map.removeEventListener(type, collapse);
      map.removeEventListener('keydown', onKey);
    };
  }, [ready]);

  // Starting a walk is using the map too, and the hint then needs the room under the credits.
  if (walkMode !== 'map' && creditsOpen) setCreditsOpen(false);

  const coaching = walkMode === 'walk' && coach && !blocked;

  return (
    <main ref={appRef} className="app" data-walk={walkMode}>
      <div
        ref={mapRef}
        className="map"
        tabIndex={0}
        role="application"
        aria-roledescription="map"
        aria-label={walkMode === 'walk' && riding ? rideLabel(keys) : mapLabels(keys)[walkMode]}
      >
        <canvas ref={canvasRef} className="city" />
      </div>
      <div ref={overlayRef} className="overlay" aria-hidden="true">
        {/* Where the left thumb walks, until it has. Touch screens only (CSS). */}
        {coaching && (
          <div className="stick-ghost">
            <span className="stick-knob" />
          </div>
        )}
      </div>
      {walkMode === 'pick' && <Reticle />}

      <header className="hud hud-top">
        {/*
          The top-start corner, one panel in every mode: a plate that says where you are (Leuven
          on the map, the street on foot), and the way back once there is one.
        */}
        <div className="corner panel">
          {walkMode !== 'map' && (
            <ActionButton
              label={walkMode === 'walk' ? 'Map' : 'Cancel'}
              shortcut="Esc"
              keys="Escape"
              quiet
              disabled={!ready}
              onPress={() => viewer()?.stopWalking()}
            >
              <BackIcon />
            </ActionButton>
          )}
          {walkMode === 'map' && (
            <h1 className="sign">
              <GableIcon />
              Leuven
            </h1>
          )}
          <StreetSign name={walkMode === 'walk' ? street : null} />
        </div>
        {/* The top-end corner: the credits, and Mute out of the way, in the very corner. */}
        <div className="corner-end">
          <Credits open={creditsOpen} onToggle={() => setCreditsOpen((open) => !open)} />
          <RoundButton
            label="Mute"
            shortcut="M"
            pressed={!soundOn}
            ownSound
            disabled={false}
            onPress={() => toggleSoundRef.current()}
          >
            <SoundIcon on={soundOn} />
          </RoundButton>
        </div>
        {/*
          The hint, under the corners, clear of the thumbs and the controls. Always in the page,
          empty when there's nothing to say, so changes are announced.
        */}
        <output className="panel hint">
          {blocked ? (
            'Can’t walk there. Pick a street or square.'
          ) : walkMode === 'map' ? (
            walkLoad === 'loading' ? (
              'Getting ready to walk…'
            ) : walkLoad === 'failed' ? (
              'Walking couldn’t load. Check your connection and try again.'
            ) : null
          ) : walkMode === 'pick' ? (
            <>
              <span className="hint-keys">
                Click a street to start there, or press <kbd>Enter</kbd> for the middle.
              </span>
              <span className="hint-touch">Tap a street, or move the map and tap Start here.</span>
            </>
          ) : riding && rideCoach ? (
            <>
              <span className="hint-keys">
                <kbd>{keys.KeyW}</kbd> pedals, <kbd>{keys.KeyS}</kbd> brakes, <kbd>{keys.KeyA}</kbd>{' '}
                <kbd>{keys.KeyD}</kbd> steer, <kbd>Shift</kbd> sprints. <kbd>F</kbd> gets off
                anywhere.
              </span>
              <span className="hint-touch">
                Left thumb rides where it points; push to the rim to sprint.
              </span>
            </>
          ) : coaching ? (
            <>
              <span className="hint-keys">
                <kbd>{keys.KeyW}</kbd> <kbd>{keys.KeyA}</kbd> <kbd>{keys.KeyS}</kbd>{' '}
                <kbd>{keys.KeyD}</kbd> walk, hold <kbd>Shift</kbd> to run, drag to look. Click a
                street to go there.
              </span>
              <span className="hint-touch">
                Left thumb walks, right thumb looks. Tap a street to go there.
              </span>
            </>
          ) : null}
        </output>
      </header>

      {/* One region for loading and errors, so screen readers hear every change. */}
      <output className="panel notice" hidden={ready}>
        {status.state === 'error' ? (
          <>
            <span>{status.message}</span>
            <button
              ref={retryRef}
              type="button"
              className="action"
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
        {/* The mode's one action, in the middle of the bottom edge. */}
        <div className="bar">
          {walkMode === 'map' && (
            <ActionButton
              label="Walk"
              shortcut={keys.KeyW}
              primary
              disabled={!ready}
              busy={walkLoad === 'loading'}
              onPress={() => startWalkRef.current()}
              onWarm={() => viewer()?.preloadWalk()}
            >
              <WalkIcon />
            </ActionButton>
          )}
          {walkMode === 'walk' && ride && (
            <ActionButton
              label={riding ? 'Get off' : 'Ride'}
              shortcut="F"
              primary={!riding}
              disabled={!ready}
              onPress={() => viewer()?.ride('toggle')}
            >
              <BikeIcon />
            </ActionButton>
          )}
          {walkMode === 'pick' && (
            <ActionButton
              label="Start here"
              shortcut="↵"
              keys="Enter"
              primary
              disabled={!ready}
              onPress={() => viewer()?.walkFromCentre()}
            >
              <PinIcon />
            </ActionButton>
          )}
        </div>

        {/*
          The view's controls at the end edge, in thumb reach, standing on the bottom edge so they
          stay put when a mode adds its own under them (Run on foot).
        */}
        <div className="rail">
          {walkMode !== 'walk' && (
            <RoundButton
              label="Reset view"
              shortcut="R"
              disabled={!ready}
              onPress={() => viewer()?.resetView()}
              ref={turnCompass}
            >
              <CompassIcon />
            </RoundButton>
          )}
          <fieldset className="stack">
            <legend className="sr-only">View</legend>
            <RoundButton
              label={walkMode === 'walk' ? 'Closer' : 'Zoom in'}
              shortcut="+"
              disabled={!ready}
              onPress={() => viewer()?.zoomBy(1.25)}
            >
              <PlusIcon />
            </RoundButton>
            <RoundButton
              label={walkMode === 'walk' ? 'Further' : 'Zoom out'}
              shortcut="-"
              disabled={!ready}
              onPress={() => viewer()?.zoomBy(0.8)}
            >
              <MinusIcon />
            </RoundButton>
            <RoundButton
              label="Turn left"
              shortcut={keys.KeyQ}
              disabled={!ready}
              onPress={() => turnHold.press('left', -1, viewer())}
              onRelease={() => turnHold.release('left')}
            >
              <RotateLeftIcon />
            </RoundButton>
            <RoundButton
              label="Turn right"
              shortcut={keys.KeyE}
              disabled={!ready}
              onPress={() => turnHold.press('right', 1, viewer())}
              onRelease={() => turnHold.release('right')}
            >
              <RotateRightIcon />
            </RoundButton>
          </fieldset>
          {walkMode === 'walk' && riding && (
            <RoundButton
              label="Bell"
              shortcut="B"
              ownSound
              disabled={!ready}
              onPress={() => viewer()?.ride('bell')}
            >
              <BellIcon />
            </RoundButton>
          )}
          {walkMode === 'walk' && (
            <RoundButton
              label={riding ? 'Sprint' : 'Run'}
              shortcut="Shift"
              hold
              big
              pressed={running}
              disabled={!ready}
              onPress={toggleRun}
            >
              <RunIcon />
            </RoundButton>
          )}
        </div>
      </footer>
    </main>
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
