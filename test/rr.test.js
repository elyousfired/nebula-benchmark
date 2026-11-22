import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOUR } from '../src/core/bars.js';
import { simulateR, rStats, atrAt } from '../backtest/rr.js';

const mk = (rows) => {
  const b = { t: [], o: [], h: [], l: [], c: [], v: [], q: [] };
  rows.forEach(([h, l, c], i) => { b.t.push(i * HOUR); b.o.push(c); b.h.push(h); b.l.push(l); b.c.push(c); b.v.push(1); b.q.push(1); });
  return b;
};
const flat = (n) => Array.from({ length: n }, () => [100.5, 99.5, 100]);

test('simulateR: target = +2R, stop = -1R, time exit, same-bar stop first', () => {
  const opt = { entry: 100, stop: 95, target: 110, maxH: 10 };
  const tp = simulateR(mk([...flat(3), [111, 99, 108], ...flat(20)]), 0, opt);
  assert.equal(tp.outcome, 'TP'); assert.ok(Math.abs(tp.R - 2) < 0.1);
  const sl = simulateR(mk([...flat(3), [100, 94, 95], ...flat(20)]), 0, opt);
  assert.equal(sl.outcome, 'SL'); assert.ok(Math.abs(sl.R + 1) < 0.1);
  const both = simulateR(mk([...flat(3), [111, 94, 100], ...flat(20)]), 0, opt);
  assert.equal(both.outcome, 'SL');
  const time = simulateR(mk(flat(30)), 0, opt);
  assert.equal(time.outcome, 'TIME');
  assert.equal(simulateR(mk(flat(5)), 0, opt), null);
});

test('rStats: expectancy, profit factor, drawdown', () => {
  const s = rStats([{ R: 2, exitT: 1 }, { R: -1, exitT: 2 }, { R: -1, exitT: 3 }, { R: 2, exitT: 4 }]);
  assert.equal(s.n, 4); assert.equal(s.expR, 0.5); assert.equal(s.pf, 2); assert.equal(s.maxDD, -2); assert.equal(s.win, 0.5);
});

test('atrAt: mean true range of closed candles', () => {
  const b = mk(Array.from({ length: 20 }, () => [102, 98, 100]));
  assert.equal(atrAt(b, 16), 4);
  assert.equal(atrAt(b, 5), null);
});
