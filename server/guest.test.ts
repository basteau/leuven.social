import { describe, expect, test } from 'bun:test';

import { isUsername } from '../src/net/rules.ts';
import { createGuests, guestAccount, guestKey, guestName } from './guest.ts';

const guests = createGuests('a-test-secret', false);
const withCookie = (cookie: string | null) =>
  new Request('http://localhost/', cookie ? { headers: { cookie } } : {});

const valueOf = (setCookie: string) => setCookie.split(';')[0]!;

describe('the guest cookie', () => {
  test('is signed, HttpOnly and read back', async () => {
    const id = guests.mint();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const cookie = await guests.cookie(id);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Max-Age=2592000/);
    expect(cookie).not.toMatch(/Secure/);
    expect(await guests.read(withCookie(`a=b; ${valueOf(cookie)}; c=d`))).toBe(id);
  });

  test('is Secure on an https site', async () => {
    expect(await createGuests('a-test-secret', true).cookie('00'.repeat(16))).toMatch(/; Secure/);
  });

  test('cannot be forged', async () => {
    const id = guests.mint();
    const value = valueOf(await guests.cookie(id));
    const tampered = `${value.slice(0, -1)}${value.endsWith('0') ? '1' : '0'}`;
    expect(await guests.read(withCookie(tampered))).toBeNull();
    const another = guests.mint();
    const other = valueOf(await guests.cookie(another));
    expect(await guests.read(withCookie(`leuven_guest=${id}.${other.split('.')[1]}`))).toBeNull();
    const elsewhere = await createGuests('another-secret', false).cookie(id);
    expect(await guests.read(withCookie(valueOf(elsewhere)))).toBeNull();
    expect(await guests.read(withCookie('leuven_guest=nonsense'))).toBeNull();
    expect(await guests.read(withCookie(null))).toBeNull();
  });
});

describe('who a guest is', () => {
  const id = 'c0ffee00c0ffee0012345678deadbeef';

  test('is always the same for one id', () => {
    expect(guestAccount(id)).toEqual(guestAccount(id));
    expect(guestAccount(id).guest).toBe(true);
    expect(guestAccount(id).userId).toBe(guestKey(id));
    expect(guestAccount(id).userId).toBe(`guest:${id}`);
  });

  test('is two words, and can never be an account’s name', () => {
    const name = guestName(id);
    expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(isUsername(name)).toBe(false);
  });

  test('names and looks vary', () => {
    const accounts = Array.from({ length: 64 }, () => guestAccount(guests.mint()));
    expect(new Set(accounts.map((a) => a.name)).size).toBeGreaterThan(30);
    expect(new Set(accounts.map((a) => a.outfit.shirt)).size).toBeGreaterThan(3);
  });
});
