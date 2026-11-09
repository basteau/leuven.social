/**
 * Everything the app can do, as the menu lists it: what each command is called at the moment
 * (on foot or on a bike), the keys that do the same, and what it runs. Pure, so the menu stays a
 * thin view of it. There are no modes: the map is the camera far from the avatar.
 */

import { PRESETS, nextPreset } from '../scene/daylight.ts';
import type { PresetId } from '../scene/daylight.ts';
import type { RideState } from '../scene/viewer.ts';
import type { Keycaps } from './input.ts';

/** What the app does when a command runs; the shell maps each to the viewer or its own state. */
export type ActionId =
  | 'recentre'
  | 'door'
  | 'zoom-in'
  | 'zoom-out'
  | 'turn-left'
  | 'turn-right'
  | 'reset'
  | 'run'
  | 'ride'
  | 'bell'
  | 'open-map'
  | 'stop-route'
  | 'sound'
  | 'time'
  | 'pass-time'
  | 'minimap'
  | 'account'
  | 'help'
  | 'about';

export type GroupId = 'walk' | 'map' | 'view' | 'general' | 'places' | 'keys';

export const GROUPS: Record<GroupId, string> = {
  walk: 'You',
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
  | 'map'
  | 'person'
  | 'sound-on'
  | 'sound-off'
  | 'sun'
  | 'moon'
  | 'clock'
  | 'keys'
  | 'info'
  | 'place'
  | 'map'
  | 'stop';

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
  ride: RideState;
  /** A building you can go into beside you, or the one you're in. */
  door: { room: string; inside: boolean } | null;
  running: boolean;
  /** A route to a picked spot is being walked. */
  routing: boolean;
  soundOn: boolean;
  /** The time of day on the map, and whether the day is passing by itself. */
  time: PresetId;
  passing: boolean;
  /** Whether the minimap shows in its corner. */
  minimap: boolean;
  /** Whether you're signed in: you can change your look, or join. */
  signedIn: boolean;
  keys: Keycaps;
  /** The menu's chord on this platform: ⌘ or Ctrl. */
  mod: string;
}

const view = (s: CommandState): Command[] => [
  {
    id: 'zoom-in',
    group: 'view',
    label: 'Zoom in',
    detail: 'Down to the street',
    keywords: 'zoom in closer bigger magnify street',
    keys: [['+']],
    icon: 'plus',
    action: 'zoom-in',
  },
  {
    id: 'zoom-out',
    group: 'view',
    label: 'Zoom out',
    detail: 'Out over the centre of the city',
    keywords: 'zoom out further smaller overview map city',
    keys: [['−']],
    icon: 'minus',
    action: 'zoom-out',
  },
  {
    id: 'turn-left',
    group: 'view',
    label: 'Turn left',
    detail: 'Turn the map a quarter',
    keywords: 'rotate turn view left anticlockwise',
    keys: [[s.keys.KeyQ]],
    icon: 'turn-left',
    action: 'turn-left',
  },
  {
    id: 'turn-right',
    group: 'view',
    label: 'Turn right',
    detail: 'Turn the map a quarter',
    keywords: 'rotate turn view right clockwise',
    keys: [[s.keys.KeyE]],
    icon: 'turn-right',
    action: 'turn-right',
  },
  {
    id: 'reset',
    group: 'view',
    label: 'North up',
    detail: 'North at the top, back to you',
    keywords: 'north up compass reset home centre center default',
    keys: [['R']],
    icon: 'compass',
    action: 'reset',
  },
  {
    id: 'minimap',
    group: 'view',
    label: 'Minimap',
    detail: s.minimap ? 'The streets round you, in the corner' : 'Hidden',
    keywords: 'minimap map overview radar corner where others players',
    keys: [['H']],
    icon: 'map',
    on: s.minimap,
    action: 'minimap',
  },
];

