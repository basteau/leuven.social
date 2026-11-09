/**
 * Guests: anyone not signed in is on the map as themselves. Who a guest is lives only in a signed,
 * HttpOnly cookie holding a random id: the name and look are worked out from that id, so the page
 * can't choose either, the same browser is the same guest across reloads and tabs, and nothing is
 * stored for them. No row, no clean-up: a guest ends when the cookie expires, 30 days after their
 * last visit. The hub (world.ts) keeps online guests' names unique and remembers, for a few
 * minutes, where one left.
 */

import { randomOutfit } from './outfit.ts';
import type { Account } from './world.ts';

const COOKIE = 'leuven_guest';
const MAX_AGE = 60 * 60 * 24 * 30;
/** 128 bits of id, 256 of its HMAC, in hex. */
const SHAPE = /^[0-9a-f]{32}\.[0-9a-f]{64}$/;

const ADJECTIVES = [
  'Sunny',
  'Merry',
  'Quiet',
  'Brave',
  'Gentle',
  'Jolly',
  'Lucky',
  'Swift',
  'Calm',
  'Bright',
  'Cosy',
  'Witty',
  'Kind',
  'Bold',
  'Mellow',
  'Rosy',
  'Sleepy',
  'Breezy',
  'Golden',
  'Silver',
  'Nimble',
  'Plucky',
  'Cheery',
  'Dapper',
  'Happy',
  'Proud',
  'Shy',
  'Snug',
  'Warm',
  'Wise',
  'Zesty',
  'Frisky',
];
const ANIMALS = [
  'Otter',
  'Fox',
  'Heron',
  'Swan',
  'Owl',
  'Hare',
  'Badger',
  'Robin',
  'Wren',
  'Finch',
  'Stork',
  'Duck',
  'Goose',
  'Beaver',
  'Mole',
  'Lynx',
  'Seal',
  'Crow',
  'Magpie',
  'Deer',
  'Lamb',
  'Pony',
  'Moose',
  'Lark',
  'Newt',
  'Toad',
  'Carp',
  'Trout',
  'Pike',
  'Perch',
  'Dove',
  'Kite',
];

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const unhex = (text: string) =>
  Uint8Array.from({ length: text.length / 2 }, (_, i) =>
    Number.parseInt(text.slice(i * 2, i * 2 + 2), 16),
  );

/** A little generator seeded from the id, so one guest always rolls the same look. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const part = (id: string, from: number) => Number.parseInt(id.slice(from, from + 8), 16);

/**
 * "Guest Sunny Otter": the word says what it is, and the spaces mean it can never be an account's
 * name (`isUsername` in src/net/rules.ts has none).
 */
export function guestName(id: string): string {
  return `Guest ${ADJECTIVES[part(id, 0) % ADJECTIVES.length]} ${ANIMALS[part(id, 8) % ANIMALS.length]}`;
}

/** Who a guest id is, for the hub. */
export function guestAccount(id: string): Account {
  return {
    userId: guestKey(id),
    name: guestName(id),
    outfit: randomOutfit(seeded(part(id, 16))),
    guest: true,
  };
}

export const guestKey = (id: string): string => `guest:${id}`;

export interface Guests {
  /** The guest id in a request's valid cookie, or null: one never signed by us counts as none. */
  read(request: Request): Promise<string | null>;
  /** A new guest id. */
  mint(): string;
  /** The `Set-Cookie` value for a guest id. */
  cookie(id: string): Promise<string>;
}

const message = (id: string) => new TextEncoder().encode(`guest:${id}`);

export function createGuests(secret: string, secure: boolean): Guests {
  const key = crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  const attributes = `Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

  return {
    async read(request) {
      const value = request.headers
        .get('cookie')
        ?.split(/;\s*/)
        .find((pair) => pair.startsWith(`${COOKIE}=`))
        ?.slice(COOKIE.length + 1);
      if (!value || !SHAPE.test(value)) return null;
      const [id, signature] = value.split('.') as [string, string];
      const valid = await crypto.subtle.verify('HMAC', await key, unhex(signature), message(id));
      return valid ? id : null;
    },
    mint: () => hex(crypto.getRandomValues(new Uint8Array(16))),
    async cookie(id) {
      const signature = await crypto.subtle.sign('HMAC', await key, message(id));
      return `${COOKIE}=${id}.${hex(new Uint8Array(signature))}; ${attributes}`;
    },
  };
}
