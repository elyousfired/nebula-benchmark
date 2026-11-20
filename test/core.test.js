import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseKlines, mergeBars, priceAt, resample, emaSeries, patchLive, HOUR, DAY, INTERVAL_MS } from '../src/core/bars.js';
import { computeTokenMetrics, classifyPhase, tickerPct24h, pctChange } from '../src/core/metrics.js';
import { percentileRanks, scoreUniverse, topList } from '../src/core/scoring.js';
import { tokenCurve, benchmarkCurve } from '../src/core/curves.js';
import { collectiveLevels, sniperLevels } from '../src/core/levels.js';
import { volumeProfile } from '../src/core/volumeProfile.js';
import { replayTrade, replayAll } from '../src/core/backtest.js';
import { stepSignals } from '../src/core/signals.js';
import { selectUniverse, isTokenizedStock, isLeveraged } from '../src/core/universe.js';
import { mockKlines, mockTickers } from '../dev/mockBybit.js';

const H = HOUR;
const I15 = INTERVAL_MS['15'];

// Build ascending bars from closes; t0 aligned, interval iv.
function mkBars(closes, iv, t0 = 0) {
  return {
    t: closes.map((_, i) => t0 + i * iv),
    o: closes.map((c, i) => (i ? closes[i - 1] : c)),
    h: closes.map((c, i) => Math.max(c, i ? closes[i - 1] : c)),
    l: closes.map((c, i) => Math.min(c, i ? closes[i - 1] : c)),
    c: closes.slice(),
    v: closes.map(() => 1),
    q: closes.map((c) => c),
  };
}

test('parseKlines: Bybit newest-first strings -> ascending numbers, dedup, skip invalid', () => {
  const b = parseKlines([
    ['3000', '3', '4', '2', '3.5', '10', '35'],
    ['1000', '1', '2', '0.5', '1.5', '10', '15'],
    ['2000', '2', '3', '1', '2.5', '10', '25'],
    ['2000', '2', '3', '1', '2.6', '10', '26'],
    ['4000', '0', '0', '0', '0', '0', '0'],
  ]);
  assert.deepEqual(b.t, [1000, 2000, 3000]);
  assert.equal(b.c[1], 2.6);
});

test('mergeBars: newer data overrides, keeps order, caps length', () => {
  const a = mkBars([1, 2, 3], 10);
  const b = { ...mkBars([30, 40], 10, 20) };
  const m = mergeBars(a, b, 3);
  assert.deepEqual(m.t, [10, 20, 30]);
  assert.deepEqual(m.c, [2, 30, 40]);
});

test('priceAt uses close of the last bar fully closed at ts; null when history is too short', () => {
  const b = mkBars([10, 11, 12, 13], H, 0); // bars [0,1h) .. [3h,4h)
  assert.equal(priceAt(b, H, 2 * H), 11);
  assert.equal(priceAt(b, H, 2.5 * H), 11);
  assert.equal(priceAt(b, H, 3 * H), 12);
  assert.equal(priceAt(b, H, 0.5 * H), null);
});

test('resample 1H -> 4H aligns on the UTC grid (00/04/08...)', () => {
  // Start at 02:00 UTC: first 4H bucket must be 00:00 (partial: 02,03), then 04:00.
  const b = mkBars([1, 2, 3, 4, 5, 6, 7], H, 2 * H);
  const r = resample(b, 4 * H);
  assert.deepEqual(r.t, [0, 4 * H, 8 * H]);
  assert.deepEqual(r.c, [2, 6, 7]);
  assert.equal(r.o[1], b.o[2]);
  assert.equal(r.h[1], Math.max(...b.h.slice(2, 6)));
});

test('emaSeries: SMA seed then EMA', () => {
  const e = emaSeries([1, 2, 3, 4], 3);
  assert.ok(Number.isNaN(e[0]) && Number.isNaN(e[1]));
  assert.equal(e[2], 2);
  assert.equal(e[3], 4 * 0.5 + 2 * 0.5);
});

test('patchLive updates only the forming bar', () => {
  const b = mkBars([10, 11], H, 0);
  const p = patchLive(b, H, 15, 1.5 * H);
  assert.equal(p.c[1], 15);
  assert.equal(p.h[1], 15);
  assert.equal(b.c[1], 11, 'original untouched');
  assert.equal(patchLive(b, H, 15, 2.5 * H), b);
});

test('tickerPct24h: ratio * 100 even above +100% (old heuristic broke here)', () => {
  assert.equal(tickerPct24h({ price24hPcnt: '0.0123' }), 1.23);
  assert.equal(tickerPct24h({ price24hPcnt: '1.5' }), 150);
});

