/**
 * Measures how the traffic flows on the real city: three minutes of simulation round the
 * centre, reporting every half minute how many of each kind are out, stuck (still for over ten
 * seconds) or merely slow, then the five that stood longest and where. A jam that grows is a
 * bug (junction claims that lock up round a block); a few stuck for seconds is a queue.
 *
 *   bun scripts/traffic-flow.ts
 */
import { unpackCity } from '../src/data/format.ts';
import { Traffic } from '../src/scene/traffic.ts';

const city = await unpackCity(
  new Uint8Array(await Bun.file(new URL('../public/data/city.bin', import.meta.url)).bytes()),
);
const t = new Traffic(city.ways, 1);
t.focus(0, 0, 400);
const stopped = new Map<number, number>();
const report = (label: string) => {
  const by: Record<string, { active: number; stuck: number; slow: number }> = {};
  for (const [i, v] of t.vehicles.entries()) {
    const b = (by[v.kind] ??= { active: 0, stuck: 0, slow: 0 });
    if (!v.active) continue;
    b.active++;
    if ((stopped.get(i) ?? 0) > 10) b.stuck++;
    if (v.speed < 0.3) b.slow++;
  }
  console.log(label, JSON.stringify(by));
};
for (let s = 0; s < 180; s++) {
  for (let k = 0; k < 30; k++) {
    t.step(1 / 30);
    for (const [i, v] of t.vehicles.entries()) {
      if (v.active && v.speed < 0.05) stopped.set(i, (stopped.get(i) ?? 0) + 1 / 30);
      else stopped.set(i, 0);
    }
  }
  if (s % 30 === 29) report(`${s + 1}s`);
}
// The longest anyone has stood still, and where.
const worst = [...stopped.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, 5);
for (const [i, secs] of worst) {
  const v = t.vehicles[i]!;
  console.log(
    'stuck',
    v.kind,
    secs.toFixed(0),
    's on edge',
    v.edge,
    'kind',
    t.graph.edges[v.edge]!.kind,
    'next',
    v.next,
    'hold',
    v.hold,
    's',
    v.s.toFixed(1),
    'len',
    t.graph.edges[v.edge]!.length.toFixed(1),
  );
}
