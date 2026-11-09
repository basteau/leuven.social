import * as Accounts from '../net/account.ts';
import type { Me } from '../net/account.ts';
import { createPeople } from '../net/people.ts';
import type { Roster } from '../net/people.ts';
import { connectPresence } from '../net/presence.ts';
import type { Identity, Presence, PresenceStatus } from '../net/presence.ts';
import type { Outfit, PlayerState } from '../net/protocol.ts';
import { isPlace } from '../net/rules.ts';
import type { Viewer } from '../scene/viewer.ts';
import type { Account } from './account-sheet.tsx';
import { live } from './live.ts';

/**
 * The map with other people on it: your account (who you are and how you look), the presence
 * socket (everyone else, live), and the roster the viewer draws them from, smoothed a moment
 * behind the network. Its own chunk, loaded once the map is up; the shell only sees `Account`.
 */

/** A look is saved this long after the last change (ms): a few taps on swatches, one request. */
const SAVE_AFTER_MS = 600;
/** How often the minimap hears the others moved (ms). */
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

export function startMultiplayer(viewer: Viewer, hooks: MultiplayerHooks): Multiplayer {
  let account: Account = { signedIn: false };
  /** A new account yet to choose its name, and whether sign-in codes can be sent: as `me` said. */
  let fresh = false;
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
  const people = createPeople();
  const listeners = new Set<() => void>();
  let saving: ReturnType<typeof setTimeout> | undefined;
  /** A look chosen but not saved yet, and the save under way: one at a time, in order. */
  let unsaved: Outfit | null = null;
  let saved: Promise<void> = Promise.resolve();
  /** How many are on the map, as the server last said; it knows those we don't hear of too. */
  let onlineCount = 0;
  /** The next frame's run of the listeners, once it is asked for. */
  let newsFrame: number | undefined;
  /** The last time the minimap was told about the others (ms). */
  let minimapAt = 0;
  /** How many were known when the online count was last worked out. */
  let toldCount = 0;
  /** The wait before everyone frozen by a dropped connection goes. */
  let goneFor: ReturnType<typeof setTimeout> | undefined;
  /** Where the map looks: said again as soon as there is a socket to say it on. */
  let lookingAt: [number, number, number] | null = null;
  /** Bumped by every sign-in: an answer to an older question about who you are is stale. */
  let asked = 0;
  let disposed = false;

  /** Tells whoever listens, at most once a frame, that someone moved or came or went. */
  const news = () => {
    if (newsFrame !== undefined) return;
    newsFrame = requestAnimationFrame(() => {
      newsFrame = undefined;
      for (const listener of listeners) listener();
      if (people.count !== toldCount) tell();
      const now = performance.now();
      // The minimap repaints a few times a second, not on each packet.
      if (now - minimapAt > MINIMAP_MS) {
        minimapAt = now;
        live.changed();
      }
    });
  };
  const roster: Roster = {
    people,
    look(x, z, reach) {
      lookingAt = [x, z, reach];
      presence?.view(x, z, reach);
    },
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  viewer.others(roster);
  live.people = people;

  function tell(): void {
    toldCount = people.count;
    // The count comes from the server; before it has said, whoever we can see and ourselves.
    hooks.online(status === 'online' ? Math.max(onlineCount, people.count + 1) : null);
  }
  /** Everyone else off the map: a new connection's ids aren't the old one's, or the wait ran out. */
  function forget(): void {
    clearTimeout(goneFor);
    goneFor = undefined;
    if (!people.count) return;
    people.forget();
    news();
    tell();
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
      // Every connection starts with one, reconnects too, and ids change: `people` starts afresh.
      people,
      onWelcome() {
        clearTimeout(goneFor);
        goneFor = undefined;
        tell();
        news();
      },
      onIdentity(next) {
        // Let on the map after waiting unseen: the server dropped what we sent, and a figure
        // standing still wouldn't send it again.
        const letIn = identity?.unseen && !next.unseen;
        identity = next;
        apply(next);
        if (letIn && last) presence?.send(last);
      },
      onOwn(state) {
        ownAt = state;
        followAvatar();
      },
      onNews: news,
      onOnline(count) {
        onlineCount = count;
        tell();
      },
      inUse: () => document.visibilityState === 'visible' && document.hasFocus(),
      onOwnOutfit(outfit) {
        // It comes back to the tab that picked it too: worn already here, new to your other tabs
        // (unless you've since picked another, which is on its way to the server).
        if (account.signedIn && !unsaved) {
          settle({ ...account, outfit });
          wear(outfit);
        }
      },
      onStatus(next) {
        status = next;
        // Down, the others stand frozen a few seconds, in case it's only a blip, then go.
        if (next === 'online') {
          clearTimeout(goneFor);
          goneFor = undefined;
        } else if (people.count && goneFor === undefined) {
          goneFor = setTimeout(forget, FROZEN_MS);
        }
        tell();
      },
    });
    if (last) presence.send(last);
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
    // Only `Me` knows this: the socket doesn't tell a new account.
    if ('fresh' in who) fresh = who.fresh;
    settle(
      who.guest
        ? {
            signedIn: false,
            name: who.name,
            outfit: who.outfit,
            unseen: 'unseen' in who && who.unseen,
          }
        : { signedIn: true, name: who.name, outfit: who.outfit, fresh },
    );
    wear(who.outfit);
  }

  /** Draws our figure where another tab took it; while this tab is hidden, only when shown again. */
  function followAvatar(): void {
    // In a room there's no drawing it here: the street has no such spot, only a wall.
    if (!ownAt || ownAt.place || document.visibilityState !== 'visible') return;
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
      const me = await Accounts.verifyCode(email, code);
      // Only now: a wrong code must leave the first answer standing, or the tab never connects.
      asked++;
      apply(me);
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
      last = !state.place || isPlace(state.place) ? state : { ...state, place: '', floor: 0 };
      presence?.send(last);
    },
    dispose() {
      disposed = true;
      clearTimeout(rebinding);
      for (const event of CLAIMS) globalThis.removeEventListener(event, claim, CAPTURE);
      document.removeEventListener('visibilitychange', shown);
      void save(true);
      document.removeEventListener('visibilitychange', leave);
      globalThis.removeEventListener('pagehide', leave);
      presence?.close();
      // After the close, whose own status report would start this timer again.
      clearTimeout(goneFor);
      if (newsFrame !== undefined) cancelAnimationFrame(newsFrame);
      viewer.others(null);
      live.people = null;
      live.changed();
    },
  };
}
