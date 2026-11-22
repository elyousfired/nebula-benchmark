import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slowTop, dailySlowTops, stabilityRows } from '../src/core/stable.js';

const DAY = 86_400_000;

test('slowTop: 50/50 percentile of 30D and 7D perf', () => {
  const rows = [
    { symbol: 'A', d30: 100, w1: 10 }, // best 30D, mid 7D
    { symbol: 'B', d30: 50, w1: 50 }, // mid 30D, best 7D
    { symbol: 'C', d30: -10, w1: -5 }, // worst both
    { symbol: 'D', d30: 20, w1: null }, // skipped
  ];
  const t = slowTop(rows, 2);
  assert.deepEqual(t.map((r) => r.symbol), ['A', 'B']); // tie 75/75 -> higher 30D first
  assert.deepEqual(t.map((r) => r.rank), [1, 2]);
  assert.equal(slowTop(rows).length, 3);
});

test('dailySlowTops + stabilityRows: who stayed the whole window', () => {
  const now = Date.UTC(2026, 10, 22, 12);
  const lastClosed = Math.floor(now / DAY) * DAY - DAY;
  const mk = (fn) => { const b = { t: [], c: [] }; for (let i = 70; i >= 0; i--) { b.t.push(lastClosed - i * DAY); b.c.push(fn(70 - i)); } return b; };
  const daily = {
    UP: mk((i) => 100 * 1.02 ** i), // always the strongest
    MID: mk((i) => 100 * 1.01 ** i),
    FLAT: mk(() => 100),
    LATE: mk((i) => (i < 60 ? 100 * 0.99 ** i : 100 * 1.08 ** (i - 60) * 0.99 ** 60)), // weak, then pumps at the end
  };
  const h = dailySlowTops(daily, { days: 5, n: 2, now });
  assert.equal(h.days.length, 5);
  assert.equal(h.days[4], lastClosed);
  assert.ok(h.tops.every((t) => t.length === 2));
  const live = slowTop([{ symbol: 'UP', d30: 80, w1: 15 }, { symbol: 'MID', d30: 30, w1: 7 }, { symbol: 'FLAT', d30: 0, w1: 0 }], 2);
  const rows = stabilityRows(h, live);
  const by = Object.fromEntries(rows.map((r) => [r.symbol, r]));
  assert.equal(by.UP.full, true);
  assert.equal(by.UP.daysIn, 5);
  assert.equal(by.UP.rankNow, 1);
  assert.equal(by.FLAT, undefined); // never in the top 2
  assert.equal(rows[0].symbol, 'UP');
});

test('stableSetup: breakout above a narrow 20-day box, 2 ATR stop, 2R target', async () => {
  const { stableSetup } = await import('../src/core/stable.js');
  const b = { t: [], h: [], l: [], c: [] };
  for (let i = 0; i < 30; i++) { b.t.push(i); b.h.push(101); b.l.push(99); b.c.push(100); }
  b.h.push(106); b.l.push(100); b.c.push(105); // close above the 20-day high (101), box 2%
  const x = stableSetup(b, 30);
  assert.equal(x.breakout, true);
  assert.ok(Math.abs((x.target - x.entry) - 2 * (x.entry - x.stop)) < 1e-9);
  const n = stableSetup({ t: b.t, h: [...b.h.slice(0, 30), 101], l: [...b.l.slice(0, 30), 99], c: [...b.c.slice(0, 30), 100.5] }, 30);
  assert.equal(n.breakout, false); assert.equal(n.near, true);
});
