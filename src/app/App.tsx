import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { sound } from '../audio/sound.ts';
import type { City } from '../data/city.ts';
import { CITY_URL, loadCity } from '../data/load.ts';
import type { Place } from '../data/places.ts';
import { presetAt } from '../scene/daylight.ts';
import type { Daylight, PresetId } from '../scene/daylight.ts';
import type { PlayerPose, Refusal, RideState, RoomPlace, Viewer } from '../scene/viewer.ts';
import type { Account } from './account-sheet.tsx';
import type { ActionId, CommandState } from './commands.ts';
import type { MenuPage } from './command-menu.tsx';
import type { Multiplayer } from './multiplayer.ts';
import { ActionButton } from './controls.tsx';
import { Credits } from './credits.tsx';
import { ArrowIcon, BikeIcon, DoorIcon, MenuIcon } from './icons.tsx';
import { createTurnHold, KEYCAPS, layoutKeycaps, modKey } from './input.ts';
import type { KeyboardLayout, Keycaps } from './input.ts';
import { introErrorSlot, removeIntro, showKeys, showStep } from './intro.ts';
import { live } from './live.ts';
import { loadStep, stallWatch, unlessAborted } from './loading.ts';
import type { LoadState } from './loading.ts';
import { pointerFor } from './pointer.ts';
import { useShortcuts } from './shortcuts.ts';
import { StreetSign } from './street-sign.tsx';

type Status = { state: 'loading' } | { state: 'ready' } | { state: 'error'; message: string };

/**
 * A stalled network must end in the retry state, never in an endless loading screen: this long
 * with no bytes and no step done is a stall. A slow link that keeps delivering never trips it
 * (a deadline for the whole load would fail it on every try).
 */
const LOAD_STALL_MS = 20_000;

/** The menu is its own chunk: fetched once the map is up, or as someone reaches for it. */
const loadMenu = () => import('./command-menu.tsx');
/** The minimap is its own chunk too, fetched once the map is up. */
const Minimap = lazy(() => import('./minimap-view.tsx').then((m) => ({ default: m.Minimap })));
/** The account sheet: its own chunk, fetched the first time it opens. */
const AccountSheet = lazy(() =>
  import('./account-sheet.tsx').then((m) => ({ default: m.AccountSheet })),
);
/** Whether the minimap shows is remembered on this device. */
const MINIMAP_KEY = 'leuven-minimap';
/** React keeps a failed lazy component failed: each try after a failure gets a fresh one. */
const lazyMenu = () => lazy(() => loadMenu().then((m) => ({ default: m.CommandMenu })));

/**
 * The menu's chunk can fail to download (a flaky link). Without this, React would take the whole
 * app down with it, map and all; instead the menu stays shut and the shell says so.
 */
class MenuGuard extends Component<{ onError: () => void; children: ReactNode }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    this.props.onError();
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** The map's description, naming the keys as this keyboard types them. */
const mapLabel = (k: Keycaps, mod: string) =>
  `Map of Leuven’s centre around Grote Markt, Oude Markt and Ladeuzeplein, with you on it. Drag to look around; scroll, pinch or press plus and minus to zoom, down to the street; ${k.KeyQ} and ${k.KeyE} turn the map. ${k.KeyW}, ${k.KeyA}, ${k.KeyS} and ${k.KeyD} walk, and hold Shift to run; click or tap a street nearby to walk there; F rides the nearest bike; Enter goes into a building beside you, or out; Space brings the view back to you. ${mod} K or slash opens the menu, with every command and key.`;
/** Riding, the map says how. */
const rideLabel = (k: Keycaps, mod: string) =>
  `Riding a bike in Leuven. ${k.KeyW}, ${k.KeyA}, ${k.KeyS} and ${k.KeyD} ride, Shift sprints, B rings the bell and F gets off; click or tap a street nearby to ride there. Space brings the view back to you. ${mod} K or slash opens the menu.`;

/**
 * How to walk is shown the first time the view comes close enough to show the avatar, until a
 * few seconds after the first step, and then not again on this device: the keys are in the menu.
 */
