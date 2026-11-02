/**
 * Everything the app can do, as the menu lists it: what each command is called in the mode at
 * hand, the keys that do the same, and what it runs. Pure, so the menu stays a thin view of it.
 */

import type { RideState, WalkMode } from '../scene/viewer.ts';
import type { Keycaps } from './input.ts';

/** What the app does when a command runs; the shell maps each to the viewer or its own state. */
export type ActionId =
  | 'centre'
  | 'map'
  | 'zoom-in'
  | 'zoom-out'
  | 'turn-left'
  | 'turn-right'
  | 'reset'
  | 'run'
  | 'ride'
  | 'bell'
  | 'sound'
  | 'help'
  | 'about';

export type GroupId = 'walk' | 'map' | 'view' | 'general' | 'places' | 'keys';

export const GROUPS: Record<GroupId, string> = {
  walk: 'On foot',
  map: 'Map',
  view: 'View',
  general: 'General',
  places: 'Places',
  keys: 'Keys',
};

export type IconName =
  | 'walk'
  | 'pin'
  | 'back'
  | 'run'
  | 'bike'
  | 'bell'
  | 'plus'
  | 'minus'
  | 'turn-left'
  | 'turn-right'
  | 'compass'
  | 'sound-on'
  | 'sound-off'
  | 'keys'
  | 'info'
  | 'place';

/**
 * Keys, as keycaps: each inner list is a chord or a set of keys shown side by side, and the
 * outer list holds alternatives.
 */
export type Keys = readonly (readonly string[])[];

export interface Command {
  id: string;
  group: GroupId;
  label: string;
  /** A short line under the label: what it does. */
  detail?: string;
  /** More words it answers to in search. */
  keywords?: string;
  keys: Keys;
  icon: IconName;
  /** A toggle's state: on or off now. */
  on?: boolean;
  action: ActionId;
}

export interface CommandState {
  mode: WalkMode;
  ride: RideState;
  running: boolean;
  soundOn: boolean;
  keys: Keycaps;
  /** The menu's chord on this platform: ⌘ or Ctrl. */
  mod: string;
}

const view = (s: CommandState): Command[] => {
  const walking = s.mode === 'walk';
  return [
    {
      id: 'zoom-in',
      group: 'view',
      label: walking ? 'Closer' : 'Zoom in',
      detail: walking ? 'Bring the camera closer' : undefined,
      keywords: 'zoom in closer bigger magnify',
      keys: [['+']],
      icon: 'plus',
      action: 'zoom-in',
    },
    {
      id: 'zoom-out',
      group: 'view',
      label: walking ? 'Further' : 'Zoom out',
      detail: walking ? 'Take the camera further back' : undefined,
      keywords: 'zoom out further smaller overview',
      keys: [['−']],
      icon: 'minus',
      action: 'zoom-out',
    },
    {
      id: 'turn-left',
      group: 'view',
      label: 'Turn left',
      detail: walking ? 'Turn the view an eighth' : 'Turn the map a quarter',
      keywords: 'rotate turn view left anticlockwise',
      keys: [[s.keys.KeyQ]],
      icon: 'turn-left',
      action: 'turn-left',
    },
    {
      id: 'turn-right',
      group: 'view',
      label: 'Turn right',
      detail: walking ? 'Turn the view an eighth' : 'Turn the map a quarter',
      keywords: 'rotate turn view right clockwise',
      keys: [[s.keys.KeyE]],
      icon: 'turn-right',
      action: 'turn-right',
    },
    ...(walking
      ? []
      : [
          {
            id: 'reset',
            group: 'view',
            label: 'Reset view',
            detail: 'Back over Grote Markt, north at the top',
            keywords: 'north up compass home centre center default',
            keys: [['R']],
            icon: 'compass',
            action: 'reset',
          } satisfies Command,
        ]),
  ];
};

const modeCommands = (s: CommandState): Command[] => {
  if (s.mode === 'map') {
    return [
      {
        id: 'walk',
        group: 'map',
        label: 'Walk here',
        detail: 'From the street in the middle of the view, or click any street',
        keywords: 'walk start street ground person centre center middle spawn',
        keys: [[s.keys.KeyW], ['↵']],
        icon: 'walk',
        action: 'centre',
      },
    ];
  }
  const riding = s.ride === 'riding';
  return [
    {
      id: 'map',
      group: 'walk',
      label: 'Back to the map',
      keywords: 'map back leave exit stop overview',
      keys: [['Esc']],
      icon: 'back',
      action: 'map',
    },
    ...(s.ride
      ? [
          {
            id: 'ride',
            group: 'walk',
            label: riding ? 'Get off the bike' : 'Ride the bike',
            detail: riding ? 'Leave it standing here' : 'Get on the nearest bike',
            keywords: 'bike bicycle cycle ride get on off fiets',
            keys: [['F']],
            icon: 'bike',
            action: 'ride',
          } satisfies Command,
        ]
      : []),
    {
      id: 'run',
      group: 'walk',
      label: riding ? 'Sprint' : 'Run',
      detail: riding ? 'Or hold Shift' : 'Or hold Shift while walking',
      keywords: 'run sprint fast speed toggle',
      keys: [['Shift']],
      icon: 'run',
      on: s.running,
      action: 'run',
    },
    ...(riding
      ? [
          {
            id: 'bell',
            group: 'walk',
            label: 'Ring the bell',
            keywords: 'bell ring tring',
            keys: [['B']],
            icon: 'bell',
            action: 'bell',
          } satisfies Command,
        ]
      : []),
  ];
};

