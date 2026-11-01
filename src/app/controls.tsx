import type { ReactNode, Ref } from 'react';

interface Common {
  /** The key as shown; `keys` names it for assistive tech when the two differ. */
  shortcut: string;
  keys?: string;
  /** The key is held for the same effect rather than pressed for this button: not its shortcut. */
  hold?: boolean;
  disabled: boolean;
  onPress: () => void;
  children: ReactNode;
}

const shortcutOf = (props: Common) => (props.hold ? undefined : (props.keys ?? props.shortcut));

/**
 * A pill with an icon and a visible label: the one or two things each mode is for (Walk, Start
 * here, Map). `primary` fills it with the accent; the shortcut shows where there's a keyboard.
 */
export function ActionButton(
  props: Common & {
    label: string;
    primary?: boolean;
    /** Its action is under way (walk mode downloading). */
    busy?: boolean;
    /** About to be pressed (hovered or focused): a chance to get ready. */
    onWarm?: () => void;
  },
) {
  return (
    <button
      type="button"
      className={props.primary ? 'action primary' : 'action'}
      aria-keyshortcuts={shortcutOf(props)}
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

/**
 * A round map control, the size of a thumb, named by `label`. Its name and shortcut show as a
 * tip on hover and keyboard focus; on touch, these are the map conventions people know.
 */
export function RoundButton({
  ref,
  ...props
}: Common & {
  label: string;
  /** For a toggle: whether it's on. A toggle shows its label, small, under the icon. */
  pressed?: boolean;
  big?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  const toggle = props.pressed !== undefined;
  return (
    <button
      ref={ref}
      type="button"
      className={props.big ? 'round big' : 'round'}
      aria-label={toggle ? undefined : props.label}
      aria-keyshortcuts={shortcutOf(props)}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.children}
      {toggle && <span className="round-label">{props.label}</span>}
      <span className="tip" aria-hidden="true">
        {toggle ? (props.hold ? 'Hold' : 'Press') : props.label} <kbd>{props.shortcut}</kbd>
      </span>
    </button>
  );
}