test('computeTokenMetrics: 30D is really 30 days (not 1000×15m ≈ 10.4 days)', () => {
  const now = 40 * DAY;
  // 1H bars: price 100 until day 10, then linear to 200 at day 40.
  const closes60 = [];
  for (let i = 0; i < 960; i++) {
    const day = (i + 1) / 24;
    closes60.push(day <= 10 ? 100 : 100 + (100 * (day - 10)) / 30);
  }
  const bars60 = mkBars(closes60, H, 0);
  const closes15 = [];
  for (let i = 0; i < 100; i++) closes15.push(200);
  const bars15 = mkBars(closes15, I15, now - 100 * I15);
  const m = computeTokenMetrics({ symbol: 'ABCUSDT', bars15, bars60, ticker: { lastPrice: '200' }, now });
  assert.equal(m.perf.d30, 100); // 100 -> 200
  assert.ok(Math.abs(m.perf.w1 - pctChange(100 + (100 * 23) / 30, 200)) < 0.01);
  assert.equal(m.maxPointsMonth, 100);
  assert.equal(m.perf.d1, 0);
});

test('computeTokenMetrics: missing history gives null, not 0', () => {
  const now = 5 * DAY;
  const bars60 = mkBars(new Array(24 * 5).fill(10), H, 0);
  const bars15 = mkBars(new Array(100).fill(10), I15, now - 100 * I15);
  const m = computeTokenMetrics({ symbol: 'NEWUSDT', bars15, bars60, ticker: { lastPrice: '10' }, now });
  assert.equal(m.perf.d30, null);
  assert.equal(m.perf.w1, null);
  assert.equal(m.perf.d1, 0);
});

test('classifyPhase: "-3" is a % distance now (old code compared price to ema-3$)', () => {
  // Price 50000 with ema 50001.5 (-0.003%): old rule `price < ema - 3` => false; new: distance -0.003% => not dropping.
  assert.equal(classifyPhase({ p1d: 0.5, p4h: 0.1, distEma20: -0.003, pullbackFromHigh: -1 }), 'ACCUMULATION');
  assert.equal(classifyPhase({ distEma20: -5 }), 'CORRECTION');
  assert.equal(classifyPhase({ distEma20: 30 }), 'CLIMAX');
  assert.equal(classifyPhase({ p30d: 20, pullbackFromHigh: -10, distEma20: 1, p15m: 0 }), 'PULLBACK');
  assert.equal(classifyPhase({ p1d: 3, distEma20: 5 }), 'EXPANSION');
});

test('percentileRanks: 0..100, ties averaged, nulls kept', () => {
  assert.deepEqual(percentileRanks([10, null, 30, 20]), [0, null, 100, 50]);
  assert.deepEqual(percentileRanks([5, 5, 10]), [25, 25, 100]);
});

test('scoreUniverse: bounded 0..100 and an outlier does not dominate', () => {
  const mk = (s, d30) => ({ symbol: s, perf: { m15: 0.1, h1: 0.2, h4: 0.3, d1: 1, w1: 2, d30 } });
  const scored = scoreUniverse([mk('A', 900), mk('B', 20), mk('C', 10), { symbol: 'D', perf: { m15: 1, h1: 1, h4: 1, d1: 1, w1: 1, d30: null } }]);
  for (const t of scored) {
    if (t.scores.month != null) assert.ok(t.scores.month >= 0 && t.scores.month <= 100);
  }
  const a = scored.find((t) => t.symbol === 'A').scores.month;
  const b = scored.find((t) => t.symbol === 'B').scores.month;
  assert.ok(a - b < 20, `outlier gap should be bounded, got ${a - b}`);
  assert.equal(scored.find((t) => t.symbol === 'D').scores.month, null);
  assert.notEqual(scored.find((t) => t.symbol === 'D').scores.day, null);
  const top = topList(scored, 'month', 2);
  assert.deepEqual(top.map((t) => t.symbol), ['A', 'B']);
  assert.equal(top[0].rank, 1);
});

test('tokenCurve + benchmark: aligned by timestamp, not by index', () => {
  const now = 2 * DAY;
  const full = mkBars(new Array(192).fill(0).map((_, i) => 100 + i * 0), I15, 0);
  full.c = full.c.map((_, i) => (i >= 96 ? 110 : 100));
  // Second token is missing bars in the middle.
  const gap = mkBars(new Array(192).fill(100), I15, 0);
  const keep = gap.t.map((_, i) => i < 120 || i > 130);
  const filt = {};
  for (const k of Object.keys(gap)) filt[k] = gap[k].filter((_, i) => keep[i]);
  const c1 = tokenCurve({ bars15: full }, 'day', now);
  const c2 = tokenCurve({ bars15: filt }, 'day', now);
  assert.equal(c1[c1.length - 1].v, 10);
  const { bench } = benchmarkCurve({ A: c1, B: c2 });
  const missingX = filt.t.length ? 125 * I15 + I15 : 0;
  const at = bench.find((p) => p.x === missingX);
  assert.equal(at.n, 1, 'token B has no bar there, so only A counts');
  assert.equal(at.v, 10);
});

