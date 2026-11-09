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
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';

import { sound } from '../audio/sound.ts';
import type { City } from '../data/city.ts';
import { CITY_URL, loadCity } from '../data/load.ts';
import { presetAt } from '../scene/daylight.ts';
import type { Daylight, PresetId } from '../scene/daylight.ts';
import type { PlayerPose, Refusal, RideState, RoomPlace, Viewer } from '../scene/viewer.ts';
import type { Account } from './account-sheet.tsx';
import type { ActionId, CommandState } from './commands.ts';
import type { MenuPage } from './command-menu.tsx';
import type { Multiplayer } from './multiplayer.ts';
import { coachStep } from './coach.ts';
import { css } from './colours.ts';
import { ActionButton } from './controls.tsx';
import { Credits } from './credits.tsx';
import {
  BikeIcon,
  DiamondIcon,
  DoorIcon,
  MapIcon,
  MenuIcon,
  PeopleIcon,
  StopIcon,
  WalkIcon,
} from './icons.tsx';
import { createTurnHold, KEYCAPS, layoutKeycaps, modKey } from './input.ts';
import type { KeyboardLayout, Keycaps } from './input.ts';
import { introErrorSlot, removeIntro, showKeys, showStep } from './intro.ts';
import { live } from './live.ts';
import { loadStep, stallWatch, unlessAborted } from './loading.ts';
import { createStore } from './store.ts';
import type { Waypoint } from '../data/waypoints.ts';
import type { LoadState } from './loading.ts';
import { EDGE_INSET, pointerFor } from './pointer.ts';
import type { Inset } from './pointer.ts';
import { useShortcuts } from './shortcuts.ts';
import { StreetSign } from './street-sign.tsx';
import { ViewControls, focusQuietly } from './view-controls.tsx';

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
const lazyMinimap = () =>
  lazy(() => import('./minimap-view.tsx').then((m) => ({ default: m.Minimap })));
/** The account sheet: its own chunk, fetched the first time it opens. */
const lazySheet = () =>
  lazy(() => import('./account-sheet.tsx').then((m) => ({ default: m.AccountSheet })));
/** React keeps a failed lazy component failed: each try after a failure gets a fresh one. */
const lazyMenu = () => lazy(() => loadMenu().then((m) => ({ default: m.CommandMenu })));

/** The full map is a chunk of its own too. */
const loadMap = () => import('./map-overlay.tsx');
const lazyMap = () => lazy(() => loadMap().then((m) => ({ default: m.MapOverlay })));

/** Whether the minimap shows is remembered on this device. */
const MINIMAP_KEY = 'leuven-minimap';

/**
 * A lazy chunk can fail to download (a flaky link). Without this, React would take the whole app
 * down with it, map and all; instead its corner stays shut and the shell says so.
 */
class ChunkGuard extends Component<{ onError: () => void; children: ReactNode }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    this.props.onError();
  }
  override render() {
    return this.state.failed ? null : <Suspense fallback={null}>{this.props.children}</Suspense>;
  }
}

/** The map's description, naming the keys as this keyboard types them. */
const mapLabel = (k: Keycaps, mod: string) =>
  `Map of Leuven’s centre around Grote Markt, Oude Markt and Ladeuzeplein, with you on it. Drag to look around; scroll, pinch or press plus and minus to zoom, down to the street; ${k.KeyQ}, ${k.KeyE} and the turn buttons turn the map. ${k.KeyW}, ${k.KeyA}, ${k.KeyS} and ${k.KeyD} walk, and hold Shift to run; click or tap a street nearby to walk there; F rides the nearest bike; Enter goes into a building beside you, or out; Space brings the view back to you. M opens the full map. ${mod} K or slash opens the menu, with every command and key.`;
/** Riding, the map says how. */
const rideLabel = (k: Keycaps, mod: string) =>
  `Riding a bike in Leuven. ${k.KeyW}, ${k.KeyA}, ${k.KeyS} and ${k.KeyD} ride, Shift sprints, B rings the bell and F gets off; click or tap a street nearby to ride there. Space brings the view back to you. ${mod} K or slash opens the menu.`;

/**
 * The first minute, once on this device (`coach.ts`): come down to the street, take a step, look
 * around. The step's line stays this long after it, and the last line this long, or until the
 * map is dragged.
 */
