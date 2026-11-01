import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { CITY_URL, loadCity } from '../data/load.ts';
import { CREDITS } from '../data/providers.ts';
import type { Viewer } from '../scene/viewer.ts';
import { ResetIcon, RotateLeftIcon, RotateRightIcon } from './icons.tsx';

type Status = { state: 'loading' } | { state: 'ready' } | { state: 'error'; message: string };

/** A stalled network must end in the retry state, never in an endless "Building Leuven…". */
const LOAD_TIMEOUT_MS = 20_000;

const CREDITS_VISIBLE_MS = 5_000;

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
  const labelsRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const [status, setStatus] = useState<Status>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const map = mapRef.current;
    const canvas = canvasRef.current;
    const labelLayer = labelsRef.current;
    if (!map || !canvas || !labelLayer) return;
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
          labelLayer,
          city,
          reducedMotion: reducedMotion() ?? false,
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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const viewer = viewerRef.current;
      if (!viewer) return;
      const actions: Record<string, () => void> = {
        q: () => viewer.rotate(-1),
        e: () => viewer.rotate(1),
        r: () => viewer.resetView(),
        '+': () => viewer.zoomBy(1.25),
        '=': () => viewer.zoomBy(1.25),
        '-': () => viewer.zoomBy(0.8),
      };
      actions[event.key.toLowerCase()]?.();
    };
    app.addEventListener('keydown', onKeyDown);
    return () => app.removeEventListener('keydown', onKeyDown);
  }, []);

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
    <main ref={appRef} className="app">
      <div
        ref={mapRef}
        className="map"
        tabIndex={0}
        role="application"
        aria-roledescription="map"
        aria-label="Map of Leuven’s centre around Grote Markt, Oude Markt and Ladeuzeplein. Drag or use the arrow keys to pan; scroll, pinch or press plus and minus to zoom; Q and E turn the view."
      >
        <canvas ref={canvasRef} className="city" />
      </div>
      <div ref={labelsRef} className="label-layer" aria-hidden="true" />

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
      </footer>
    </main>
  );
}

function ToolButton(props: {
  label: string;
  shortcut: string;
  disabled: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="button"
      aria-keyshortcuts={props.shortcut}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.children}
      <span>{props.label}</span>
      <kbd aria-hidden="true">{props.shortcut}</kbd>
    </button>
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