test('month curve uses 4H aligned candles and base = 30 days ago', () => {
  const now = 40 * DAY;
  const bars60 = mkBars(new Array(960).fill(0).map((_, i) => 100 + i / 10), H, 0);
  const c = tokenCurve({ bars60 }, 'month', now);
  assert.equal(c[0].x, now - 30 * DAY);
  for (const p of c.slice(1)) assert.equal(p.x % (4 * H), 0);
  assert.equal(c.length, 1 + 180);
});

test('collectiveLevels keeps launchpad < rejection wall', () => {
  const curve = (peak) => [0, 2, 5, peak, peak - 3].map((v, i) => ({ x: i, v, hi: v }));
  const l = collectiveLevels({ A: curve(25), B: curve(18), C: curve(4), D: curve(30) });
  assert.ok(l.launchpad >= 4 && l.launchpad <= 10);
  assert.ok(l.rejectionWall >= l.launchpad + 4.5);
  const s = sniperLevels(l);
  assert.ok(s.sl < s.entry && s.entry < s.tp);
});

test('volumeProfile: POC and 70% value area', () => {
  const pts = [{ x: 0, v: 0, q: 0 }, { x: 1, v: 0.5, q: 10, up: true }, { x: 2, v: 1.5, q: 100, up: true }, { x: 3, v: 2.5, q: 10, up: false }];
  const vp = volumeProfile({ A: pts });
  assert.equal(vp.poc, 1);
  assert.equal(vp.total, 120);
  assert.ok(vp.val <= 1 && vp.vah >= 2);
});

test('replayTrade: first touch wins (SL before TP => LOSS)', () => {
  const lv = { entry: 5, sl: 3, tp: 10 };
  const pts = [0, 6, 2, 12].map((v, i) => ({ x: i, v, hi: v }));
  assert.equal(replayTrade(pts, lv).status, 'LOSS');
  const pts2 = [0, 6, 11, 2].map((v, i) => ({ x: i, v, hi: v }));
  assert.equal(replayTrade(pts2, lv).status, 'WIN');
  const r = replayAll({ A: [0, 6, 7].map((v, i) => ({ x: i, v, hi: v })) }, lv);
  assert.equal(r.winRate, null, 'no fake win rate when nothing is decided');
  assert.equal(r.open, 1);
});

test('stepSignals: baseline first, then fires only on a fresh cross', () => {
  const lv = { entry: 5, sl: 3, tp: 10 };
  const c = (v) => ({ A: [{ x: 0, v: 0 }, { x: 1, v }] });
  let st = { baseline: null, history: [] };
  let r = stepSignals(st, c(7), lv, { A: 1 }, 1);
  assert.equal(r.fresh.length, 0, 'already above at load => no alert');
  r = stepSignals(r.state, c(4), lv, {}, 2);
  assert.equal(r.fresh.length, 0);
  r = stepSignals(r.state, c(6), lv, {}, 3);
  assert.equal(r.fresh.length, 1);
  r = stepSignals(r.state, c(11), lv, {}, 4);
  assert.equal(r.state.history[0].status, 'WIN');
});

test('selectUniverse filters BTC/ETH, stables, leveraged and tokenized stocks', () => {
  assert.ok(isTokenizedStock('AAPLX'));
  assert.ok(!isTokenizedStock('XX'));
  assert.ok(isLeveraged('BTC3L'));
  const now = Date.UTC(2026, 10, 20, 21, 0);
  const u = selectUniverse(mockTickers(now).result.list, { minTurnover: 0 });
  const bases = u.map((t) => t.base);
  for (const bad of ['BTC', 'ETH', 'USDC', 'BTC3L', 'AAPLX']) assert.ok(!bases.includes(bad), bad);
  assert.ok(bases.includes('SOL'));
});

test('end-to-end on mock data: metrics are finite and curves end at table perf', () => {
  const now = Date.UTC(2026, 10, 20, 21, 7);
  const bars15 = parseKlines(mockKlines('SOLUSDT', '15', 100, now).result.list);
  const bars60 = parseKlines(mockKlines('SOLUSDT', '60', 1000, now).result.list);
  const price = bars15.c[bars15.c.length - 1];
  const m = computeTokenMetrics({ symbol: 'SOLUSDT', bars15, bars60, ticker: { lastPrice: String(price) }, now });
  for (const k of Object.keys(m.perf)) assert.ok(Number.isFinite(m.perf[k]), k);
  const c = tokenCurve({ bars15 }, 'day', now);
  assert.ok(Math.abs(c[c.length - 1].v - m.perf.d1) < 0.01);
});
