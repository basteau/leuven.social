import { expect, test } from 'bun:test';
import { ShaderChunk } from 'three';

import { applyFourTapShadows, fourTapShadows } from './shadow-filter.ts';

const taps = (chunk: string) => chunk.match(/texture\( shadowMap, vec3\(/g)?.length ?? 0;

test("three's turning five-tap PCF becomes four fixed taps, and only that changes", () => {
  const before = ShaderChunk.shadowmap_pars_fragment;
  const after = fourTapShadows(before);
  expect(after).not.toBe(before);
  expect(taps(before) - taps(after)).toBe(1);
  expect(after).toContain('vec2( -0.35, -0.90 ) * texelSize');
  expect(after).toContain(') * 0.25;');
  expect(fourTapShadows(after)).toBe(after);
  applyFourTapShadows();
  expect(ShaderChunk.shadowmap_pars_fragment).toBe(after);
});
