import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HOUR, DAY } from '../src/core/bars.js';
import {
  H4, BOX_BARS, boxAt, rngSeries, percentileOf, quietPctAt, volRatio, findBreakout,
  classify, analyzeSymbol, sortRows, btcRegime,
} from '../src/core/squeeze.js';

const T0 = Date.UTC(2026, 0, 1);

/** Bars from [high, low, close] triples, starting at T0 with step `iv`. */
function mk(rows, iv = H4, t0 = T0) {
  const b = { t: [], o: [], h: [], l: [], c: [], v: [], q: [] };
  rows.forEach(([h, l, c], i) => {
    b.t.push(t0 + i * iv); b.o.push(c); b.h.push(h); b.l.push(l); b.c.push(c); b.v.push(1); b.q.push(c);
  });
  return b;
}

/** 4H series: `wide` candles with a ±10% range, then `tight` candles with ±1%. */
function squeezeSeries(wide = 900, tight = 100, mid = 100) {
  const rows = [];
  for (let i = 0; i < wide; i++) rows.push([mid * (i % 2 ? 1.1 : 1.05), mid * (i % 2 ? 0.9 : 0.95), mid]);
  for (let i = 0; i < tight; i++) rows.push([mid * 1.01, mid * 0.99, mid]);
  return rows;
}

test('boxAt excludes the current candle', () => {
  const rows = Array.from({ length: BOX_BARS }, () => [10, 9, 9.5]);
  rows.push([50, 1, 20]); // current candle: huge, must be ignored
  const b = mk(rows);
  const box = boxAt(b, BOX_BARS);
  assert.equal(box.high, 10);
  assert.equal(box.low, 9);
  assert.ok(Math.abs(box.rng - (10 / 9 - 1)) < 1e-12);
  assert.equal(boxAt(b, BOX_BARS - 1), null); // not enough history
});

test('rngSeries is null before 14 days, then the box width', () => {
  const b = mk(squeezeSeries(200, 0));
  const r = rngSeries(b);
  assert.equal(r[BOX_BARS - 1], null);
  assert.ok(Math.abs(r[BOX_BARS] - (110 / 90 - 1)) < 1e-12);
});

test('percentileOf counts values <= x', () => {
  assert.equal(percentileOf(1, [1, 2, 3, 4]), 25);
  assert.equal(percentileOf(5, [1, 2, 3, 4]), 100);
  assert.equal(percentileOf(0, [1, 2, 3, 4]), 0);
  assert.equal(percentileOf(1, []), null);
});

test('quiet_pct is low after a contraction and null without history', () => {
  const b = mk(squeezeSeries(900, 100));
  const r = rngSeries(b);
  const last = b.t.length - 1;
  assert.ok(quietPctAt(r, last) <= 10, `got ${quietPctAt(r, last)}`);
  const wide = mk(squeezeSeries(1000, 0));
  const rw = rngSeries(wide);
  assert.equal(quietPctAt(rw, 999), 100); // same width as all history
  assert.equal(quietPctAt(rw, 200), null); // < 60 days of rng history
});

test('volRatio = 24h turnover / 7d daily average', () => {
  const b = mk(Array.from({ length: 168 }, (_, i) => [1, 1, i < 144 ? 1 : 4]), HOUR);
  // last 24h: 24*4 = 96 ; 7d: 144 + 96 = 240 -> avg 240/7
  assert.ok(Math.abs(volRatio(b) - 96 / (240 / 7)) < 1e-12);
  assert.equal(volRatio(mk([[1, 1, 1]], HOUR)), null);
});

test('classify: COILED / QUIET / NORMAL / BREAKOUT', () => {
  assert.equal(classify({ quiet: 5, price: 98, ceiling: 100 }), 'COILED');
  assert.equal(classify({ quiet: 5, price: 90, ceiling: 100 }), 'QUIET');
  assert.equal(classify({ quiet: 5, price: 101, ceiling: 100 }), 'QUIET'); // above, but no closed 1H
  assert.equal(classify({ quiet: 10, price: 99.5, ceiling: 100 }), 'COILED');
  assert.equal(classify({ quiet: 11, price: 99.5, ceiling: 100 }), 'NORMAL');
  assert.equal(classify({ quiet: null, price: 99.5, ceiling: 100 }), 'NORMAL');
  assert.equal(classify({ quiet: 50, price: 105, ceiling: 100, breakout: { t: 1 } }), 'BREAKOUT');
});