const COACHED_KEY = 'leuven-walk-coached';
const COACH_AFTER_STEP_MS = 4_000;
const COACH_LOOK_MS = 7_000;
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
const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** The platform, for the menu's chord: ⌘ on Apple's, Ctrl elsewhere. */
const platform = () =>
  (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData?.platform ??
  navigator.platform;

/** Storage can throw (private windows, blocked site data): then nothing is remembered. */
function recalled(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Asked again next time: harmless.
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

/** Written for each frame that pans, so one object does for all of them. */
const diamondInset: Inset = { ...EDGE_INSET };

/** Puts the diamond by hand: it moves with every frame that pans, without a render for each. */
function placeDiamond(
  diamond: HTMLElement,
  map: HTMLElement,
  header: HTMLElement | null,
  x: number,
  y: number,
  figure: boolean,
): void {
  diamondInset.top = EDGE_INSET.top + (header?.offsetHeight ?? 0);
  const p = pointerFor(x, y, map.clientWidth, map.clientHeight, figure, diamondInset);
  diamond.hidden = !p;
  if (!p) return;
  diamond.dataset.edge = p.edge ? 'true' : 'false';
  diamond.tabIndex = p.edge ? 0 : -1;
  diamond.style.translate = `${p.x}px ${p.y}px`;
  diamond.style.setProperty('--turn', `${p.angle}rad`);
}

/**
 * Once a dialog over the map has shut, the keys are the map's again: focus goes there rather than
 * back to the button that opened it, where Space would open it again. In an effect, so the dialog
 * has let go of focus by then.
 */
function useFocusWhenShut(open: boolean, target: RefObject<HTMLElement | null>): void {
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) focusQuietly(target.current);
    wasOpen.current = open;
  }, [open, target]);
}

