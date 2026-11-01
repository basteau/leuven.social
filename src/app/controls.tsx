import type { ReactNode, Ref } from 'react';

import { sound } from '../audio/sound.ts';

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
  return (
    <button
      type="button"
      className={props.primary ? 'action primary' : props.quiet ? 'action quiet' : 'action'}
      aria-keyshortcuts={shortcutOf(props)}
      aria-busy={props.busy || undefined}
      disabled={props.disabled}
      onClick={() => press(props)}
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
  ref?: Ref<HTMLButtonElement>;
}) {
  const labelled = props.big;
  return (
    <button
      ref={ref}
      type="button"
      className={props.big ? 'round big' : 'round'}
      aria-label={labelled ? undefined : props.label}
      aria-keyshortcuts={shortcutOf(props)}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={() => press(props)}
    >
      {props.children}
      {labelled && <span className="round-label">{props.label}</span>}
      <span className="tip" aria-hidden="true">
        {labelled ? (props.hold ? 'Hold' : 'Press') : props.label} <kbd>{props.shortcut}</kbd>
      </span>
    </button>
  );
}
