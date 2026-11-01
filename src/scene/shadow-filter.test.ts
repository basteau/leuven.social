import { expect, test } from 'bun:test';
import { ShaderChunk } from 'three';

import { oneTapShadows, applyOneTapShadows } from './shadow-filter.ts';

const taps = (chunk: string) => chunk.match(/texture\( shadowMap, vec3\(/g)?.length ?? 0;

test("three's five-tap PCF becomes one filtered tap, and only that changes", () => {
  const before = ShaderChunk.shadowmap_pars_fragment;
  const after = oneTapShadows(before);
  expect(after).not.toBe(before);
  expect(taps(before) - taps(after)).toBe(4);
  expect(after).toContain('texture( shadowMap, vec3( shadowCoord.xy, shadowCoord.z ) );');
  expect(oneTapShadows(after)).toBe(after);
  applyOneTapShadows();
  expect(ShaderChunk.shadowmap_pars_fragment).toBe(after);
});
