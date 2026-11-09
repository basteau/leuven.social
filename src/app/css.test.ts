import { describe, expect, test } from 'bun:test';

const FILES = ['app.css', 'map.css', 'account-sheet.css'];

/** The classes a file styles on their own, in rules that start with just that class. */
const bareClasses = (css: string) => [...css.matchAll(/^\.([\w-]+)\s*[,{]/gm)].map((m) => m[1]!);

describe('the lazy chunks’ styles', () => {
  test('no two files style the same bare class: whichever loads last would win', async () => {
    const sheets = await Promise.all(FILES.map(readCss));
    const named = sheets.flatMap((css) => Array.from(new Set(bareClasses(css))));
    expect(named.filter((name, i) => named.indexOf(name) !== i)).toEqual([]);
  });
});

async function readCss(file: string): Promise<string> {
  const response = await fetch(new URL(file, import.meta.url));
  return response.text();
}
