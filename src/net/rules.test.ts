import { expect, test } from 'bun:test';

import {
  MAX_EMAIL,
  isEmail,
  isPlace,
  isReservedName,
  isUsername,
  mailbox,
  normaliseEmail,
} from './rules.ts';

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

test('only what can stand unquoted counts as an address', () => {
  for (const bad of [
    'foo<real@evil.example>',
    'a,b@x.example',
    'x;y@z.example',
    '"q"@x.example',
    'x\u0000y@z.example',
    'x@[127.0.0.1]',
  ]) {
    expect(isEmail(bad)).toBe(false);
  }
  expect(isEmail('müller@voorbeeld.be')).toBe(true);
});

test('a plus-tag is the same mailbox', () => {
  expect(mailbox('anna+leuven@example.com')).toBe('anna@example.com');
  expect(mailbox('anna@example.com')).toBe('anna@example.com');
});

test('the names of those who run the place are taken, whatever their case', () => {
  expect(isReservedName('Admin')).toBe(true);
  expect(isReservedName('Bram')).toBe(false);
});
