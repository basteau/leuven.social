import * as Accounts from '../net/account.ts';
import type { Me } from '../net/account.ts';
import { createSnapshots } from '../net/interpolate.ts';
import type { Snapshots } from '../net/interpolate.ts';
import { connectPresence } from '../net/presence.ts';
import type { Identity, Presence, PresenceStatus } from '../net/presence.ts';
import type { Dot, Outfit, PlayerState } from '../net/protocol.ts';
import { isPlace } from '../net/rules.ts';
import type { Roster, RosterEntry, Viewer } from '../scene/viewer.ts';
import type { Account } from './account-sheet.tsx';
import { live } from './live.ts';

/**
 * The map with other people on it: your account (who you are and how you look), the presence
 * socket (everyone else, live), and the roster the viewer draws them from, smoothed a moment
 * behind the network. Its own chunk, loaded once the map is up; the shell only sees `Account`.
 */

/** A look is saved this long after the last change (ms): a few taps on swatches, one request. */
const SAVE_AFTER_MS = 600;
/** How often the minimap's dots are written while people walk about (ms). */
const MINIMAP_MS = 250;
/** How long the others stand frozen when the connection goes down, before they go (ms). */
const FROZEN_MS = 5000;
/** How often a tab that isn't the one moving your figure redraws it where it went (ms). */
const FOLLOW_MS = 200;
/** How long a sign-in or -out has to reach this tab's socket before it is reconnected (ms). */
const REBIND_MS = 1500;
/** What makes a tab the one in use. A person, never a program: see `claim`. */
const CLAIMS = ['focus', 'pointerdown', 'keydown'] as const;
const CAPTURE = { capture: true, passive: true };

export interface MultiplayerHooks {
  /** Who you are now: a guest, or signed in, each with a name and a look. */
  account(account: Account): void;
  /** How many are on the map, you included; null while the socket is down. */
  online(count: number | null): void;
}

export interface Multiplayer {
  sendCode(email: string): Promise<void>;
  verifyCode(email: string, code: string): Promise<void>;
  rename(name: string): Promise<void>;
  nameFree(name: string): Promise<boolean | null>;
  signOut(): Promise<void>;
  /** Wears a look now and saves it a moment later. */
  dress(outfit: Outfit): void;
  /** The avatar moved: the others hear of it, if this is the tab moving your figure. */
  moved(state: PlayerState): void;
  dispose(): void;
}

interface Other extends RosterEntry {
  snapshots: Snapshots;
}

