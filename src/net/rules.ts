/**
 * What a name, an email address, a code and a room's id must be, checked the same way in the
 * browser (to say so before a round trip) and on the server (which decides).
 */

export const MIN_NAME = 3;
export const MAX_NAME = 20;

/** A sign-in code: how many digits, how long it works, and the wait before another. */
export const CODE_LENGTH = 6;
export const CODE_MINUTES = 10;
export const CODE_COOLDOWN_SECONDS = 30;

/** The longest address the mail standards allow. */
export const MAX_EMAIL = 254;

/**
 * Letters, digits, `_`, `-` and `.`, with no dot at either end or two in a row. No spaces, which
 * is what keeps a guest's two words from ever passing for an account's name.
 */
const NAME = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

export function isUsername(name: string): boolean {
  return name.length >= MIN_NAME && name.length <= MAX_NAME && NAME.test(name);
}

/** Names a player could pass off as the people running the place. */
const RESERVED = new Set([
  'admin',
  'administrator',
  'leuven',
  'leuven.social',
  'mod',
  'moderator',
  'official',
  'staff',
  'support',
  'system',
]);

export const isReservedName = (name: string) => RESERVED.has(name.toLowerCase());

/** What everyone types is one address: `A@b.c ` and `a@b.c` are the same person. */
export const normaliseEmail = (email: string) => email.trim().toLowerCase();

/**
 * Roughly an address: the mail server is what really decides. Only what can stand unquoted, so
 * `Name <a@b.c>` and `a,b@c.d` aren't taken for one address and passed on to the mail provider.
 */
export const isEmail = (email: string) =>
  email.length <= MAX_EMAIL &&
  /^[\p{L}\p{N}!#$%&'*+/=?^_`{|}~.-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u.test(email);

/** The mailbox behind an address: mail to `a+x@b.c` lands with `a@b.c`, so they share its limits. */
export const mailbox = (email: string) => email.replace(/\+[^@]*(?=@)/, '');

/** A room's id as a state carries it (rooms.json's ids): lower-case letters, digits and dashes. */
const PLACE = /^[a-z0-9-]{1,40}$/;

export const isPlace = (id: string) => PLACE.test(id);
