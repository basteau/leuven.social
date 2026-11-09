import { useEffect, useRef } from 'react';
import type { MouseEvent, PointerEvent, ReactNode, RefObject } from 'react';

import { sound } from '../audio/sound.ts';
import { TAP_SLOP } from '../scene/tap.ts';
import type { Viewer } from '../scene/viewer.ts';
import {
  MinusIcon,
  NeedleIcon,
  PlusIcon,
  RotateLeftIcon,
  RotateRightIcon,
  TargetIcon,
} from './icons.tsx';
import type { Keycaps, TurnHold } from './input.ts';
import { live } from './live.ts';

/** One press of + or −: enough that four come down from the city to the street. */
const ZOOM_STEP = 1.6;
const ZOOM_MS = 140;

/** Focus handed over for the keys' sake: no ring, since no key brought it here. */
export const focusQuietly = (element: HTMLElement | null | undefined) =>
  element?.focus({ focusVisible: false } as FocusOptions);

/** One button of the rail: an icon, its name for assistive tech, and a tip with its key. */
export function RailButton(props: {
  label: string;
  hint: ReactNode;
  keys?: string;
  on?: boolean;
  expanded?: boolean;
  onClick?: (event: MouseEvent) => void;
  onPointerDown?: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerMove?: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="rail-btn"
      aria-label={props.label}
      aria-keyshortcuts={props.keys}
      aria-expanded={props.expanded}
      data-on={props.on}
      onClick={props.onClick}
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onPointerCancel={props.onPointerUp}
      onPointerLeave={props.onPointerUp}
      // No browser menu: on a Mac it opens on press and takes the release, and a turn would stick.
      onContextMenu={(event) => event.preventDefault()}
    >
      {props.children}
      <span className="tip" aria-hidden="true">
        {props.hint}
      </span>
    </button>
  );
}

/**
 * What a map needs at hand, down the end edge: a compass with a turn either side of it, zoom,
 * and the way back to you. Same paper and ink as everything else on the map.
 */
export function ViewControls(props: {
  viewer: RefObject<Viewer | null>;
  map: RefObject<HTMLElement | null>;
  turnHold: TurnHold;
  keys: Keycaps;
  /** The view has been dragged off you. */
  away: boolean;
  /** Your figure is drawn, so Back to you has no need to bring the view down to it. */
  figure: boolean;
  /** The coach is asking for this: zoom in. */
  coachZoom: boolean;
}) {
  const { viewer, turnHold, keys } = props;
  const needleRef = useRef<HTMLSpanElement>(null);
  /** Where a pointer has the compass, once it's down; `turned` once it has moved past a tap. */
  const compass = useRef({ id: -1, x: 0, x0: 0, y0: 0, turned: false });

  // The needle follows the view on its own, without a render for each turn.
  useEffect(() => {
    let was = Number.NaN;
    const point = () => {
      if (live.heading === was || !needleRef.current) return;
      was = live.heading;
      needleRef.current.style.rotate = `${-was}rad`;
    };
    point();
    return live.listen(point);
  }, []);

  /** A press with a pointer leaves the keys to the map, not on the button it pressed. */
  const pressed = (event: MouseEvent) => {
    sound.tap();
    if (event.detail > 0) focusQuietly(props.map.current);
  };

  /** Zooms over a moment, by small steps; at once with reduced motion. */
  const zoom = (event: MouseEvent, factor: number) => {
    pressed(event);
    const v = viewer.current;
    if (!v) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      v.zoomBy(factor);
      return;
    }
    let done = 0;
    const started = performance.now();
    const step = (now: number) => {
      const reached = Math.min(1, (now - started) / ZOOM_MS);
      if (reached > done) {
        v.zoomBy(factor ** (reached - done));
        done = reached;
      }
      if (reached < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  /** A turn: as long as a pointer holds it, as Q and E do; a key presses it once. */
  const turner = (direction: 1 | -1, source: string) => ({
    onPointerDown: () => turnHold.press(source, direction, viewer.current),
    onPointerUp: () => turnHold.release(source),
    onClick: (event: MouseEvent) => {
      pressed(event);
      if (event.detail === 0) viewer.current?.rotate(direction);
    },
  });

  return (
    <nav className="rail" aria-label="Map view">
      <div className="rail-group rail-turn">
        <RailButton
          label="Turn left"
          keys={keys.KeyQ}
          hint={
            <>
              Turn left <kbd>{keys.KeyQ}</kbd>
            </>
          }
          {...turner(-1, 'rail-left')}
        >
          <RotateLeftIcon />
        </RailButton>
        <RailButton
          label="North up"
          keys="R"
          hint={
            <>
              Drag to turn, or north up <kbd>R</kbd>
            </>
          }
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            const [x, y] = [event.clientX, event.clientY];
            compass.current = { id: event.pointerId, x, x0: x, y0: y, turned: false };
          }}
          onPointerMove={(event) => {
            const held = compass.current;
            if (event.pointerId !== held.id) return;
            const [x, y] = [event.clientX, event.clientY];
            if (!held.turned && Math.hypot(x - held.x0, y - held.y0) < TAP_SLOP) return;
            if (held.turned) viewer.current?.turnDrag(x - held.x);
            held.turned = true;
            held.x = x;
          }}
          onPointerUp={() => {
            compass.current.id = -1;
          }}
          onClick={(event) => {
            // The end of a drag round the compass is no press of it, and leaves the keys to the
            // map all the same. A key's press is one, whatever went before.
            const dragged = compass.current.turned && event.detail > 0;
            compass.current.turned = false;
            if (dragged) {
              focusQuietly(props.map.current);
              return;
            }
            pressed(event);
            viewer.current?.resetView();
          }}
        >
          <span ref={needleRef} className="compass-needle">
            <NeedleIcon />
          </span>
        </RailButton>
        <RailButton
          label="Turn right"
          keys={keys.KeyE}
          hint={
            <>
              Turn right <kbd>{keys.KeyE}</kbd>
            </>
          }
          {...turner(1, 'rail-right')}
        >
          <RotateRightIcon />
        </RailButton>
      </div>
      <div className="rail-group rail-zoom" data-coach={props.coachZoom || undefined}>
        <RailButton
          label="Zoom in"
          keys="+"
          hint={
            <>
              Zoom in <kbd>+</kbd>
            </>
          }
          onClick={(event) => zoom(event, ZOOM_STEP)}
        >
          <PlusIcon />
        </RailButton>
        <RailButton
          label="Zoom out"
          keys="-"
          hint={
            <>
              Zoom out <kbd>−</kbd>
            </>
          }
          onClick={(event) => zoom(event, 1 / ZOOM_STEP)}
        >
          <MinusIcon />
        </RailButton>
      </div>
      <div className="rail-group rail-find" data-away={props.away || undefined}>
        <RailButton
          label="Back to you"
          keys="Space"
          hint={
            <>
              Back to you <kbd>Space</kbd>
            </>
          }
          on={!props.away}
          onClick={(event) => {
            pressed(event);
            const v = viewer.current;
            if (v?.pinned() && !props.figure) v.comeDown();
            else v?.recentre();
          }}
        >
          <TargetIcon on={!props.away} />
        </RailButton>
      </div>
    </nav>
  );
}
