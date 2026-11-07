/**
 * The menu: every command, key and place in one searchable list, in a modal dialog. Its own
 * chunk, loaded when the app is idle or the menu is about to open; the app shell only knows how
 * to open it (App.tsx).
 */

import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';

import { PROVIDERS } from '../data/providers.ts';
import { placesOf } from '../data/places.ts';
import type { Place } from '../data/places.ts';
import type { RoomPlace } from '../scene/viewer.ts';
import { commandsFor, GROUPS, keyCommands, keySheet } from './commands.ts';
import type { ActionId, CommandState, GroupId, IconName, Keys, KeySection } from './commands.ts';
import { BikeIcon } from './icons.tsx';
import { menuKey } from './input.ts';
import {
  BackIcon,
  BellIcon,
  CarIcon,
  ClockIcon,
  CloseIcon,
  CompassIcon,
  InfoIcon,
  KeysIcon,
  MinusIcon,
  MoonIcon,
  PinIcon,
  PlaceIcon,
  PlusIcon,
  RotateLeftIcon,
  RotateRightIcon,
  RunIcon,
  SearchIcon,
  SoundIcon,
  SunIcon,
  WalkIcon,
} from './menu-icons.tsx';
import { search } from './search.ts';

export type MenuPage = 'list' | 'help' | 'about';

export interface MenuProps {
  open: boolean;
  page: MenuPage;
  onPage: (page: MenuPage) => void;
  onClose: () => void;
  /** What was typed while the menu was on its way: its first search. */
  takeTyped: () => string;
  state: CommandState;
  run: (action: ActionId) => void;
  /** Places by name, when the viewer can put the avatar at a spot. */
  places?: { city: PlaceData; go: (place: Place) => void };
  /** The rooms inside the landmarks, once their data has come, and going inside one. */
  rooms?: { list: readonly RoomPlace[]; go: (id: string, level: number) => void };
}

type PlaceData = Parameters<typeof placesOf>[0];

/** The city's places, worked out the first time someone searches. */
const placeLists = new WeakMap<PlaceData, Place[]>();
function placesIn(city: PlaceData): Place[] {
  let list = placeLists.get(city);
  if (!list) placeLists.set(city, (list = placesOf(city)));
  return list;
}

const ICONS: Record<IconName, () => ReactNode> = {
  walk: WalkIcon,
  pin: PinIcon,
  back: BackIcon,
  run: RunIcon,
  bike: BikeIcon,
  bell: BellIcon,
  plus: PlusIcon,
  minus: MinusIcon,
  'turn-left': RotateLeftIcon,
  'turn-right': RotateRightIcon,
  compass: CompassIcon,
  'sound-on': () => <SoundIcon on />,
  'sound-off': () => <SoundIcon on={false} />,
  sun: SunIcon,
  moon: MoonIcon,
  clock: ClockIcon,
  car: CarIcon,
  keys: KeysIcon,
  info: InfoIcon,
  place: PlaceIcon,
};

/** A row of the list: a command, a key from the sheet, or a place. */
interface Row {
  id: string;
  group: GroupId;
  label: string;
  detail?: string;
  keywords?: string;
  keys: Keys;
  icon: IconName;
  on?: boolean;
  choose: () => void;
}

/** Places are many: they join the list once a query could pick a few, and only the best. */
const PLACE_QUERY = 2;
const PLACES_SHOWN = 6;

/** Keycaps side by side, alternatives apart. */
export function KeyCaps({ keys }: { keys: Keys }) {
  return (
    <span className="keycaps">
      {keys.map((combo, i) => (
        <Fragment key={combo.join()}>
          {i > 0 && <span className="keycaps-or">or</span>}
          {combo.map((cap) => (
            <kbd key={cap}>{cap}</kbd>
          ))}
        </Fragment>
      ))}
    </span>
  );
}