export function startMultiplayer(viewer: Viewer, hooks: MultiplayerHooks): Multiplayer {
  let account: Account = { signedIn: false };
  /** A new account yet to choose its name, and whether sign-in codes can be sent: as `me` said. */
  let fresh = false;
  let mailOff = false;
  /** What the socket last said about who we are, if it has yet. */
  let identity: Identity | null = null;
  /** The look on the avatar, to wear another only when it changed. */
  let worn: Outfit | null = null;
  /** Where our figure went, driven from another tab, and when it was last drawn there. */
  let ownAt: PlayerState | null = null;
  let followedAt = 0;
  let rebinding: ReturnType<typeof setTimeout> | undefined;
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
  /** How many are on the map, as the server last said; it knows those we don't hear of too. */
  let onlineCount = 0;
  /** Everyone on the map while the full map is open, as last told. */
  let dots: readonly Dot[] = [];
  let wantsDots = false;
  /** The last time the minimap's dots were written (ms), and the wait to go down. */
  let dotsAt = 0;
  let goneFor: ReturnType<typeof setTimeout> | undefined;
  /** Where the map looks: said again as soon as there is a socket to say it on. */
  let lookingAt: [number, number] | null = null;
  /** Bumped by every sign-in or -up: an answer to an older question about who you are is stale. */
  let asked = 0;
  let disposed = false;

  const news = () => {
    for (const listener of listeners) listener();
  };
  const roster: Roster = {
    version: () => version,
    entries: () => entries,
    pose: (id, now, out) => Boolean(others.get(id)?.snapshots.sample(now, out)),
    look(x, z) {
      lookingAt = [x, z];
      presence?.view(x, z);
    },
    dots: () => dots,
    fullMap(on) {
      wantsDots = on;
      if (!on) dots = [];
      presence?.dots(on);
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
    const now = performance.now();
    // The minimap redraws a list of a few dozen dots a few times a second, not on each packet.
    if (people || now - dotsAt > MINIMAP_MS) {
      dotsAt = now;
      live.others = entries.flatMap((o) => {
        const at = o.snapshots.latest();
        return at && !at.place ? [{ x: at.x, z: at.z, colour: o.outfit.shirt }] : [];
      });
      live.changed();
    }
    news();
  }
  function tell(): void {
    // The count comes from the server; before it has said, whoever we can see and ourselves.
    hooks.online(status === 'online' ? Math.max(onlineCount, others.size + 1) : null);
  }
  /** Down for good or a moment: the others stand frozen for a moment, then go. */
  function forget(): void {
    clearTimeout(goneFor);
    goneFor = undefined;
    if (!others.size) return;
    others.clear();
    changed(true);
  }
  function settle(next: Account): void {
    account = next;
    hooks.account(next);
    tell();
  }

  function connect(): void {
    presence?.close();
    forget();
    onlineCount = 0;
    presence = connectPresence({
      // Every connection starts with one, reconnects too, and ids change: start the others afresh.
      onWelcome(id) {
        you = id;
        forget();
      },
      onIdentity(next) {
        identity = next;
        apply(next);
      },
      onRenamed(id, name, outfit) {
        const other = others.get(id);
        if (!other) return;
        others.set(id, { ...other, name, outfit });
        changed(true);
      },
      onOwn(state) {
        ownAt = state;
        followAvatar();
      },
      onJoin(players) {
        const now = performance.now();
        for (const player of players) {
          if (player.id === you) continue;
          const snapshots = createSnapshots();
          snapshots.push(now, player.state);
          others.set(player.id, { ...player, snapshots });
        }
        changed(true);
      },
      onLeave(ids) {
        let any = false;
        for (const id of ids) any = others.delete(id) || any;
        if (any) changed(true);
      },
      onStates(updates) {
        const now = performance.now();
        for (const { id, state } of updates) others.get(id)?.snapshots.push(now, state);
        changed(false);
      },
      onOnline(count) {
        onlineCount = count;
        tell();
      },
      inUse: () => document.visibilityState === 'visible' && document.hasFocus(),
      onDots(everyone) {
        dots = everyone;
        news();
      },
      onOutfit(id, outfit) {
        // Your own comes back too: worn already here, new to your other tabs (unless you've since
        // picked another, which is on its way to the server).
        if (id === you) {
          if (account.signedIn && !unsaved) {
            settle({ ...account, outfit });
            wear(outfit);
          }
          return;
        }
        const other = others.get(id);
        if (!other) return;
        others.set(id, { ...other, outfit });
        changed(true);
      },
      onStatus(next) {
        status = next;
        // Down, the others stand frozen a few seconds, in case it's only a blip, then go.
        if (next === 'online') {
          clearTimeout(goneFor);
          goneFor = undefined;
        } else if (others.size && goneFor === undefined) {
          goneFor = setTimeout(forget, FROZEN_MS);
        }
        tell();
      },
    });
    if (last) presence.send(last);
    if (wantsDots) presence.dots(true);
    if (lookingAt) presence.view(...lookingAt);
  }

  /** Wears a look, if it isn't on already. */
  function wear(outfit: Outfit): void {
    if (worn && JSON.stringify(worn) === JSON.stringify(outfit)) return;
    worn = outfit;
    viewer.dress(outfit);
  }

  /** The server says who this tab is now: the same, whichever tab caused it. */
  function apply(who: Identity | Me): void {
    // Only `Me` knows these: the socket doesn't tell a new account or whether codes can be sent.
    if ('fresh' in who) {
      fresh = who.fresh;
      mailOff = !who.mail;
    }
    settle(
      who.guest
        ? {
            signedIn: false,
            name: who.name,
            outfit: who.outfit,
            unseen: 'unseen' in who && who.unseen,
            mailOff,
          }
        : { signedIn: true, name: who.name, outfit: who.outfit, fresh },
    );
    wear(who.outfit);
  }

  /** Draws our figure where another tab took it; while this tab is hidden, only when shown again. */
  function followAvatar(): void {
    if (!ownAt || document.visibilityState !== 'visible') return;
    const now = performance.now();
    if (now - followedAt < FOLLOW_MS) return;
    followedAt = now;
    viewer.placeAvatar(ownAt.x, ownAt.z, ownAt.heading);
  }

  /** Answered over HTTP, the socket should hear within a moment; if it can't have, connect again. */
  function expectIdentity(guest: boolean): void {
    clearTimeout(rebinding);
    rebinding = setTimeout(() => {
      if (identity?.guest !== guest) connect();
    }, REBIND_MS);
  }

  // Who you are, once: a guest or an account, each back where they were last.
  const first = asked;
  void Accounts.me()
    .then((me) => {
      // Signed in meanwhile (a code pasted in a hurry): that answer is the one.
      if (disposed || asked !== first) return;
      if (!me) return;
      apply(me);
      if (me.at) viewer.placeAvatar(me.at.x, me.at.z, me.at.heading);
    })
    .catch(() => {})
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

  // The tab you use moves your figure, and only ever a person's own hand changes that: no reply to
  // anything a server or another tab said, so two tabs can never pass it back and forth.
  const claim = () => presence?.drive();
  const shown = () => {
    if (document.visibilityState !== 'visible') return;
    followedAt = 0;
    followAvatar();
    claim();
  };
  for (const event of CLAIMS) globalThis.addEventListener(event, claim, CAPTURE);
  document.addEventListener('visibilitychange', shown);

  return {
    // Signing in and out change who your figure is on the server, so the figure and the socket
    // carry on as they are, and every tab of this browser hears it over its socket.
    sendCode: Accounts.sendCode,
    async verifyCode(email, code) {
      asked++;
      apply(await Accounts.verifyCode(email, code));
      expectIdentity(false);
    },
    async rename(name) {
      apply(await Accounts.rename(name));
    },
    nameFree: Accounts.nameFree,
    async signOut() {
      await save();
      await Accounts.signOut();
      // Signed out either way: if this question fails, the socket says who you are now.
      const me = await Accounts.me().catch(() => null);
      if (me) apply(me);
      expectIdentity(true);
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
      presence?.send(last);
    },
    dispose() {
      disposed = true;
      clearTimeout(goneFor);
      clearTimeout(rebinding);
      for (const event of CLAIMS) globalThis.removeEventListener(event, claim, CAPTURE);
      document.removeEventListener('visibilitychange', shown);
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
