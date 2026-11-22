import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOUR } from '../src/core/bars.js';
import { simulateExit, idxAt, path7d } from '../backtest/squeezeSim.js';

test('path7d: max high / min low over the 7 days after entry', () => {
  const rows = Array.from({ length: 24 * 7 + 5 }, () => [101, 99, 100]);
  rows[10] = [120, 99, 110]; rows[50] = [101, 80, 90];
  const b = { t: [], o: [], h: [], l: [], c: [], v: [], q: [] };
  rows.forEach(([h, l, c], i) => { b.t.push(i * HOUR); b.o.push(c); b.h.push(h); b.l.push(l); b.c.push(c); b.v.push(1); b.q.push(1); });
  const p = path7d(b, 0, 100);
  assert.ok(Math.abs(p.max7d - 0.2) < 1e-12 && Math.abs(p.min7d + 0.2) < 1e-12);
  assert.equal(p.maxAtH, 10);
  assert.equal(path7d(b, 100, 100).max7d, null); // not 7 days of future yet
});

const mk = (rows) => {
  const b = { t: [], o: [], h: [], l: [], c: [], v: [], q: [] };
  rows.forEach(([h, l, c], i) => { b.t.push(i * HOUR); b.o.push(c); b.h.push(h); b.l.push(l); b.c.push(c); b.v.push(1); b.q.push(1); });
  return b;
};
const flat = (n) => Array.from({ length: n }, () => [101, 100.5, 100.8]);

test('idxAt: last index <= ts', () => {
  assert.equal(idxAt([0, 10, 20], 15), 1);
  assert.equal(idxAt([0, 10, 20], -1), -1);
  assert.equal(idxAt([0, 10, 20], 20), 2);
});

test('simulateExit: box 90-100 -> stop 95, target 110', () => {
  const box = { entry: 101, high: 100, low: 90 };
  const tp = simulateExit(mk([[101, 100, 101], [111, 100, 110]]), 0, { ...box, maxDays: 1 });
  assert.equal(tp.outcome, 'TP'); assert.equal(tp.exit, 110);
  const sl = simulateExit(mk([[101, 100, 101], [101, 94, 95]]), 0, { ...box, maxDays: 1 });
  assert.equal(sl.outcome, 'SL'); assert.ok(sl.ret < 0);
  const both = simulateExit(mk([[101, 100, 101], [112, 94, 100]]), 0, { ...box, maxDays: 1 });
  assert.equal(both.outcome, 'SL'); // same candle -> stop wins
  const time = simulateExit(mk(flat(30)), 0, { ...box, maxDays: 1 });
  assert.equal(time.outcome, 'TIME');
  assert.equal(simulateExit(mk(flat(5)), 0, { ...box, maxDays: 1 }), null); // not enough future
});
