import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { sound } from '../audio/sound.ts';
import type { City } from '../data/city.ts';
import { CITY_URL, loadCity } from '../data/load.ts';
import type { Place } from '../data/places.ts';
import type { RideState, Viewer, WalkMode } from '../scene/viewer.ts';
import type { ActionId, CommandState } from './commands.ts';
import type { MenuPage } from './command-menu.tsx';
import { ActionButton } from './controls.tsx';
import { Credits } from './credits.tsx';
import { BikeIcon, MenuIcon } from './icons.tsx';
import { createTurnHold, KEYCAPS, layoutKeycaps, modKey } from './input.ts';
import type { KeyboardLayout, Keycaps } from './input.ts';
import { introErrorSlot, removeIntro, showKeys, showStep } from './intro.ts';
import { loadStep } from './loading.ts';
import type { LoadState } from './loading.ts';
import { useShortcuts } from './shortcuts.ts';
import { StreetSign } from './street-sign.tsx';

type Status = { state: 'loading' } | { state: 'ready' } | { state: 'error'; message: string };

/** A stalled network must end in the retry state, never in an endless loading screen. */
const LOAD_TIMEOUT_MS = 20_000;

/** The menu is its own chunk: fetched once the map is up, or as someone reaches for it. */
const loadMenu = () => import('./command-menu.tsx');
const CommandMenu = lazy(() => loadMenu().then((m) => ({ default: m.CommandMenu })));

/** The map's description, naming the keys as this keyboard types them. */
const mapLabels = (k: Keycaps, mod: string): Record<WalkMode, string> => ({
  map: `Map of Leuven’s centre around Grote Markt, Oude Markt and Ladeuzeplein. Drag or use the arrow keys to pan; scroll, pinch or press plus and minus to zoom; ${k.KeyQ} and ${k.KeyE} turn the view; click or tap a street to start walking there, or press ${k.KeyW} to start in the middle of the view. ${mod} K or slash opens the menu, with every command and key.`,
  walk: `Walking in Leuven. ${k.KeyW}, ${k.KeyA}, ${k.KeyS} and ${k.KeyD} or the arrow keys walk, and hold Shift to run; drag to look around; click or tap a street to walk there; hold ${k.KeyQ} or ${k.KeyE} to turn the view; F rides the nearest bike; Escape returns to the map.`,
});
/** Riding, the map says how. */
const rideLabel = (k: Keycaps) =>
  `Riding a bike in Leuven. ${k.KeyW} pedals, ${k.KeyS} brakes and backs up, ${k.KeyA} and ${k.KeyD} steer, Shift sprints, B rings the bell and F gets off; click or tap a street to ride there.`;

/** Walk mode downloads on first use; say so only if that takes long enough to notice. */
const WALK_LOADING_MS = 250;

/**
 * How to walk is shown on the first walk, until a few seconds after the first step, and then
 * not again on this device: the keys are in the menu, and the gestures are a game's.
 */
const COACHED_KEY = 'leuven-walk-coached';
const COACH_AFTER_STEP_MS = 4_000;
/** The first ride is coached for a few seconds, once per device. */
const RIDE_COACHED_KEY = 'leuven-ride-coached';
const RIDE_COACH_MS = 7_000;
/** What a command did, where nothing else on screen shows it (sound, running), for a moment. */
const SAID_MS = 2_000;

type WalkLoad = 'idle' | 'loading' | 'failed';

