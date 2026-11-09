import { expect, test } from 'bun:test';

import { MAX_EMAIL, isEmail, isPlace, isUsername, normaliseEmail } from './rules.ts';

test('a name is letters, digits, _, - or ., and no dot at either end', () => {
  expect(isUsername('Bram')).toBe(true);
  expect(isUsername('marie.claire_2')).toBe(true);
  expect(isUsername('ab')).toBe(false);
  expect(isUsername('a'.repeat(21))).toBe(false);
  expect(isUsername('.bram')).toBe(false);
  expect(isUsername('bram.')).toBe(false);
  expect(isUsername('ma..rie')).toBe(false);
  expect(isUsername('Sunny Otter')).toBe(false);
});

test('an address is trimmed and lowercased', () => {
  expect(normaliseEmail('  Anna@Example.COM ')).toBe('anna@example.com');
});

test('an address needs a local part, a domain and a dot, and an end', () => {
  expect(isEmail('anna@example.com')).toBe(true);
  expect(isEmail('anna+tag@sub.example.co')).toBe(true);
  expect(isEmail('anna')).toBe(false);
  expect(isEmail('anna@example')).toBe(false);
  expect(isEmail('an na@example.com')).toBe(false);
  expect(isEmail('@example.com')).toBe(false);
  expect(isEmail(`${'a'.repeat(MAX_EMAIL)}@b.co`)).toBe(false);
});

test('a room’s id is lower-case letters, digits and dashes', () => {
  expect(isPlace('sint-pieter')).toBe(true);
  expect(isPlace('Sint')).toBe(false);
  expect(isPlace('')).toBe(false);
});