const yours = (s: CommandState): Command[] => {
  const riding = s.ride === 'riding';
  return [
    {
      id: 'recentre',
      group: 'walk',
      label: 'Back to you',
      detail: 'The view follows you again',
      keywords: 'me you find centre center recentre follow where am i back home avatar',
      keys: [['Space']],
      icon: 'pin',
      action: 'recentre',
    },
    ...(s.routing
      ? [
          {
            id: 'stop-route',
            group: 'walk',
            label: 'Stop navigating',
            detail: 'Let go of the route; or press Esc',
            keywords: 'stop cancel navigation navigating route walking destination',
            keys: [['Esc']],
            icon: 'stop',
            action: 'stop-route',
          } satisfies Command,
        ]
      : []),
    {
      id: 'account',
      group: 'walk',
      label: s.signedIn ? 'Your look' : 'Join Leuven',
      detail: s.signedIn
        ? 'Your colours, as everyone sees them; or sign out'
        : 'A name and a password, to walk with everyone else',
      keywords:
        'account join sign in up log in out register name password look clothes colours outfit dress avatar shirt hair skin multiplayer players',
      keys: [['L']],
      icon: 'person',
      action: 'account',
    },
    ...(s.door
      ? [
          {
            id: 'door',
            group: 'walk',
            label: s.door.inside ? `Leave ${s.door.room}` : `Go into ${s.door.room}`,
            detail: s.door.inside ? 'Back out to its door' : 'In through its door',
            keywords: 'enter go in inside out leave exit door building room church',
            keys: [['↵']],
            icon: 'place',
            action: 'door',
          } satisfies Command,
        ]
      : []),
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

/** A preset's name, for the menu. */
const timeLabel = (id: PresetId) => PRESETS.find((p) => p.id === id)!.label;

const general = (s: CommandState): Command[] => [
  {
    id: 'open-map',
    group: 'places',
    label: 'Open the map',
    detail: 'Find any street, and go there',
    keywords: 'map full city overview gps waypoint waypoints marks pins navigate atlas',
    keys: [['M']],
    icon: 'map',
    action: 'open-map',
  },
  {
    id: 'time',
    group: 'general',
    label: 'Time of day',
    detail: `${timeLabel(s.time)} now; next, ${timeLabel(nextPreset(s.time)).toLowerCase()}`,
    keywords: 'time day night light sun moon dusk dawn morning midday golden hour evening dark',
    keys: [['T']],
    icon: s.time === 'night' || s.time === 'dusk' ? 'moon' : 'sun',
    action: 'time',
  },
  {
    id: 'pass-time',
    group: 'general',
    label: 'Let the day pass',
    detail: s.passing ? 'A day every three minutes' : 'The light stands still',
    keywords: 'time pass day cycle animate clock sunset sunrise play pause',
    keys: [['P']],
    icon: 'clock',
    on: s.passing,
    action: 'pass-time',
  },
  {
    id: 'sound',
    group: 'general',
    label: s.soundOn ? 'Mute' : 'Unmute',
    detail: s.soundOn ? 'Sound is on' : 'Sound is off',
    keywords: 'sound audio mute unmute volume quiet',
    keys: [['N']],
    icon: s.soundOn ? 'sound-on' : 'sound-off',
    action: 'sound',
  },
  {
    id: 'help',
    group: 'general',
    label: 'Controls and keys',
    detail: 'Keys and gestures, on foot, on a bike and on touch',
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
  return [...yours(state), ...view(state), ...general(state)];
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

/** Every key and gesture, by what they move: the menu's Keys group and its Controls page. */
export function keySheet(k: Keycaps, mod: string): KeySection[] {
  return [
    {
      id: 'map',
      title: 'The map',
      rows: [
        { what: 'Look around', keys: [['Drag']], touch: 'Drag' },
        {
          what: 'Zoom, down to the street',
          keys: [['+', '−']],
          touch: 'Pinch, or + and −',
        },
        { what: 'Turn the map', keys: [[k.KeyQ, k.KeyE]], touch: 'The turn buttons' },
        { what: 'North up, back to you', keys: [['R']], touch: 'The compass' },
        { what: 'Show or hide the minimap', keys: [['H']], touch: 'From this menu' },
        { what: 'Join, or change your look', keys: [['L']], touch: 'The button at the top' },
      ],
    },
    {
      id: 'walk',
      title: 'On foot',
      rows: [
        { what: 'Walk', keys: [[k.KeyW, k.KeyA, k.KeyS, k.KeyD]], touch: 'Tap where to go' },
        { what: 'Run', keys: [['Shift']], touch: 'From this menu' },
        { what: 'Walk to a spot nearby', keys: [['Click']], touch: 'Tap it' },
        { what: 'Go into a building beside you, or out', keys: [['↵']], touch: 'Go in' },
        { what: 'Stop the route', keys: [['Esc']], touch: 'The Stop button' },
        { what: 'Back to you', keys: [['Space']], touch: 'The target button' },
      ],
    },
    {
      id: 'ride',
      title: 'On a bike',
      rows: [
        { what: 'Get on or off', keys: [['F']], touch: 'The Ride button, by a bike' },
        { what: 'Ride', keys: [[k.KeyW, k.KeyA, k.KeyS, k.KeyD]], touch: 'Tap where to go' },
        { what: 'Sprint', keys: [['Shift']] },
        { what: 'Ring the bell', keys: [['B']] },
      ],
    },
    {
      id: 'any',
      title: 'Anywhere',
      rows: [
        { what: 'Open this menu', keys: [[mod, 'K'], ['/']], touch: 'The Menu button' },
        { what: 'Controls and keys', keys: [['?']] },
        { what: 'Open the map', keys: [['M']], touch: 'The minimap' },
        { what: 'Mute or unmute', keys: [['N']] },
        { what: 'Next time of day', keys: [['T']] },
        { what: 'Let the day pass, or hold it', keys: [['P']] },
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