const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** The platform, for the menu's chord: ⌘ on Apple's, Ctrl elsewhere. */
const platform = () =>
  (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform ??
  navigator.platform;

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
  // Q and E on the map: a tap is a step; held, they keep turning.
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
  const [said, setSaid] = useState<{ text: string; at: number } | null>(null);
  const say = useCallback((text: string) => setSaid({ text, at: performance.now() }), []);
  useEffect(() => {
    if (!said) return;
    const timer = setTimeout(() => setSaid(null), SAID_MS);
    return () => clearTimeout(timer);
  }, [said]);
  /** Sound coming back is heard (rising); muting is silent, and says so. */
  const toggleSoundRef = useRef(() => {
    sound.setOn(!sound.on);
    setSoundOn(sound.on);
    sound.toggle(true);
    say(sound.on ? 'Sound on' : 'Sound off');
  });
  useEffect(() => sound.attach(), []);
  const [coach, setCoach] = useState(() => !coached());
  const [ride, setRide] = useState<RideState>('');
  const rideRef = useRef(ride);
  /** The city, for finding places by name, once it's on screen. */
  const [placeCity, setPlaceCity] = useState<City | null>(null);
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
  const [mod] = useState(() => modKey(platform()));
  useEffect(() => {
    const { keyboard } = navigator as Navigator & { keyboard?: KeyboardLayout };
    showKeys(KEYCAPS, mod);
    void layoutKeycaps(keyboard).then((caps) => {
      setKeys(caps);
      showKeys(caps, mod);
    });
  }, [mod]);
  const coachTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // The menu: shut until asked for, and in the page (closed) once its chunk has come, while the
  // city is built, so it opens at once. While it's open, or on its way, the map's shortcuts
  // stand down, so a search typed early can't walk or mute.
  const [menu, setMenu] = useState<{ open: boolean; page: MenuPage; used: boolean }>({
    open: false,
    page: 'list',
    used: false,
  });
  const menuOpenRef = useRef(false);
  /** What was typed while the menu was on its way, for its search. */
  const typedRef = useRef('');
  const openMenu = useCallback((page: MenuPage = 'list') => {
    menuOpenRef.current = true;
    typedRef.current = '';
    setMenu({ open: true, page, used: true });
  }, []);
  const closeMenu = useCallback(() => {
    menuOpenRef.current = false;
    setMenu((m) => ({ ...m, open: false }));
  }, []);
  // Closed, however it closed, the menu gives focus to the map, not back to its button (where the
  // dialog would put it), so the arrows pan and Enter walks at once.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !menu.open) {
      mapRef.current?.focus({ focusVisible: false } as FocusOptions);
    }
    wasOpen.current = menu.open;
  }, [menu.open]);
  const takeTyped = useCallback(() => {
    const typed = typedRef.current;
    typedRef.current = '';
    return typed;
  }, []);

  /** Starts walk mode, saying it's getting ready if its download is slow. */
  const startWalkRef = useRef(() => {
    clearTimeout(walkLoadTimer.current);
    setWalkLoad('idle');
    walkLoadTimer.current = setTimeout(() => setWalkLoad('loading'), WALK_LOADING_MS);
    viewerRef.current?.walkFromCentre();
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

    // Every step the loading screen reports is one this waits on.
    const progress: LoadState = { received: 0, total: 0, engine: false, built: false };
    const report = () => {
      if (!abort.signal.aborted) showStep(loadStep(progress));
    };
    report();

    // A retry skips any cached failure.
    const url = attempt === 0 ? CITY_URL : `${CITY_URL}?retry=${attempt}`;
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(LOAD_TIMEOUT_MS)]);
    const city = loadCity(url, signal, (received, total) => {
      [progress.received, progress.total] = [received, total];
      report();
    }).then((loaded) => {
      progress.buildings = loaded.buildings.length;
      report();
      // The network is free while the city is built: the menu's chunk comes now, not later.
      loadMenu()
        .then(() => setMenu((m) => ({ ...m, used: true })))
        .catch(() => {});
      return loaded;
    });
    // The 3D engine is its own chunk: it downloads alongside the city.
    const engine = import('../scene/viewer.ts').then((module) => {
      progress.engine = true;
      report();
      return module;
    });
    Promise.all([city, engine])
      .then(([loaded, { createViewer }]) => {
        if (abort.signal.aborted) return;
        const viewer = createViewer({
          canvas,
          keyTarget: map,
          overlay,
          city: loaded,
          reducedMotion: reducedMotion() ?? false,
          onWalkModeChange: (mode) => {
            clearTimeout(walkLoadTimer.current);
            setWalkLoad('idle');
            walkModeRef.current = mode;
            setWalkMode(mode);
            turnHold.release(); // a held turn ends with the mode it began in
            setBlocked(0);
            // Keep the keys working, whatever started or ended the walk.
            map.focus({ focusVisible: false } as FocusOptions);
          },
          onWalkBlocked: () => {
            // Refused, so nothing is getting ready: the hint mustn't say so once this clears.
            clearTimeout(walkLoadTimer.current);
            setWalkLoad('idle');
            setBlocked(performance.now());
          },
          onWalkUnavailable: () => {
            clearTimeout(walkLoadTimer.current);
            setWalkLoad('failed');
          },
          onStreetChange: setStreet,
          onRideChange: (state) => {
            rideRef.current = state;
            setRide(state);
          },
        });
        viewerRef.current = viewer;
        return viewer.ready.then(() => {
          if (abort.signal.aborted) return;
          progress.built = true;
          report();
          // Keyboard users can pan and use shortcuts at once, without a focus ring flashing up.
          map.focus({ focusVisible: false } as FocusOptions);
          setStatus({ state: 'ready' });
          setPlaceCity(loaded);
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

  const ready = status.state === 'ready';

  useEffect(() => {
    // Focus moved there for the person, not by a click: show where it went.
    if (status.state === 'error') retryRef.current?.focus({ focusVisible: true } as FocusOptions);
  }, [status.state]);

  // The map is drawn: the loading screen fades off it.
  useEffect(() => {
    if (ready) return removeIntro();
  }, [ready]);

  useShortcuts({
    app: appRef,
    viewer: viewerRef,
    mode: walkModeRef,
    running: runningRef,
    startWalk: () => startWalkRef.current(),
    onWalkKey: () => steppedRef.current(),
    toggleSound: () => toggleSoundRef.current(),
    turnHold,
    openMenu,
    menuOpen: menuOpenRef,
    closeMenu,
    typeAhead: (key) => (typedRef.current += key),
  });

  const toggleRunRef = useRef(() => {
    runningRef.current = !runningRef.current;
    setRunning(runningRef.current);
    viewerRef.current?.run(runningRef.current);
    const sprint = rideRef.current === 'riding';
    say(runningRef.current ? (sprint ? 'Sprinting' : 'Running') : sprint ? 'Riding' : 'Walking');
  });

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

  const viewer = () => viewerRef.current;
  /** What each of the menu's commands does: thin calls into the viewer and the shell's state. */
  const [actions] = useState((): Record<Exclude<ActionId, 'help' | 'about'>, () => void> => ({
    centre: () => startWalkRef.current(),
    map: () => viewerRef.current?.stopWalking(),
    'zoom-in': () => viewerRef.current?.zoomBy(1.25),
    'zoom-out': () => viewerRef.current?.zoomBy(0.8),
    'turn-left': () => viewerRef.current?.rotate(-1),
    'turn-right': () => viewerRef.current?.rotate(1),
    reset: () => viewerRef.current?.resetView(),
    run: () => toggleRunRef.current(),
    ride: () => viewerRef.current?.ride('toggle'),
    bell: () => viewerRef.current?.ride('bell'),
    sound: () => toggleSoundRef.current(),
  }));
  /** A command from the menu: the menu closes first, and focus goes back to the map for its keys. */
  const run = useCallback(
    (action: ActionId) => {
      if (action === 'help' || action === 'about') return; // pages of the menu itself
      closeMenu();
      // Mute and the bell sound for themselves.
      if (action !== 'sound' && action !== 'bell') sound.tap();
      actions[action]();
    },
    [actions, closeMenu],
  );
  const onPage = useCallback((page: MenuPage) => setMenu((m) => ({ ...m, page })), []);
  const commandState: CommandState = useMemo(
    () => ({ mode: walkMode, ride, running, soundOn, keys, mod }),
    [walkMode, ride, running, soundOn, keys, mod],
  );
  // Places by name: choosing one starts a walk there, as a click on the map would.
  const places = useMemo(
    () =>
      placeCity
        ? {
            city: placeCity,
            go: (place: Place) => {
              closeMenu();
              sound.tap();
              viewerRef.current?.walkAt(place.x, place.z);
            },
          }
        : undefined,
    [placeCity, closeMenu],
  );

  // The Ride pill goes once no bike is near. Pressed, it had focus, which would fall to the page
  // and take the keys with it: back to the map, as after a walk starts or ends.
  const pill = ready && walkMode === 'walk' && !!ride;
  const hadPill = useRef(false);
  useEffect(() => {
    if (hadPill.current && !pill && document.activeElement === document.body) {
      mapRef.current?.focus({ focusVisible: false } as FocusOptions);
    }
    hadPill.current = pill;
  }, [pill]);

  const coaching = walkMode === 'walk' && coach && !blocked;
  const errorSlot = status.state === 'error' ? introErrorSlot() : null;
  const errorNotice = status.state === 'error' && (
    <div className="load-error" role="alert">
      <span>{status.message}</span>
      <button
        ref={retryRef}
        type="button"
        className="action primary"
        onClick={() => setAttempt((n) => n + 1)}
      >
        Try again
      </button>
    </div>
  );

  return (
    <main ref={appRef} className="app" data-walk={walkMode}>
      <div
        ref={mapRef}
        className="map"
        tabIndex={0}
        role="application"
        aria-roledescription="map"
        aria-label={
          walkMode === 'walk' && riding ? rideLabel(keys) : mapLabels(keys, mod)[walkMode]
        }
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

      <header className="hud hud-top">
        {/* Where you are, on foot: the only plate on screen. */}
        <StreetSign name={walkMode === 'walk' ? street : null} />
        <Credits />
        {/*
          The hint, under the corners. Always in the page, empty when there's nothing to say, so
          changes are announced.
        */}
        <output className="hint">
          {blocked ? (
            'Can’t walk there. Pick a street or square.'
          ) : walkLoad === 'loading' ? (
            'Getting ready to walk…'
          ) : walkLoad === 'failed' ? (
            'Walking couldn’t load. Check your connection and try again.'
          ) : said ? (
            <span key={said.at}>{said.text}</span>
          ) : walkMode === 'walk' && riding && rideCoach ? (
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
                <kbd>{keys.KeyD}</kbd> walk, hold <kbd>Shift</kbd> to run, drag to look.{' '}
                <kbd>Esc</kbd> for the map.
              </span>
              <span className="hint-touch">
                Left thumb walks, right thumb looks. The menu takes you back to the map.
              </span>
            </>
          ) : null}
        </output>
      </header>

      <footer className="hud hud-bottom">
        {/* By a bike, or on one: the one thing the moment offers, where a thumb finds it. */}
        <div className="bar">
          {pill && (
            <ActionButton
              label={riding ? 'Get off' : 'Ride'}
              shortcut="F"
              primary={!riding}
              onPress={() => viewer()?.ride('toggle')}
            >
              <BikeIcon />
            </ActionButton>
          )}
        </div>
        {ready && (
          <button
            type="button"
            className="menu-trigger"
            aria-label="Menu"
            aria-haspopup="dialog"
            aria-keyshortcuts={mod === '⌘' ? 'Meta+K' : 'Control+K'}
            onClick={() => {
              sound.tap();
              openMenu();
            }}
            onPointerEnter={() => void loadMenu().catch(() => {})}
          >
            <MenuIcon />
            <kbd aria-hidden="true">{mod === '⌘' ? '⌘' : 'Ctrl '}K</kbd>
          </button>
        )}
      </footer>

      {errorSlot ? createPortal(errorNotice, errorSlot) : errorNotice}

      {menu.used && (
        <Suspense fallback={null}>
          <CommandMenu
            open={menu.open}
            page={menu.page}
            onPage={onPage}
            onClose={closeMenu}
            takeTyped={takeTyped}
            state={commandState}
            run={run}
            places={places}
          />
        </Suspense>
      )}
    </main>
  );
}
