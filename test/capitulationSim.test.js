import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOUR, DAY } from '../src/core/bars.js';
import { rolling, capitulationSignals } from '../backtest/capitulationSim.js';

test('rolling max / min over a window', () => {
  assert.deepEqual(rolling([1, 3, 2, 5, 1], 3, true), [null, null, 3, 5, 5]);
  assert.deepEqual(rolling([4, 3, 5, 1, 2], 3, false), [null, null, 3, 1, 1]);
});

test('capitulationSignals: drop then near the low, volume rule', () => {
  // 30 days at 100, then a slide to 60 over 10 days, flat after.
  const n = 24 * 60;
  const b = { t: [], o: [], h: [], l: [], c: [], v: [], q: [] };
  for (let i = 0; i < n; i++) {
    const c = i < 720 ? 100 : i < 960 ? 100 - (40 * (i - 720)) / 240 : 60;
    b.t.push(i * HOUR); b.o.push(c); b.h.push(c * 1.001); b.l.push(c * 0.999); b.c.push(c); b.v.push(1);
    b.q.push(i >= 950 && i < 974 ? 5 : 1); // volume burst around the bottom
  }
  const a = capitulationSignals(b, { from: 0 });
  assert.ok(a.length > 0);
  assert.ok(a[0].fromHigh <= -0.25 && a[0].fromLow <= 0.05);
  assert.ok(a.every((s, i) => i === 0 || s.t - a[i - 1].t >= 3 * DAY)); // cooldown
  const v = capitulationSignals(b, { from: 0, minVol: 2 });
  assert.ok(v.length > 0 && v.every((s) => s.vol >= 2));
  assert.equal(capitulationSignals(b, { from: 0, drop: 0.5 }).length, 0); // never fell 50%
});
