import * as Accounts from '../net/account.ts';
import type { Me } from '../net/account.ts';
import { createSnapshots } from '../net/interpolate.ts';
import type { Snapshots } from '../net/interpolate.ts';
import { connectPresence } from '../net/presence.ts';
import type { Presence, PresenceStatus } from '../net/presence.ts';
import type { Outfit, PlayerState } from '../net/protocol.ts';
import { isPlace } from '../net/rules.ts';
import type { Roster, RosterEntry, Viewer } from '../scene/viewer.ts';
import type { Account } from './account-sheet.tsx';
import { live } from './live.ts';
import { FIRST_OUTFIT } from './outfits.ts';

/**
 * The map with other people on it: your account (who you are and how you look), the presence
 * socket (everyone else, live), and the roster the viewer draws them from, smoothed a moment
 * behind the network. Its own chunk, loaded once the map is up; the shell only sees `Account`.
 */

/** A look is saved this long after the last change (ms): a few taps on swatches, one request. */
const SAVE_AFTER_MS = 600;

export interface MultiplayerHooks {
  /** Who you are now: a guest, or signed in with your name and look. */
  account(account: Account): void;
  /** How many are on the map, you included; null while the socket is down. */
  online(count: number | null): void;
}

export interface Multiplayer {
  signUp(name: string, password: string): Promise<void>;
  signIn(name: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  /** Wears a look now and saves it a moment later. */
  dress(outfit: Outfit): void;
  /** The avatar moved: the others hear of it, if you're signed in. */
  moved(state: PlayerState): void;
  dispose(): void;
}

interface Other extends RosterEntry {
  snapshots: Snapshots;
}

export function startMultiplayer(viewer: Viewer, hooks: MultiplayerHooks): Multiplayer {
  let account: Account = { signedIn: false };
  /** Where the avatar is: sent as soon as a socket opens, since others only see you once you're placed. */
  let last: PlayerState | null = null;
  let presence: Presence | null = null;
  let status: PresenceStatus = 'connecting';
  let you = 0;
  let version = 0;
  let entries: Other[] = [];
  const others = new Map<number, Other>();
  const listeners = new Set<() => void>();
  let saving: ReturnType<typeof setTimeout> | undefined;
  /** A look chosen but not saved yet, and the save under way: one at a time, in order. */
  let unsaved: Outfit | null = null;
  let saved: Promise<void> = Promise.resolve();
  /** Bumped by every sign-in or -up: an answer to an older question about who you are is stale. */
  let asked = 0;
  let disposed = false;

  const news = () => {
    for (const listener of listeners) listener();
  };
  const roster: Roster = {
    version: () => version,
    entries: () => entries,
    pose(id, now, out) {
      const state = others.get(id)?.snapshots.sample(now);
      if (!state) return false;
      Object.assign(out, state);
      return true;
    },
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  viewer.others(roster);

  /** Joins, leaves and new clothes change who's drawn; the minimap's dots follow every move. */
  function changed(people: boolean): void {
    if (people) {
      version++;
      entries = [...others.values()];
      tell();
    }
    live.others = entries.flatMap((o) => {
      const at = o.snapshots.latest();
      return at && !at.place ? [{ x: at.x, z: at.z, colour: o.outfit.shirt }] : [];
    });
    live.changed();
    news();
  }
  function tell(): void {
    hooks.online(status === 'online' ? others.size + (account.signedIn ? 1 : 0) : null);
  }
  function settle(next: Account): void {
    account = next;
    hooks.account(next);
    tell();
  }

  function connect(): void {
    presence?.close();
    others.clear();
    changed(true);
    presence = connectPresence({
      // Every connection starts with one, reconnects too, and ids change: start the others afresh.
      onWelcome(id) {
        you = id;
        if (others.size) {
          others.clear();
          changed(true);
        }
      },
      onJoin(player) {
        if (player.id === you) return;
        const snapshots = createSnapshots();
        snapshots.push(performance.now(), player.state);
        others.set(player.id, { ...player, snapshots });
        changed(true);
      },
      onLeave(id) {
        if (others.delete(id)) changed(true);
      },
      onStates(updates) {
        const now = performance.now();
        for (const { id, state } of updates) others.get(id)?.snapshots.push(now, state);
        changed(false);
      },
      onOutfit(id, outfit) {
        // Your own comes back too: you wear it already.
        const other = id === you ? undefined : others.get(id);
        if (!other) return;
        others.set(id, { ...other, outfit });
        changed(true);
      },
      onStatus(next) {
        status = next;
        // Down, the others are gone till it's back up and they join again.
        if (next !== 'online' && others.size) {
          others.clear();
          changed(true);
        }
        tell();
      },
    });
    if (account.signedIn && last) presence.send(last);
  }

  /** Signed in: wear your look, and stand where you left (on your first visit, where you are). */
  function welcome(me: Me, comeBack: boolean): void {
    settle({ signedIn: true, name: me.name, outfit: me.outfit });
    viewer.dress(me.outfit);
    if (comeBack && me.at) viewer.placeAvatar(me.at.x, me.at.z, me.at.heading);
  }

  // Who you are, once: a guest watches; an account comes back where it left.
  const first = asked;
  void Accounts.me()
    .then((me) => {
      // Signed in or up meanwhile (a password manager is quick): that answer is the one.
      if (disposed || asked !== first) return;
      if (me) welcome(me, true);
      else settle({ signedIn: false });
    })
    .catch(() => {
      if (asked === first) settle({ signedIn: false });
    })
    .finally(() => {
      if (!disposed && asked === first) connect();
    });

  /**
   * Saves the look chosen last, after any save under way, so an older look can't land last;
   * settles once it's saved (or couldn't be). Leaving the page, at once and kept alive past it.
   */
  function save(leaving = false): Promise<void> {
    clearTimeout(saving);
    saving = undefined;
    const outfit = unsaved;
    unsaved = null;
    if (!outfit) return saved;
    const send = () =>
      Accounts.saveOutfit(outfit, { leaving }).catch((error: unknown) =>
        console.warn('Your look wasn’t saved.', error),
      );
    saved = leaving ? send() : saved.then(send);
    return saved;
  }
  // A look picked a moment before the tab closes is saved all the same.
  const leave = () => {
    if (document.visibilityState === 'hidden') void save(true);
  };
  document.addEventListener('visibilitychange', leave);
  globalThis.addEventListener('pagehide', leave);

  return {
    async signUp(name, password) {
      asked++;
      const me = await Accounts.signUp(name, password);
      // A new account starts where you are, wearing the server's pick.
      welcome(me, false);
      connect();
    },
    async signIn(name, password) {
      asked++;
      const me = await Accounts.signIn(name, password);
      welcome(me, true);
      connect();
    },
    async signOut() {
      await save();
      await Accounts.signOut();
      settle({ signedIn: false });
      viewer.dress(FIRST_OUTFIT);
      connect();
    },
    dress(outfit) {
      if (!account.signedIn) return;
      settle({ ...account, outfit });
      viewer.dress(outfit);
      unsaved = outfit;
      clearTimeout(saving);
      saving = setTimeout(() => void save(), SAVE_AFTER_MS);
    },
    moved(state) {
      // A room the server wouldn't know is the street to the others, as it would be on arrival.
      last = isPlace(state.place) || !state.place ? state : { ...state, place: '', floor: 0 };
      state = last;
      if (account.signedIn) presence?.send(state);
    },
    dispose() {
      disposed = true;
      void save(true);
      document.removeEventListener('visibilitychange', leave);
      globalThis.removeEventListener('pagehide', leave);
      presence?.close();
      viewer.others(null);
      live.others = [];
      live.changed();
    },
  };
}
