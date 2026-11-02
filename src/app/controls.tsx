import { useRef, useState } from 'react';
import type { ReactNode, Ref } from 'react';

import { sound } from '../audio/sound.ts';
import { strayPress } from './input.ts';

interface Common {
  /** The key as shown; `keys` names it for assistive tech when the two differ. */
  shortcut: string;
  keys?: string;
  /** The key is held for the same effect rather than pressed for this button: not its shortcut. */
  hold?: boolean;
  disabled: boolean;
  onPress: () => void;
  /** It plays its own sound (Mute), instead of the usual tap. */
  ownSound?: boolean;
  children: ReactNode;
}

const shortcutOf = (props: Common) => (props.hold ? undefined : (props.keys ?? props.shortcut));

/** Presses, then sounds: a soft tap, or for a toggle the way it's turning. */
function press(props: Common & { pressed?: boolean }): void {
  props.onPress();
  if (props.ownSound) return;
  if (props.pressed === undefined) sound.tap();
  else sound.toggle(!props.pressed);
}

/**
 * A pill with an icon and a visible label: the one or two things each mode is for (Walk, Start
 * here, Map). `primary` fills it with the accent; `quiet` leaves it bare, for a panel it shares
 * with something else. The shortcut shows where there's a keyboard.
 */
export function ActionButton(
  props: Common & {
    label: string;
    primary?: boolean;
    quiet?: boolean;
    /** Its action is under way (walk mode downloading). */
    busy?: boolean;
    /** About to be pressed (hovered or focused): a chance to get ready. */
    onWarm?: () => void;
  },
) {
  // Actions swap places with each other: the press that brought this one shouldn't press it too.
  const [mountedAt] = useState(() => performance.now());
  return (
    <button
      type="button"
      className={props.primary ? 'action primary' : props.quiet ? 'action quiet' : 'action'}
      aria-keyshortcuts={shortcutOf(props)}
      aria-busy={props.busy || undefined}
      disabled={props.disabled}
      onClick={(event) => {
        if (!strayPress(event.detail, performance.now() - mountedAt)) press(props);
      }}
      onPointerEnter={props.onWarm}
      onFocus={props.onWarm}
    >
      {props.children}
      <span>{props.label}</span>
      <kbd aria-hidden="true">{props.shortcut}</kbd>
    </button>
  );
}

/**
 * A round map control, the size of a thumb, named by `label`. Its name and shortcut show as a
 * tip on hover and keyboard focus; on touch, these are the map conventions people know.
 */
export function RoundButton({
  ref,
  ...props
}: Common & {
  label: string;
  /** For a toggle: whether it's on. */
  pressed?: boolean;
  /** Big (Run) shows its label, small, under the icon; the rest name themselves in the tip. */
  big?: boolean;
  /**
   * It can be held (Turn): a pointer presses it as it goes down, and this says it's let go. A
   * key or assistive tech still presses it with a click, let go at once.
   */
  onRelease?: () => void;
  ref?: Ref<HTMLButtonElement>;
}) {
  const labelled = props.big;
  const letGo = props.onRelease;
  // A pointer pressed it as it went down: the click that follows is that same press.
  const pointer = useRef(false);
  return (
    <button
      ref={ref}
      type="button"
      className={`round${props.big ? ' big' : ''}${letGo ? ' hold' : ''}`}
      aria-label={labelled ? undefined : props.label}
      aria-keyshortcuts={shortcutOf(props)}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={(event) => {
        if (pointer.current && event.detail) pointer.current = false;
        else {
          press(props);
          letGo?.();
        }
      }}
      onPointerDown={
        letGo &&
        ((event) => {
          if (event.button) return;
          pointer.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          press(props);
        })
      }
      onPointerUp={letGo}
      onPointerCancel={letGo}
      onLostPointerCapture={letGo}
      // A long press is a hold, not a call for the context menu.
      onContextMenu={letGo && ((event) => event.preventDefault())}
    >
      {props.children}
      {labelled && <span className="round-label">{props.label}</span>}
      <span className="tip" aria-hidden="true">
        {labelled ? (props.hold ? 'Hold' : 'Press') : props.label} <kbd>{props.shortcut}</kbd>
      </span>
    </button>
  );
}