/** 4H squeeze series + 1H bars covering the last 2 days; `closes1h` = the last 1H closes. */
function scenario(closes1h) {
  const b4 = mk(squeezeSeries(900, 100));
  const end = b4.t[b4.t.length - 1] + H4; // end of the current 4H candle
  const now = end - 1; // current 4H candle still open, last 1H candle still open
  const n = 48;
  const start = end - n * HOUR;
  const rows = Array.from({ length: n }, (_, i) => {
    const c = closes1h[i - (n - closes1h.length)] ?? 100;
    return [Math.max(c, 100), Math.min(c, 100), c];
  });
  return { b4, b1h: mk(rows, HOUR, start), now };
}

test('findBreakout: closed 1H above a quiet ceiling within 24h', () => {
  // last 3 1H closes: 102, 102.5, and the open one 103 (ignored as not closed)
  const { b4, b1h, now } = scenario([102, 102.5, 103]);
  const r = rngSeries(b4);
  const ev = findBreakout(b4, r, b1h, now);
  assert.ok(ev, 'expected a breakout');
  assert.ok(Math.abs(ev.level - 101) < 1e-9);
  assert.ok(ev.quiet <= 10);
  assert.ok(now - ev.t < DAY);
});

test('findBreakout: none when the latest closed 1H fell back under the ceiling', () => {
  const { b4, b1h, now } = scenario([102, 100.5, 100.5]);
  assert.equal(findBreakout(b4, rngSeries(b4), b1h, now), null);
});

test('findBreakout: an open 1H candle above the ceiling does not count', () => {
  const { b4, b1h, now } = scenario([100.5, 100.5, 105]);
  assert.equal(findBreakout(b4, rngSeries(b4), b1h, now), null);
});

test('analyzeSymbol end to end', () => {
  const coiled = scenario([100.5, 100.5, 100.5]);
  const a = analyzeSymbol({ symbol: 'XUSDT', ...coiled });
  assert.equal(a.status, 'COILED');
  assert.ok(Math.abs(a.high - 101) < 1e-9 && Math.abs(a.low - 99) < 1e-9);
  assert.ok(a.quietPct <= 10);
  const bo = analyzeSymbol({ symbol: 'YUSDT', ...scenario([102, 102.5, 103]) });
  assert.equal(bo.status, 'BREAKOUT');
});

test('sortRows: status order then distance to the ceiling', () => {
  const rows = [
    { symbol: 'N', status: 'NORMAL', distPct: 0.001 },
    { symbol: 'Q', status: 'QUIET', distPct: 0.2 },
    { symbol: 'C2', status: 'COILED', distPct: 0.02 },
    { symbol: 'C1', status: 'COILED', distPct: 0.01 },
    { symbol: 'B', status: 'BREAKOUT', distPct: -0.03 },
  ];
  assert.deepEqual(sortRows(rows).map((r) => r.symbol), ['B', 'C1', 'C2', 'Q', 'N']);
});

test('btcRegime: SMA50 + 20-day return ±5%', () => {
  const up = mk(Array.from({ length: 60 }, (_, i) => [0, 0, 100 + i]), DAY);
  assert.equal(btcRegime(up).state, 'bull');
  const down = mk(Array.from({ length: 60 }, (_, i) => [0, 0, 200 - i * 2]), DAY);
  assert.equal(btcRegime(down).state, 'bear');
  const flat = mk(Array.from({ length: 60 }, (_, i) => [0, 0, 100 + (i % 2)]), DAY);
  assert.equal(btcRegime(flat).state, 'chop');
  assert.equal(btcRegime(mk([[0, 0, 1]], DAY)), null);
});

test('distPct = price / ceiling - 1 (negative below, positive above)', () => {
  const a = analyzeSymbol({ symbol: 'X', ...scenario([100.5, 100.5, 100.5]) });
  assert.ok(a.distPct < 0 && Math.abs(a.distPct - (100.5 / 101 - 1)) < 1e-9);
  const b = analyzeSymbol({ symbol: 'Y', ...scenario([102, 102.5, 103]) });
  assert.ok(b.distPct > 0);
});
