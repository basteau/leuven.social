import { useState } from 'react';
import type { ReactNode } from 'react';

import { sound } from '../audio/sound.ts';
import { strayPress } from './input.ts';

/**
 * A pill with an icon and a visible label, for the one thing the moment offers that the menu
 * would hide too well (Ride by a bike, Get off on one). `primary` fills it with the accent. The
 * shortcut shows where there's a keyboard.
 */
export function ActionButton(props: {
  label: string;
  /** The key as shown; `keys` names it for assistive tech when the two differ. */
  shortcut?: string;
  keys?: string;
  primary?: boolean;
  disabled?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  // It appears where the map was just tapped: the tap that brought it shouldn't press it too.
  const [mountedAt] = useState(() => performance.now());
  return (
    <button
      type="button"
      className={props.primary ? 'action primary' : 'action'}
      aria-keyshortcuts={props.keys ?? props.shortcut}
      disabled={props.disabled}
      // A mouse press leaves focus on the map: focused, a pill that relabels (Ride, then Get off)
      // would take the Space meant to bring the view back.
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        if (strayPress(event.detail, performance.now() - mountedAt)) return;
        props.onPress();
        sound.tap();
      }}
    >
      {props.children}
      <span>{props.label}</span>
      {props.shortcut && <kbd aria-hidden="true">{props.shortcut}</kbd>}
    </button>
  );
}
