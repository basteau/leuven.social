import { expect, test } from 'bun:test';
import { ShaderChunk } from 'three';

import { applyShadowChunks, fourTapShadows, sunSideOffset } from './shadow-filter.ts';

const taps = (chunk: string) => chunk.match(/texture\( shadowMap, vec3\(/g)?.length ?? 0;

test("three's turning five-tap PCF becomes four fixed taps, and only that changes", () => {
  const before = ShaderChunk.shadowmap_pars_fragment;
  const after = fourTapShadows(before);
  expect(after).not.toBe(before);
  expect(taps(before) - taps(after)).toBe(1);
  expect(after).toContain('vec2( -0.35, -0.90 ) * texelSize');
  expect(after).toContain(') * 0.25;');
  expect(fourTapShadows(after)).toBe(after);
});

test('the normal offset lifts every lookup on the sun side of its face, and only that changes', () => {
  const before = ShaderChunk.shadowmap_vertex;
  const after = sunSideOffset(before);
  expect(after).not.toBe(before);
  expect(after.length - before.length).toBeLessThan(250);
  expect(after).toContain('directionalShadowMatrix[ i ][ 2 ].z');
  expect(after.replace(/ \* sign\([^;]*\) \), 0 \);/, ', 0 );')).toBe(before);
  expect(sunSideOffset(after)).toBe(after);
});

test('both go into three before anything compiles', () => {
  const [fragment, vertex] = [ShaderChunk.shadowmap_pars_fragment, ShaderChunk.shadowmap_vertex];
  applyShadowChunks();
  expect(ShaderChunk.shadowmap_pars_fragment).toBe(fourTapShadows(fragment));
  expect(ShaderChunk.shadowmap_vertex).toBe(sunSideOffset(vertex));
});