const general = (s: CommandState): Command[] => [
  {
    id: 'sound',
    group: 'general',
    label: s.soundOn ? 'Mute' : 'Unmute',
    detail: s.soundOn ? 'Sound is on' : 'Sound is off',
    keywords: 'sound audio mute unmute volume quiet',
    keys: [['M']],
    icon: s.soundOn ? 'sound-on' : 'sound-off',
    action: 'sound',
  },
  {
    id: 'help',
    group: 'general',
    label: 'Controls and keys',
    detail: 'Every key and gesture, on foot, on a bike and on touch',
    keywords: 'help controls keys keyboard shortcuts touch gestures how',
    keys: [['?']],
    icon: 'keys',
    action: 'help',
  },
  {
    id: 'about',
    group: 'general',
    label: 'About and credits',
    detail: 'Built from open data by OpenStreetMap and Digitaal Vlaanderen',
    keywords: 'about credits licence license copyright attribution data osm grb source',
    keys: [],
    icon: 'info',
    action: 'about',
  },
];

/** The commands for the moment, in the order the menu lists them before anything is typed. */
export function commandsFor(state: CommandState): Command[] {
  return [...modeCommands(state), ...view(state), ...general(state)];
}

export interface KeyRow {
  what: string;
  keys: Keys;
  /** The same on a touch screen, where it differs. */
  touch?: string;
}

export interface KeySection {
  id: 'map' | 'walk' | 'ride' | 'any';
  title: string;
  rows: KeyRow[];
}

/** Every key and gesture, by mode: the menu's Keys group and its Controls page. */
export function keySheet(k: Keycaps, mod: string): KeySection[] {
  return [
    {
      id: 'map',
      title: 'On the map',
      rows: [
        { what: 'Pan', keys: [['←', '↑', '↓', '→']], touch: 'Drag' },
        { what: 'Zoom', keys: [['+', '−']], touch: 'Pinch, or scroll with a mouse' },
        { what: 'Turn the map', keys: [[k.KeyQ, k.KeyE]], touch: 'From this menu' },
        { what: 'Reset the view', keys: [['R']] },
        { what: 'Walk from any street', keys: [['Click']], touch: 'Tap it' },
        { what: 'Walk from the middle', keys: [[k.KeyW], ['↵']] },
      ],
    },
    {
      id: 'walk',
      title: 'On foot',
      rows: [
        {
          what: 'Walk',
          keys: [
            [k.KeyW, k.KeyA, k.KeyS, k.KeyD],
            ['←', '↑', '↓', '→'],
          ],
          touch: 'Left thumb',
        },
        { what: 'Run', keys: [['Shift']], touch: 'Push the stick to its rim' },
        { what: 'Look around', keys: [['Drag']], touch: 'Right thumb' },
        { what: 'Walk to a spot', keys: [['Click']], touch: 'Tap a street' },
        { what: 'Turn the view', keys: [[k.KeyQ, k.KeyE]] },
        { what: 'Closer, further', keys: [['+', '−']] },
        { what: 'Back to the map', keys: [['Esc']] },
      ],
    },
    {
      id: 'ride',
      title: 'On a bike',
      rows: [
        { what: 'Get on or off', keys: [['F']] },
        { what: 'Pedal', keys: [[k.KeyW]], touch: 'Left thumb rides where it points' },
        { what: 'Brake, then back up', keys: [[k.KeyS]], touch: 'Pull the stick back' },
        { what: 'Steer', keys: [[k.KeyA, k.KeyD]] },
        { what: 'Sprint', keys: [['Shift']], touch: 'Push the stick to its rim' },
        { what: 'Ring the bell', keys: [['B']] },
      ],
    },
    {
      id: 'any',
      title: 'Anywhere',
      rows: [
        { what: 'Open this menu', keys: [[mod, 'K'], ['/']], touch: 'The menu button' },
        { what: 'Controls and keys', keys: [['?']] },
        { what: 'Mute or unmute', keys: [['M']] },
      ],
    },
  ];
}

/** The key sheet as rows of the menu's Keys group, so a search finds keys too. */
export function keyCommands(sheet: KeySection[]): Command[] {
  return sheet.flatMap((section) =>
    section.rows.map((row) => ({
      id: `key-${section.id}-${row.what}`,
      group: 'keys' as const,
      label: row.what,
      detail: row.touch ? `${section.title} · touch: ${row.touch}` : section.title,
      keywords: 'key keys shortcut',
      keys: row.keys,
      icon: 'keys' as const,
      action: 'help' as const,
    })),
  );
}
