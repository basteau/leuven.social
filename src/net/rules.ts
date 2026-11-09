/**
 * What a name, an email address, a code and a room's id must be, checked the same way in the
 * browser (to say so before a round trip) and on the server (which decides).
 */

export const MIN_NAME = 3;
export const MAX_NAME = 20;
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 128;

/** A sign-in code: how many digits, how long it works, and the wait before another. */
export const CODE_LENGTH = 6;
export const CODE_MINUTES = 10;
export const CODE_COOLDOWN_SECONDS = 30;

/** The longest address the mail standards allow. */
export const MAX_EMAIL = 254;

/**
 * Letters, digits, `_`, `-` and `.`, with no dot at either end or two in a row: the server
 * files each player under `<name>@players.invalid`, and an address can't have those dots.
 */
const NAME = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

export function isUsername(name: string): boolean {
  return name.length >= MIN_NAME && name.length <= MAX_NAME && NAME.test(name);
}

/** What everyone types is one address: `A@b.c ` and `a@b.c` are the same person. */
export const normaliseEmail = (email: string) => email.trim().toLowerCase();

/** Roughly an address: the mail server is what really decides. */
export const isEmail = (email: string) =>
  email.length <= MAX_EMAIL && /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email);

/** A room's id as a state carries it (rooms.json's ids): lower-case letters, digits and dashes. */
const PLACE = /^[a-z0-9-]{1,40}$/;

export const isPlace = (id: string) => PLACE.test(id);
