/**
 * The menu's search: forgiving about case, accents and word order, strict about every word
 * matching somewhere, and ranking the label above what's said about it. Pure.
 */

/** Lower case without accents, so "sint-pieter" finds "Sint-Pieterskerk" and "e" finds "é". */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Whether `needle`'s letters appear in `hay` in order: "rst" in "reset". */
function subsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true;
  return false;
}

/** Where `word` starts a word of `text` (after a space, hyphen or the start), or -1. */
function wordStart(word: string, text: string): number {
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
    if (at === 0 || /[\s\-'’/(]/.test(text[at - 1]!)) return at;
  }
  return -1;
}

export interface Searchable {
  label: string;
  detail?: string;
  keywords?: string;
  /** Keycaps, matched whole: "f" finds what F does. */
  keys?: readonly (readonly string[])[];
}

/**
 * How well one word of a query matches: the label's start, then a word in it, then anywhere
 * in it; then the keys, the keywords and the detail; then the label's letters in order. 0 is
 * no match.
 */
function wordScore(word: string, item: Searchable): number {
  const label = fold(item.label);
  if (label.startsWith(word)) return 100;
  if (wordStart(word, label) !== -1) return 80;
  if (label.includes(word)) return 60;
  if (item.keys?.some((combo) => combo.some((key) => fold(key) === word))) return 50;
  const more = fold(`${item.keywords ?? ''} ${item.detail ?? ''}`);
  if (wordStart(word, more) !== -1) return 40;
  if (word.length > 2 && more.includes(word)) return 20;
  if (word.length > 1 && subsequence(word, label)) return 10;
  return 0;
}

/** How well a query matches an item: every word must match; an empty query matches all (1). */
export function score(query: string, item: Searchable): number {
  const words = fold(query).split(/\s+/).filter(Boolean);
  let total = words.length ? 0 : 1;
  for (const word of words) {
    const s = wordScore(word, item);
    if (!s) return 0;
    total += s;
  }
  return total;
}

export interface Group<T> {
  id: string;
  items: T[];
}

/**
 * The items that match, in their groups. Without a query, everything in the order given; with
 * one, the best match first in each group and the group with the best match first.
 */
export function search<T extends Searchable & { group: string }>(
  items: readonly T[],
  query: string,
): Group<T>[] {
  const scored = items
    .map((item, order) => ({ item, order, score: score(query, item) }))
    .filter((entry) => entry.score > 0);
  if (query.trim()) scored.sort((a, b) => b.score - a.score || a.order - b.order);
  const groups = new Map<string, T[]>();
  for (const { item } of scored) {
    const list = groups.get(item.group);
    if (list) list.push(item);
    else groups.set(item.group, [item]);
  }
  return [...groups].map(([id, list]) => ({ id, items: list }));
}