export function App() {
  const appRef = useRef<HTMLElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Where the other players' names float over the map. */
  const tagsRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  // Q and E and the buttons: the map turns for as long as they're held.
  const [turnHold] = useState(createTurnHold);
  const [status, setStatus] = useState<Status>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retryRef = useRef<HTMLButtonElement>(null);
  /** A tap the avatar couldn't go to, and why, until the next try. */
  const [blocked, setBlocked] = useState<Refusal | null>(null);
  /** The diamond that marks the avatar, placed by hand: it moves with every frame that pans. */
  const diamondRef = useRef<HTMLButtonElement>(null);
  /** The top row: what the diamond at the edge stays below. */
  const headerRef = useRef<HTMLElement>(null);
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
  const [minimap, setMinimap] = useState(() => recalled(MINIMAP_KEY) !== '0');
  const minimapRef = useRef(minimap);
  const [said, setSaid] = useState<{ text: string; at: number } | null>(null);
  const say = useCallback((text: string) => setSaid({ text, at: performance.now() }), []);
  useEffect(() => {
    if (!said) return;
    const timer = setTimeout(() => setSaid(null), SAID_MS);
    return () => clearTimeout(timer);
  }, [said]);
  useEffect(() => sound.attach(), []);
  // Marks and the route being walked: each shown by the part that needs it, so the shell renders
  // only for a route starting or ending and the map opening.
  const [marks] = useState(() => createStore<Waypoint[]>([]));
  const [routing, setRouting] = useState(false);
  const routingRef = useRef(routing);
  const [mapOpen, setMapOpen] = useState(false);
  const [coach, setCoach] = useState(() => ({
    done: recalled(COACHED_KEY) === '1',
    street: false,
    stepped: false,
    settled: false,
  }));
  /** A place the view was sent to, to look at: the Go to pill's, until the view is back on you. */
  const [looking, setLooking] = useState<{ name: string; x: number; z: number } | null>(null);
  /** The view has been dragged off the avatar: Back to you says so. */
  const [away, setAway] = useState(false);
  const [ride, setRide] = useState<RideState>('');
  const rideRef = useRef(ride);
  /** The city, for finding places by name, once it's on screen. */
  const [placeCity, setPlaceCity] = useState<City | null>(null);
  const [rideCoach, setRideCoach] = useState(() => recalled(RIDE_COACHED_KEY) !== '1');
  const riding = ride === 'riding';
  useEffect(() => {
    if (!riding || !rideCoach) return;
    const timer = setTimeout(() => {
      setRideCoach(false);
      remember(RIDE_COACHED_KEY, '1');
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
    data.guest = account.signedIn ? '' : (account.name ?? '');
    data.online = online === null ? '' : String(online);
  }, [account, online]);
  const [accountSheet, setAccountSheet] = useState({ open: false, used: false });
  /** The sheet's chunk didn't download: said in the hint until the next try. */
  const [sheetFailed, setSheetFailed] = useState(false);
  const multiplayerRef = useRef<Multiplayer | null>(null);
  /** Where the avatar was last, for the other players' chunk when it arrives. */
  const movedRef = useRef<PlayerPose | null>(null);
  const openAccount = useCallback(() => {
    setSheetFailed(false);
    setAccountSheet({ open: true, used: true });
  }, []);
  const closeAccount = useCallback(() => setAccountSheet((a) => ({ ...a, open: false })), []);
  useFocusWhenShut(accountSheet.open, mapRef);
  // A chunk that didn't download (a flaky link) leaves its corner shut, not the map blank: the
  // next try gets a fresh download.
  const [AccountSheet, setAccountSheetChunk] = useState(lazySheet);
  const [Minimap, setMinimapChunk] = useState(lazyMinimap);
  const onSheetError = useCallback(() => {
    setAccountSheet({ open: false, used: false });
    setAccountSheetChunk(() => lazySheet());
    setSheetFailed(true);
  }, []);
  const onMinimapError = useCallback(() => setMinimapChunk(() => lazyMinimap()), []);
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
  useFocusWhenShut(menu.open, mapRef);
  const takeTyped = useCallback(() => {
    const typed = typedRef.current;
    typedRef.current = '';
    return typed;
  }, []);

  /** Someone took a first step: the coach moves on, a moment later. */
  const steppedRef = useRef(() => {
    setBlocked(null);
    setCoach((c) => (c.stepped ? c : { ...c, stepped: true }));
  });
  useEffect(() => {
    if (coach.done || !coach.stepped || coach.settled) return;
    const timer = setTimeout(() => setCoach((c) => ({ ...c, settled: true })), COACH_AFTER_STEP_MS);
    return () => clearTimeout(timer);
  }, [coach]);
  // The last line goes once it's been done (a drag of the map) or after a moment.
  useEffect(() => {
    if (coach.done || !coach.settled) return;
    const finish = () => {
      setCoach((c) => ({ ...c, done: true }));
      remember(COACHED_KEY, '1');
    };
    if (away) return finish();
    const timer = setTimeout(finish, COACH_LOOK_MS);
    return () => clearTimeout(timer);
  }, [coach, away]);

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
        let streetSeen = false;
        const viewer = createViewer({
          canvas,
          city: loaded,
          reducedMotion: reducedMotion() ?? false,
          ...(tagsRef.current && { tags: tagsRef.current }),
          onBlocked: setBlocked,
          onAvatarUnavailable: () => setAvatarFailed(true),
          onAvatarAt: (x, y, figure) => {
            setAvatarShown(figure);
            const off = viewerRef.current?.pinned() === false;
            setAway(off);
            if (!off) setLooking(null);
            if (figure && !streetSeen) {
              streetSeen = true;
              setCoach((c) => (c.street ? c : { ...c, street: true }));
            }
            if (diamondRef.current) {
              placeDiamond(diamondRef.current, map, headerRef.current, x, y, figure);
            }
          },
          onStreetChange: setStreet,
          onRoute: (target) => {
            if (target) steppedRef.current();
            routingRef.current = target !== null;
            setRouting(target !== null);
          },
          onPlaceChange: setInside,
          onDoor: setDoor,
          onRoomsUnavailable: setRoomsFailed,
          // The sky behind the canvas and the page's tokens follow the light; the menu's
          // state only when the hour reaches another preset (not every frame of a passing day).
          onDaylight: (light: Daylight) => {
            const app = appRef.current;
            if (app) {
              app.style.setProperty('--sky-top', css(light.top));
              app.style.setProperty('--sky-horizon', css(light.horizon));
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
        // For scripts/shots.ts, which frames its views by coordinates; gone from the build.
        if (import.meta.env.DEV) Object.assign(globalThis, { leuvenViewer: viewer });
        return viewer.ready.then(() => {
          if (abort.signal.aborted) return;
          progress.built = true;
          report();
          // Keyboard users can pan and use shortcuts at once, without a focus ring flashing up.
          focusQuietly(map);
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

  /**
   * What each command does, for the menu and the keys alike: thin calls into the viewer and the
   * shell's state, made once, so the shortcuts can bind them once.
   */
  const [actions] = useState((): Record<Exclude<ActionId, 'help' | 'about'>, () => void> => ({
    recentre: () => viewerRef.current?.recentre(),
    door: () => viewerRef.current?.door(),
    'zoom-in': () => viewerRef.current?.zoomBy(1.25),
    'zoom-out': () => viewerRef.current?.zoomBy(0.8),
    'turn-left': () => viewerRef.current?.rotate(-1),
    'turn-right': () => viewerRef.current?.rotate(1),
    reset: () => viewerRef.current?.resetView(),
    run: () => {
      runningRef.current = !runningRef.current;
      setRunning(runningRef.current);
      viewerRef.current?.run(runningRef.current);
      const sprint = rideRef.current === 'riding';
      say(runningRef.current ? (sprint ? 'Sprinting' : 'Running') : sprint ? 'Riding' : 'Walking');
    },
    ride: () => viewerRef.current?.ride('toggle'),
    bell: () => viewerRef.current?.ride('bell'),
    // Sound coming back is heard (rising); muting is silent, and says so.
    sound: () => {
      sound.setOn(!sound.on);
      setSoundOn(sound.on);
      sound.toggle(true);
      say(sound.on ? 'Sound on' : 'Sound off');
    },
    time: () => {
      const next = viewerRef.current?.nextTimeOfDay();
      if (next) say(TIME_SAID[next]);
    },
    'pass-time': () => {
      passingRef.current = !passingRef.current;
      setPassing(passingRef.current);
      viewerRef.current?.passTime(passingRef.current);
      say(passingRef.current ? 'The day passes' : 'The day stands still');
    },
    minimap: () => {
      minimapRef.current = !minimapRef.current;
      setMinimap(minimapRef.current);
      remember(MINIMAP_KEY, minimapRef.current ? '1' : '0');
      say(minimapRef.current ? 'Minimap on' : 'Minimap off');
    },
    account: () => openAccount(),
    'open-map': () => {
      menuOpenRef.current = false;
      setMenu((m) => ({ ...m, open: false }));
      setMapOpen(true);
    },
    'stop-route': () => viewerRef.current?.cancelRoute(),
  }));

  useShortcuts({
    app: appRef,
    viewer: viewerRef,
    running: runningRef,
    openMap: actions['open-map'],
    routing: routingRef,
    onWalkKey: () => steppedRef.current(),
    toggleSound: actions.sound,
    toggleMinimap: actions.minimap,
    openAccount,
    nextTime: actions.time,
    togglePassing: actions['pass-time'],
    turnHold,
    openMenu,
    menuOpen: menuOpenRef,
    closeMenu,
    typeAhead: (key) => (typedRef.current += key),
  });

  const closeMap = useCallback(() => setMapOpen(false), []);
  const [MapOverlay, setMapChunk] = useState(lazyMap);
  /** Its chunk didn't come: shut, said so, and a fresh download on the next try. */
  const onMapError = useCallback(() => {
    setMapOpen(false);
    setMapChunk(() => lazyMap());
    say('The map didn’t load. Try again.');
  }, [say]);
  useFocusWhenShut(mapOpen, mapRef);

  // "Can't go there" stays until the next try, so nobody misses it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !blocked) return;
    const clear = () => setBlocked(null);
    map.addEventListener('pointerdown', clear, { once: true, passive: true });
    return () => map.removeEventListener('pointerdown', clear);
  }, [blocked]);

  /** The other players' chunk, or why there's no joining yet. */
  const multiplayer = () => {
    const loaded = multiplayerRef.current;
    if (!loaded) throw new Error('Still connecting. Try again in a moment.');
    return loaded;
  };
  /** The view goes to a place to look at it; the pill then offers to walk there. */
  const see = useCallback((name: string, x: number, z: number) => {
    setLooking({ name, x, z });
    viewerRef.current?.lookAt(x, z);
  }, []);
  /** A place or room chosen in the menu: the menu shuts and the view goes there. */
  const seeFromMenu = useCallback(
    ({ name, x, z }: { name: string; x: number; z: number }) => {
      closeMenu();
      sound.tap();
      see(name, x, z);
    },
    [closeMenu, see],
  );
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
  const roomPlaces = useMemo(() => ({ list: rooms, go: seeFromMenu }), [rooms, seeFromMenu]);
  const commandState: CommandState = useMemo(
    () => ({
      ride,
      door,
      running,
      routing,
      soundOn,
      time,
      passing,
      minimap,
      signedIn: account.signedIn,
      keys,
      mod,
    }),
    [ride, door, running, routing, soundOn, time, passing, minimap, account.signedIn, keys, mod],
  );
  // Places by name: choosing one takes the view there, down to the street; you walk there.
  const places = useMemo(
    () => (placeCity ? { city: placeCity, go: seeFromMenu } : undefined),
    [placeCity, seeFromMenu],
  );

  // A pill goes once its bike, building or route does, the minimap when it's hidden. Pressed or
  // focused, it had focus, which would fall to the page and take the keys with it: back to the map.
  const shownControls = ready
    ? Number(!!ride) + Number(!!door) + Number(routing) + Number(!!looking)
    : 0;
  const hadControls = useRef(0);
  useEffect(() => {
    if (shownControls < hadControls.current && document.activeElement === document.body) {
      focusQuietly(mapRef.current);
    }
    hadControls.current = shownControls;
  }, [shownControls]);

  const coaching = ready && !blocked ? coachStep(coach) : null;
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
          Where you are: a diamond over your head while the view is too far out to see you, and at
          the edge of the screen, pointing your way, when you're off it; that one takes you back.
        */}
        <button
          ref={diamondRef}
          type="button"
          className="avatar-diamond"
          aria-label="Back to you"
          hidden
          tabIndex={-1}
          onClick={() => {
            viewerRef.current?.recentre();
            // Back on screen, the avatar needs no diamond: it hides, and its focus would fall to the
            // page and take the map's keys with it.
            focusQuietly(mapRef.current);
          }}
        >
          <DiamondIcon />
        </button>
      </div>

      <header ref={headerRef} className="hud hud-top">
        {/* Where you are, once the view is close enough to show you: the only plate on screen. */}
        <StreetSign name={inside ? `${inside.room} · ${inside.floor}` : street} />
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
            {account.name && account.outfit ? (
              <>
                <span
                  className="you-dot"
                  style={{ '--shirt': css(account.outfit.shirt) } as CSSProperties}
                />
                <span className="you-name">
                  <span className="sr-only">You: </span>
                  {account.name}
                </span>
                {!account.signedIn && <span className="you-join">Join</span>}
              </>
            ) : (
              'Join'
            )}
            {online !== null && online > 1 && (
              <span className="you-count">
                <PeopleIcon />
                {online}
                <span className="sr-only"> here now</span>
              </span>
            )}
          </button>
        )}
        <Credits />
        {/*
          The hint, under the corners. Always in the page, empty when there's nothing to say, so
          changes are announced.
        */}
        <output className="hint">
          {blocked === 'far' ? (
            'Too far to tap. Open the map and choose Go here.'
          ) : blocked ? (
            'Can’t go there. Pick a street or square.'
          ) : roomsFailed ? (
            roomsFailed
          ) : avatarFailed ? (
            'Walking couldn’t load. Check your connection and try again.'
          ) : menuFailed ? (
            'The menu couldn’t load. Check your connection and try again.'
          ) : sheetFailed ? (
            'Joining couldn’t load. Check your connection and try again.'
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
          ) : coaching === 'zoom' ? (
            <>
              <span className="hint-keys">
                You’re the coral diamond. Scroll or press <kbd>+</kbd> to come down to the street.
              </span>
              <span className="hint-touch">
                You’re the coral diamond. Pinch or press + to come down to the street.
              </span>
            </>
          ) : coaching === 'walk' ? (
            <>
              <span className="hint-keys">
                <kbd>{keys.KeyW}</kbd> <kbd>{keys.KeyA}</kbd> <kbd>{keys.KeyS}</kbd>{' '}
                <kbd>{keys.KeyD}</kbd> walk, hold <kbd>Shift</kbd> to run, or click a street to go
                there.
              </span>
              <span className="hint-touch">Tap a street to walk there.</span>
            </>
          ) : coaching === 'look' ? (
            <>
              <span className="hint-keys">
                Drag to look around, hold <kbd>{keys.KeyQ}</kbd> or swipe two fingers sideways to
                turn, and <kbd>Space</kbd> comes back to you.
              </span>
              <span className="hint-touch">
                Drag to look around, and twist two fingers to turn. The map finds any street.
              </span>
            </>
          ) : null}
        </output>
      </header>

      <footer className="hud hud-bottom">
        {ready && placeCity && minimap && (
          <ChunkGuard onError={onMinimapError}>
            <Minimap
              city={placeCity}
              onOpen={() => {
                sound.tap();
                actions['open-map']();
              }}
              onReach={() => void loadMap().catch(() => {})}
            />
          </ChunkGuard>
        )}
        {/*
          By a bike or a building you can go into: what the moment offers, where a thumb finds it.
        */}
        <div className="bar">
          {ready && looking && !routing && (
            <ActionButton
              label={`Go to ${looking.name}`}
              primary
              onPress={() => {
                viewerRef.current?.navigateTo(looking.x, looking.z);
                setLooking(null);
              }}
            >
              <WalkIcon />
            </ActionButton>
          )}
          {routing && (
            <ActionButton
              label="Stop"
              shortcut="Esc"
              keys="Escape"
              onPress={() => viewerRef.current?.cancelRoute()}
            >
              <StopIcon />
            </ActionButton>
          )}
          {ready && door && (
            <ActionButton
              label={door.inside ? 'Go out' : 'Go in'}
              shortcut="↵"
              keys="Enter"
              primary={!door.inside && !(looking && !routing)}
              onPress={() => viewerRef.current?.door()}
            >
              <DoorIcon />
            </ActionButton>
          )}
          {ready && ride && (
            <ActionButton
              label={riding ? 'Get off' : 'Ride'}
              shortcut="F"
              primary={!riding && !door && !(looking && !routing)}
              onPress={() => viewerRef.current?.ride('toggle')}
            >
              <BikeIcon />
            </ActionButton>
          )}
        </div>
        {/* With the minimap hidden (H, or the menu) the map still has its way in. */}
        {ready && !minimap && (
          <button
            type="button"
            className="menu-trigger map-trigger"
            aria-label="Open the map"
            aria-haspopup="dialog"
            aria-keyshortcuts="M"
            onClick={() => {
              sound.tap();
              actions['open-map']();
            }}
            onPointerEnter={() => void loadMap().catch(() => {})}
          >
            <MapIcon />
            <span>Map</span>
            <kbd aria-hidden="true">M</kbd>
          </button>
        )}
        <div className="hud-end">
          {ready && (
            <ViewControls
              viewer={viewerRef}
              map={mapRef}
              turnHold={turnHold}
              keys={keys}
              away={away}
              figure={avatarShown}
              coachZoom={coaching === 'zoom'}
            />
          )}
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
              <span>Menu</span>
              <kbd aria-hidden="true">{mod === '⌘' ? '⌘' : 'Ctrl '}K</kbd>
            </button>
          )}
        </div>
      </footer>

      {mapOpen && placeCity && (
        <ChunkGuard onError={onMapError}>
          <MapOverlay
            city={placeCity}
            viewer={viewerRef}
            marks={marks}
            onClose={closeMap}
            onSee={see}
          />
        </ChunkGuard>
      )}

      {errorSlot ? createPortal(errorNotice, errorSlot) : errorNotice}

      {accountSheet.used && (
        <ChunkGuard onError={onSheetError}>
          <AccountSheet
            open={accountSheet.open}
            onClose={closeAccount}
            account={account}
            online={online}
            sendCode={(email) => multiplayer().sendCode(email)}
            verifyCode={(email, code) => multiplayer().verifyCode(email, code)}
            rename={(name) => multiplayer().rename(name)}
            nameFree={(name) => multiplayer().nameFree(name)}
            signOut={() =>
              multiplayer()
                .signOut()
                .then(() => say('Signed out'))
            }
            dress={(outfit) => multiplayerRef.current?.dress(outfit)}
          />
        </ChunkGuard>
      )}

      {menu.used && (
        <ChunkGuard onError={onMenuError}>
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
        </ChunkGuard>
      )}
    </main>
  );
}