export function CommandMenu(props: MenuProps) {
  const { open, page, state } = props;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  // Only keys scroll the list to the active row; a pointer is already where it's looking.
  const scrollToActive = useRef(false);
  const uid = useId();

  const sheet = useMemo(() => keySheet(state.keys, state.mod), [state.keys, state.mod]);
  const rows = useMemo((): Row[] => {
    const choose = (action: ActionId) => () => {
      if (action === 'help' || action === 'about') props.onPage(action);
      else props.run(action);
    };
    const commands = [...commandsFor(state), ...keyCommands(sheet)].map((c): Row =>
      Object.assign(c, { choose: choose(c.action) }),
    );
    // The few rooms are always listed: going inside is something to find without knowing a name.
    const rooms = (props.rooms?.list ?? []).flatMap((room) =>
      room.floors.map(({ level, name }): Row => ({
        id: `room-${room.id}-${level}`,
        group: 'places',
        label: level ? `${room.name}, ${name.toLowerCase()}` : `Inside ${room.name}`,
        detail: level ? 'Up the stair inside' : 'Go in through its door',
        keywords: `inside room interior enter go in church building floor upstairs ${name}`,
        keys: [],
        icon: 'place',
        choose: () => props.rooms?.go(room.id, level),
      })),
    );
    if (!props.places || query.trim().length < PLACE_QUERY) return [...commands, ...rooms];
    const { go, city } = props.places;
    const places = placesIn(city).map((place): Row => ({
      id: `place-${place.name}`,
      group: 'places',
      label: place.name,
      detail: place.kind === 'square' ? 'Square · go there' : 'Street · go there',
      keywords: place.kind,
      keys: [],
      icon: 'place',
      choose: () => go(place),
    }));
    return [...commands, ...rooms, ...places];
    // props.run and props.onPage are the shell's stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, sheet, query, props.places, props.rooms]);

  const groups = useMemo(
    () =>
      search(rows, query).map((g) =>
        g.id === 'places' ? { id: g.id, items: g.items.slice(0, PLACES_SHOWN) } : g,
      ),
    [rows, query],
  );
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const current = flat[Math.min(active, flat.length - 1)];
  const optionId = (row: Row) => `${uid}-${row.id}`;

  // Open and close the native dialog, which traps focus and closes on Escape. It would give focus
  // back to what opened it; the shell gives it to the map instead.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setQuery(props.takeTyped());
      setActive(0);
      dialog.showModal();
    } else if (!open && dialog.open) dialog.close();
    // takeTyped is the shell's stable callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The dialog's own events, heard natively (React doesn't pass on every `close`): the chord
  // that opened it closes it, so does a click on the backdrop, which lands on the dialog itself
  // (the panel fills the rest of it), if it began there too (one that only ends there may be a
  // drag out of the search, selecting what was typed); Escape steps back from a page to the list
  // first; and the shell hears of every close at once, however it came (Chrome holds the `close`
  // event for the next rendering, which a hidden page never reaches).
  const latest = useRef({ page, onPage: props.onPage, onClose: props.onClose });
  useEffect(() => {
    latest.current = { page, onPage: props.onPage, onClose: props.onClose };
  });
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const shut = () => {
      dialog.close();
      latest.current.onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (menuKey(event) !== 'chord') return;
      event.preventDefault();
      if (!event.repeat) shut(); // held, the chord that opened it mustn't close it
    };
    let pressedBackdrop = false;
    const onPointerDown = (event: PointerEvent) => {
      pressedBackdrop = event.target === dialog;
    };
    const onClick = (event: MouseEvent) => {
      if (event.target === dialog && pressedBackdrop) shut();
    };
    const onCancel = (event: Event) => {
      if (latest.current.page === 'list') return latest.current.onClose(); // it closes itself
      event.preventDefault();
      latest.current.onPage('list');
    };
    const onClose = () => latest.current.onClose();
    dialog.addEventListener('keydown', onKey);
    dialog.addEventListener('pointerdown', onPointerDown);
    dialog.addEventListener('click', onClick);
    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('close', onClose);
    return () => {
      dialog.removeEventListener('keydown', onKey);
      dialog.removeEventListener('pointerdown', onPointerDown);
      dialog.removeEventListener('click', onClick);
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('close', onClose);
    };
  }, []);

  // Into the search on a keyboard; on touch the panel, so the keyboard doesn't cover the list.
  useEffect(() => {
    if (!open) return;
    const coarse = matchMedia('(pointer: coarse)').matches;
    if (page === 'list' && !coarse) inputRef.current?.focus();
    else panelRef.current?.focus();
  }, [open, page]);

  useEffect(() => {
    if (!scrollToActive.current || !current) return;
    scrollToActive.current = false;
    document.getElementById(optionId(current))?.scrollIntoView({ block: 'nearest' });
    // optionId only reads the stable id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const close = () => {
    dialogRef.current?.close();
    props.onClose();
  };
  const move = (to: number) => {
    if (!flat.length) return;
    scrollToActive.current = true;
    setActive((to + flat.length) % flat.length);
  };

  const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const at = Math.min(active, flat.length - 1);
    const step: Record<string, () => void> = {
      ArrowDown: () => move(at + 1),
      ArrowUp: () => move(at - 1),
      PageDown: () => move(Math.min(at + 5, flat.length - 1)),
      PageUp: () => move(Math.max(at - 5, 0)),
      Enter: () => current?.choose(),
    };
    const handle = step[event.key];
    if (!handle || event.nativeEvent.isComposing) return;
    event.preventDefault();
    handle();
  };

  const results = query.trim()
    ? flat.length === 1
      ? '1 result'
      : flat.length
        ? `${flat.length} results`
        : 'No results'
    : '';

  return (
    <dialog ref={dialogRef} className="menu" aria-labelledby={`${uid}-title`}>
      <div ref={panelRef} className="menu-panel" tabIndex={-1}>
        <header className="menu-head">
          {page === 'list' ? (
            <>
              <h2 id={`${uid}-title`} className="sr-only">
                Menu
              </h2>
              <SearchIcon />
              <input
                ref={inputRef}
                className="menu-search"
                type="text"
                role="combobox"
                aria-label="Search commands, keys and places"
                aria-expanded="true"
                aria-controls={`${uid}-list`}
                aria-autocomplete="list"
                aria-activedescendant={current ? optionId(current) : undefined}
                // Short enough for a 320px phone; the label says what's searched.
                placeholder="Search everything…"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                enterKeyHint="go"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                  scrollToActive.current = true;
                }}
                onKeyDown={onSearchKey}
              />
            </>
          ) : (
            <>
              <button
                type="button"
                className="menu-icon-button"
                aria-label="Back to the menu"
                onClick={() => props.onPage('list')}
              >
                <BackIcon />
              </button>
              <h2 id={`${uid}-title`} className="menu-title">
                {page === 'help' ? 'Controls and keys' : 'About'}
              </h2>
            </>
          )}
          <button type="button" className="menu-close" aria-label="Close menu" onClick={close}>
            <kbd aria-hidden="true">Esc</kbd>
            <CloseIcon />
          </button>
        </header>

        <div className="menu-body">
          {page === 'list' ? (
            <>
              {/*
                A combobox's list (the ARIA pattern): <select> and <datalist> can't hold rows with
                icons, details and keys, nor take aria-activedescendant from a search box.
              */}
              {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role */}
              <div role="listbox" id={`${uid}-list`} aria-label="Commands" className="menu-list">
                {groups.map((group) => (
                  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- an <optgroup> needs a <select>
                  <div key={group.id} role="group" aria-labelledby={`${uid}-g-${group.id}`}>
                    <div id={`${uid}-g-${group.id}`} role="presentation" className="menu-group">
                      {GROUPS[group.id as GroupId]}
                    </div>
                    {group.items.map((row) => {
                      const Icon = ICONS[row.icon];
                      const selected = row === current;
                      return (
                        // Keys reach the options through the search box (aria-activedescendant),
                        // so a click keeps focus there; an <option> needs a <select>.
                        // oxlint-disable-next-line jsx-a11y/click-events-have-key-events
                        <div
                          key={row.id}
                          id={optionId(row)}
                          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
                          role="option"
                          tabIndex={-1}
                          aria-selected={selected}
                          className="menu-option"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={row.choose}
                          onPointerMove={() => {
                            if (!selected) setActive(flat.indexOf(row));
                          }}
                        >
                          <span className="menu-option-icon">
                            <Icon />
                          </span>
                          <span className="menu-option-text">
                            <span className="menu-option-label">
                              {row.label}
                              {row.on !== undefined && (
                                <span className="menu-state" data-on={row.on}>
                                  {row.on ? 'On' : 'Off'}
                                </span>
                              )}
                            </span>
                            {row.detail && <span className="menu-option-detail">{row.detail}</span>}
                          </span>
                          <KeyCaps keys={row.keys} />
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
              {!flat.length && (
                <p className="menu-empty">
                  Nothing called “{query.trim()}”. Try “walk”, “zoom” or “bike”.
                </p>
              )}
              <output className="sr-only">{results}</output>
            </>
          ) : page === 'help' ? (
            <Help sheet={sheet} state={state} />
          ) : (
            <About />
          )}
        </div>

        <footer className="menu-foot">
          <span>{state.ride === 'riding' ? 'On a bike' : 'On foot'}</span>
          <span className="menu-foot-keys" aria-hidden="true">
            <kbd>↑</kbd>
            <kbd>↓</kbd> move <kbd>↵</kbd> choose <kbd>Esc</kbd>{' '}
            {page === 'list' ? 'close' : 'back'}
          </span>
        </footer>
      </div>
    </dialog>
  );
}

/** Every key and gesture, what moves you now first. */
function Help({ sheet, state }: { sheet: KeySection[]; state: CommandState }) {
  const first = state.ride === 'riding' ? 'ride' : 'walk';
  const sections = sheet.toSorted((a, b) => Number(b.id === first) - Number(a.id === first));
  return (
    <div className="menu-page">
      <p className="menu-lede">
        Everything here is also in the menu: press <kbd>{state.mod}</kbd>
        <kbd>K</kbd> or <kbd>/</kbd> anywhere, or tap the menu button.
      </p>
      {sections.map((section) => (
        <section key={section.id} className="key-section" aria-labelledby={`keys-${section.id}`}>
          <h3 id={`keys-${section.id}`}>{section.title}</h3>
          <dl className="key-list">
            {section.rows.map((row) => (
              <div key={row.what} className="key-row">
                <dt>{row.what}</dt>
                <dd>
                  <KeyCaps keys={row.keys} />
                  {row.touch && <span className="key-touch">{row.touch}</span>}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

const SOURCES = [PROVIDERS.osm, PROVIDERS.grb, PROVIDERS.dhmv, PROVIDERS.ortho];

function About() {
  return (
    <div className="menu-page">
      <p className="menu-lede">
        Leuven’s historic centre as a tiny isometric city you can walk and cycle through, built in
        the browser from open data: every building’s real footprint and height, every street and
        shop.
      </p>
      <section className="key-section" aria-labelledby="about-data">
        <h3 id="about-data">Data</h3>
        <ul className="credit-list">
          {SOURCES.map((source) => (
            <li key={source.name}>
              <span>{source.credit}</span>
              <a href={source.licenceUrl}>{source.licence}</a>
            </li>
          ))}
        </ul>
      </section>
      <p className="menu-lede">
        <a href="https://github.com/basteau/leuven.social">Source code on GitHub</a>
      </p>
    </div>
  );
}
