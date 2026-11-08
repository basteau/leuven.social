import { useEffect, useRef } from 'react';
import type { MouseEvent, ReactNode, RefObject } from 'react';

import { sound } from '../audio/sound.ts';
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

/** One button of the rail: an icon, its name for assistive tech, and a tip with its key. */
function RailButton(props: {
  label: string;
  hint: ReactNode;
  keys?: string;
  on?: boolean;
  onClick?: (event: MouseEvent) => void;
  onPointerDown?: () => void;
  onPointerUp?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="rail-btn"
      aria-label={props.label}
      aria-keyshortcuts={props.keys}
      data-on={props.on}
      onClick={props.onClick}
      onPointerDown={props.onPointerDown}
      onPointerUp={props.onPointerUp}
      onPointerCancel={props.onPointerUp}
      onPointerLeave={props.onPointerUp}
    >
      {props.children}
      <span className="tip" aria-hidden="true">
        {props.hint}
      </span>
    </button>
  );
}

/**
 * What a map needs at hand, down the end edge: a compass with the two quarter turns round it,
 * zoom, and the way back to you. Same paper and ink as everything else on the map.
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
    if (event.detail > 0) props.map.current?.focus({ focusVisible: false } as FocusOptions);
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

  /** A quarter turn: a pointer held keeps turning, as Q and E do; a key presses it once. */
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
              North up <kbd>R</kbd>
            </>
          }
          onClick={(event) => {
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