const COACHED_KEY = 'leuven-walk-coached';
const COACH_AFTER_STEP_MS = 4_000;
/** The first ride is coached for a few seconds, once per device. */
const RIDE_COACHED_KEY = 'leuven-ride-coached';
const RIDE_COACH_MS = 7_000;
/** A download that failed is said this long (ms). */
const FAILED_MS = 8_000;
/** What a command did, where nothing else on screen shows it (sound, running), for a moment. */
const SAID_MS = 2_000;
/** What the hint says of each time of day as T steps to it. */
const TIME_SAID: Record<PresetId, string> = {
  morning: 'Morning',
  midday: 'Midday',
  golden: 'Golden hour',
  dusk: 'Dusk',
  night: 'Night',
};
/** A colour as CSS, for the sky tokens. */
const hex = (colour: number) => `#${colour.toString(16).padStart(6, '0')}`;

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
  /** Where the other players' names float over the map. */
  const tagsRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  // Q and E: a tap is a step; held, they keep turning.
  const [turnHold] = useState(createTurnHold);
  const [status, setStatus] = useState<Status>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retryRef = useRef<HTMLButtonElement>(null);
  /** A tap the avatar couldn't go to, and why, until the next try. */
  const [blocked, setBlocked] = useState<Refusal | null>(null);
  /** The arrow that marks the avatar, placed by hand: it moves with every frame that pans. */
  const arrowRef = useRef<HTMLButtonElement>(null);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(running);
  /** Whether the avatar's code failed to download, and whether the view is close enough to show it. */
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [avatarShown, setAvatarShown] = useState(false);
  const [street, setStreet] = useState<string | null>(null);
  /** The room the avatar is in, and its floor, or null in the street. */
  const [inside, setInside] = useState<{ room: string; floor: string } | null>(null);
  /** A building you can go into beside you, or the one you're in: its pill and Enter. */
  const [door, setDoor] = useState<{ room: string; inside: boolean } | null>(null);
  /** What the menu can take you inside, once the rooms have loaded; why they couldn't. */
  const [rooms, setRooms] = useState<readonly RoomPlace[]>([]);
  const [roomsFailed, setRoomsFailed] = useState<string | null>(null);
  // A failed download is said for a while, not for the rest of the visit: the next try may work.
  useEffect(() => {
    if (!roomsFailed && !avatarFailed) return;
    const timer = setTimeout(() => {
      setRoomsFailed(null);
      setAvatarFailed(false);
    }, FAILED_MS);
    return () => clearTimeout(timer);
  }, [roomsFailed, avatarFailed]);
  const [soundOn, setSoundOn] = useState(sound.on);
  /** The time of day, as the menu names it, and whether the day passes by itself. */
  const [time, setTime] = useState<PresetId>('golden');
  const [passing, setPassing] = useState(false);
  const passingRef = useRef(false);
  const [minimap, setMinimap] = useState(() => {
    try {
      return localStorage.getItem(MINIMAP_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const minimapRef = useRef(minimap);
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
  const [CommandMenu, setCommandMenu] = useState(lazyMenu);
  /** Who you are on the map, how many are on it, and the sheet to join or change your look. */
  const [account, setAccount] = useState<Account>({ signedIn: false });
  const [online, setOnline] = useState<number | null>(null);
  // Who you are and how many are here, on <html> for the smoke test.
  useEffect(() => {
    const data = document.documentElement.dataset;
    data.account = account.signedIn ? account.name : '';
    data.online = online === null ? '' : String(online);
  }, [account, online]);
  const [accountSheet, setAccountSheet] = useState({ open: false, used: false });
  const multiplayerRef = useRef<Multiplayer | null>(null);
  /** Where the avatar was last, for the other players' chunk when it arrives. */
  const movedRef = useRef<PlayerPose | null>(null);
  const openAccount = useCallback(() => setAccountSheet({ open: true, used: true }), []);
  const closeAccount = useCallback(() => {
    setAccountSheet((a) => ({ ...a, open: false }));
    mapRef.current?.focus({ focusVisible: false } as FocusOptions);
  }, []);
  const [menuFailed, setMenuFailed] = useState(false);
  const openMenu = useCallback((page: MenuPage = 'list') => {
    menuOpenRef.current = true;
    typedRef.current = '';
    setMenuFailed(false);
    setMenu({ open: true, page, used: true });
  }, []);
  /** Its chunk didn't come: shut, out of the page, and a fresh download on the next try. */
  // (React logs the error itself.)
  const onMenuError = useCallback(() => {
    menuOpenRef.current = false;
    setMenu({ open: false, page: 'list', used: false });
    setCommandMenu(() => lazyMenu());
    setMenuFailed(true);
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

  /** Someone took a first step: the coach has done its job, and goes after a moment. */
  const steppedRef = useRef(() => {
    setBlocked(null);
    if (coachTimer.current !== undefined) return;
    coachTimer.current = setTimeout(() => {
      setCoach(false);
      rememberCoached();
    }, COACH_AFTER_STEP_MS);
  });

  useEffect(() => {
    const map = mapRef.current;
    const canvas = canvasRef.current;
    if (!map || !canvas) return;
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
    // Every download counts as a sign of life: the city's bytes, and the engine's arrival.
    const watch = stallWatch(LOAD_STALL_MS);
    const signal = AbortSignal.any([abort.signal, watch.signal]);
    const city = loadCity(url, signal, (received, total) => {
      watch.alive();
      [progress.received, progress.total] = [received, total];
      report();
    }).then((loaded) => {
      watch.alive();
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
      watch.alive();
      progress.engine = true;
      report();
      return module;
    });
    // The engine's import can't be aborted, but a stall still ends the wait for it.
    unlessAborted(Promise.all([city, engine]), signal)
      .then(([loaded, { createViewer }]) => {
        // Both are here; building the first frame is the device's work, not the network's.
        watch.stop();
        if (abort.signal.aborted) return;
        const viewer = createViewer({
          canvas,
          city: loaded,
          reducedMotion: reducedMotion() ?? false,
          ...(tagsRef.current && { tags: tagsRef.current }),
          onBlocked: setBlocked,
          onAvatarUnavailable: () => setAvatarFailed(true),
          onAvatarAt: (x, y, figure) => {
            setAvatarShown(figure);
            const arrow = arrowRef.current;
            const p = arrow && pointerFor(x, y, map.clientWidth, map.clientHeight, figure);
            if (!arrow) return;
            arrow.hidden = !p;
            if (!p) return;
            arrow.dataset.edge = p.edge ? 'true' : 'false';
            arrow.tabIndex = p.edge ? 0 : -1;
            arrow.style.translate = `${p.x}px ${p.y}px`;
            arrow.style.setProperty('--turn', `${p.angle}rad`);
          },
          onStreetChange: setStreet,
          onPlaceChange: setInside,
          onDoor: setDoor,
          onRoomsUnavailable: setRoomsFailed,
          // The sky behind the canvas and the page's tokens follow the light; the menu's
          // state only when the hour reaches another preset (not every frame of a passing day).
          onDaylight: (light: Daylight) => {
            const app = appRef.current;
            if (app) {
              app.style.setProperty('--sky-top', hex(light.top));
              app.style.setProperty('--sky-horizon', hex(light.horizon));
            }
            document.documentElement.dataset.night = light.night > 0.5 ? '1' : '0';
            const preset = presetAt(light.hour);
            if (document.documentElement.dataset.time !== preset) {
              document.documentElement.dataset.time = preset;
              setTime(preset);
            }
          },
          onRideChange: (state) => {
            rideRef.current = state;
            setRide(state);
          },
          onMove: (state) => {
            live.me = { x: state.x, z: state.z, facing: state.heading };
            live.changed();
            movedRef.current = state;
            multiplayerRef.current?.moved(state);
          },
          onHeading: (heading) => {
            live.heading = heading;
            live.changed();
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
          // Other people: a chunk of its own, once the map is up. Without it the map is yours alone.
          import('./multiplayer.ts').then(
            ({ startMultiplayer }) => {
              if (abort.signal.aborted) return;
              const multiplayer = startMultiplayer(viewer, {
                account: setAccount,
                online: setOnline,
              });
              if (movedRef.current) multiplayer.moved(movedRef.current);
              multiplayerRef.current = multiplayer;
            },
            (error: unknown) => console.warn('Other players couldn’t load.', error),
          );
        });
      })
      .catch((error: unknown) => {
        watch.stop();
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
      watch.stop();
      abort.abort();
      multiplayerRef.current?.dispose();
      multiplayerRef.current = null;
      viewerRef.current?.dispose();
      viewerRef.current = null;
    };
  }, [attempt]);

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
    running: runningRef,
    onWalkKey: () => steppedRef.current(),
    toggleSound: () => toggleSoundRef.current(),
    toggleMinimap: () => toggleMinimapRef.current(),
    openAccount,
    nextTime: () => nextTimeRef.current(),
    togglePassing: () => togglePassingRef.current(),
    turnHold,
    openMenu,
    menuOpen: menuOpenRef,
    closeMenu,
    typeAhead: (key) => (typedRef.current += key),
  });

  /** The next time of day, said by name; the day passing or standing still, said too. */
  const nextTimeRef = useRef(() => {
    const next = viewerRef.current?.nextTimeOfDay();
    if (next) say(TIME_SAID[next]);
  });
  const togglePassingRef = useRef(() => {
    passingRef.current = !passingRef.current;
    setPassing(passingRef.current);
    viewerRef.current?.passTime(passingRef.current);
    say(passingRef.current ? 'The day passes' : 'The day stands still');
  });

  const toggleMinimapRef = useRef(() => {
    minimapRef.current = !minimapRef.current;
    setMinimap(minimapRef.current);
    try {
      localStorage.setItem(MINIMAP_KEY, minimapRef.current ? '1' : '0');
    } catch {
      // Shown again next time: harmless.
    }
    say(minimapRef.current ? 'Minimap on' : 'Minimap off');
  });

  const toggleRunRef = useRef(() => {
    runningRef.current = !runningRef.current;
    setRunning(runningRef.current);
    viewerRef.current?.run(runningRef.current);
    const sprint = rideRef.current === 'riding';
    say(runningRef.current ? (sprint ? 'Sprinting' : 'Running') : sprint ? 'Riding' : 'Walking');
  });

  // "Can't go there" stays until the next try, so nobody misses it. A touch with the avatar in
  // view is a tap to go somewhere: the coach can go too.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || (!blocked && !(avatarShown && coach))) return;
    const clear = () => {
      setBlocked(null);
      if (avatarShown) steppedRef.current();
    };
    map.addEventListener('pointerdown', clear, { once: true, passive: true });
    return () => map.removeEventListener('pointerdown', clear);
  }, [blocked, avatarShown, coach]);

  const viewer = () => viewerRef.current;
  /** The other players' chunk, or why there's no joining yet. */
  const multiplayer = () => {
    const loaded = multiplayerRef.current;
    if (!loaded) throw new Error('Still connecting. Try again in a moment.');
    return loaded;
  };
  /** What each of the menu's commands does: thin calls into the viewer and the shell's state. */
  const [actions] = useState((): Record<Exclude<ActionId, 'help' | 'about'>, () => void> => ({
    recentre: () => viewerRef.current?.recentre(),
    door: () => viewerRef.current?.door(),
    'zoom-in': () => viewerRef.current?.zoomBy(1.25),
    'zoom-out': () => viewerRef.current?.zoomBy(0.8),
    'turn-left': () => viewerRef.current?.rotate(-1),
    'turn-right': () => viewerRef.current?.rotate(1),
    reset: () => viewerRef.current?.resetView(),
    run: () => toggleRunRef.current(),
    ride: () => viewerRef.current?.ride('toggle'),
    bell: () => viewerRef.current?.ride('bell'),
    sound: () => toggleSoundRef.current(),
    time: () => nextTimeRef.current(),
    'pass-time': () => togglePassingRef.current(),
    minimap: () => toggleMinimapRef.current(),
    account: () => setAccountSheet({ open: true, used: true }),
  }));
  /** A command from the menu: the menu closes first, and focus goes to the map for its keys. */
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
  // The rooms the menu lists: asked for when it opens, which loads their data if need be.
  useEffect(() => {
    if (!menu.open) return;
    viewerRef.current
      ?.rooms()
      .then(setRooms)
      .catch(() => {});
  }, [menu.open]);
  const roomPlaces = useMemo(
    () => ({
      list: rooms,
      go: (room: RoomPlace) => {
        closeMenu();
        sound.tap();
        viewerRef.current?.lookAt(room.x, room.z);
      },
    }),
    [rooms, closeMenu],
  );
  const commandState: CommandState = useMemo(
    () => ({
      ride,
      door,
      running,
      soundOn,
      time,
      passing,
      minimap,
      signedIn: account.signedIn,
      keys,
      mod,
    }),
    [ride, door, running, soundOn, time, passing, minimap, account.signedIn, keys, mod],
  );
  // Places by name: choosing one takes the view there, down to the street; you walk there.
  const places = useMemo(
    () =>
      placeCity
        ? {
            city: placeCity,
            go: (place: Place) => {
              closeMenu();
              sound.tap();
              viewerRef.current?.lookAt(place.x, place.z);
            },
          }
        : undefined,
    [placeCity, closeMenu],
  );

  // The pills go once no bike or building is near. Pressed, one had focus, which would fall to the
  // page and take the keys with it: back to the map.
  const pill = ready && (!!ride || !!door);
  const hadPill = useRef(false);
  useEffect(() => {
    if (hadPill.current && !pill && document.activeElement === document.body) {
      mapRef.current?.focus({ focusVisible: false } as FocusOptions);
    }
    hadPill.current = pill;
  }, [pill]);

  const coaching = ready && avatarShown && coach && !blocked;
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
    <main ref={appRef} className="app">
      <div
        ref={mapRef}
        className="map"
        tabIndex={0}
        role="application"
        aria-roledescription="map"
        aria-label={riding ? rideLabel(keys, mod) : mapLabel(keys, mod)}
      >
        <canvas ref={canvasRef} className="city" />
        <div ref={tagsRef} className="player-tags" aria-hidden="true" />
        {/*
          Where you are: an arrow over your head while the view is too far out to see you, and at
          the edge of the screen, pointing your way, when you're off it; that one takes you back.
        */}
        <button
          ref={arrowRef}
          type="button"
          className="avatar-arrow"
          aria-label="Back to you"
          hidden
          tabIndex={-1}
          onClick={() => {
            viewerRef.current?.recentre();
            // Back on screen, the avatar needs no arrow: it hides, and its focus would fall to the
            // page and take the map's keys with it.
            mapRef.current?.focus({ focusVisible: false } as FocusOptions);
          }}
        >
          <ArrowIcon />
        </button>
      </div>

      <header className="hud hud-top">
        {/* Where you are, once the view is close enough to show you: the only plate on screen. */}
        <StreetSign name={inside ? `${inside.room} · ${inside.floor}` : street} />
        <div className="top-end">
          {ready && (
            <button
              type="button"
              className={account.signedIn ? 'you' : 'you primary'}
              aria-haspopup="dialog"
              aria-keyshortcuts="L"
              onClick={() => {
                sound.tap();
                openAccount();
              }}
            >
              {account.signedIn ? (
                <>
                  <span
                    className="you-dot"
                    style={{ '--shirt': hex(account.outfit.shirt) } as CSSProperties}
                  />
                  <span className="you-name">{account.name}</span>
                </>
              ) : (
                'Join'
              )}
              {online !== null && online > (account.signedIn ? 1 : 0) && (
                <span className="you-count">
                  <span className="sr-only">, </span>
                  {online} here
                </span>
              )}
            </button>
          )}
          <Credits />
        </div>
        {/*
          The hint, under the corners. Always in the page, empty when there's nothing to say, so
          changes are announced.
        */}
        <output className="hint">
          {blocked === 'far' ? (
            'Too far to walk. Get closer first.'
          ) : blocked ? (
            'Can’t go there. Pick a street or square.'
          ) : roomsFailed ? (
            roomsFailed
          ) : avatarFailed ? (
            'Walking couldn’t load. Check your connection and try again.'
          ) : menuFailed ? (
            'The menu couldn’t load. Check your connection and try again.'
          ) : said ? (
            <span key={said.at}>{said.text}</span>
          ) : riding && rideCoach ? (
            <>
              <span className="hint-keys">
                <kbd>{keys.KeyW}</kbd> <kbd>{keys.KeyA}</kbd> <kbd>{keys.KeyS}</kbd>{' '}
                <kbd>{keys.KeyD}</kbd> ride, <kbd>Shift</kbd> sprints, <kbd>B</kbd> rings the bell.{' '}
                <kbd>F</kbd> gets off anywhere.
              </span>
              <span className="hint-touch">
                Tap a street to ride there. Ride gets you off again.
              </span>
            </>
          ) : coaching ? (
            <>
              <span className="hint-keys">
                <kbd>{keys.KeyW}</kbd> <kbd>{keys.KeyA}</kbd> <kbd>{keys.KeyS}</kbd>{' '}
                <kbd>{keys.KeyD}</kbd> walk, hold <kbd>Shift</kbd> to run, click to go somewhere.{' '}
                <kbd>Space</kbd> brings the view back to you.
              </span>
              <span className="hint-touch">
                Tap a street to walk there. Pinch to zoom; the menu holds the rest.
              </span>
            </>
          ) : null}
        </output>
      </header>

      <footer className="hud hud-bottom">
        {ready && placeCity && minimap && (
          <Suspense fallback={null}>
            <Minimap city={placeCity} />
          </Suspense>
        )}
        {/*
          By a bike or a building you can go into: what the moment offers, where a thumb finds it.
        */}
        <div className="bar">
          {ready && door && (
            <ActionButton
              label={door.inside ? 'Go out' : 'Go in'}
              shortcut="↵"
              keys="Enter"
              primary={!door.inside}
              onPress={() => viewer()?.door()}
            >
              <DoorIcon />
            </ActionButton>
          )}
          {ready && ride && (
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

      {accountSheet.used && (
        <Suspense fallback={null}>
          <AccountSheet
            open={accountSheet.open}
            onClose={closeAccount}
            account={account}
            online={online}
            signUp={(name, password) => multiplayer().signUp(name, password)}
            signIn={(name, password) => multiplayer().signIn(name, password)}
            signOut={() => multiplayer().signOut()}
            dress={(outfit) => multiplayerRef.current?.dress(outfit)}
          />
        </Suspense>
      )}

      {menu.used && (
        <MenuGuard onError={onMenuError}>
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
              rooms={roomPlaces}
            />
          </Suspense>
        </MenuGuard>
      )}
    </main>
  );
}
