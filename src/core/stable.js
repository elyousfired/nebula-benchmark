// "Stable" Top 50: a slow ranking built only on the last 30 days and the last
// 7 days of performance (50% each, as cross-sectional percentiles like the
// main score), and who stayed in it over a rolling 30 days.

import { percentileRanks } from './scoring.js';

export const SLOW_WEIGHTS = { d30: 0.5, w1: 0.5 };
export const WINDOW_DAYS = 30;

/**
 * rows: [{ symbol, d30, w1 }] (percent perfs). Returns the top `n` sorted by
 * slow score: [{ symbol, rank, slow, d30, w1 }]. Rows missing a perf are skipped.
 */
export function slowTop(rows, n = 50) {
  const ok = rows.filter((r) => Number.isFinite(r.d30) && Number.isFinite(r.w1));
  const p30 = percentileRanks(ok.map((r) => r.d30));
  const p7 = percentileRanks(ok.map((r) => r.w1));
  return ok
    .map((r, i) => ({ ...r, slow: SLOW_WEIGHTS.d30 * p30[i] + SLOW_WEIGHTS.w1 * p7[i] }))
    .sort((a, b) => b.slow - a.slow || b.d30 - a.d30)
    .slice(0, n)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

/**
 * Slow Top 50 at each of the last `days` daily closes.
 * daily: { SYMBOL: { t: [...], c: [...] } } ascending daily bars (only closed days).
 * Returns { days: [dayStartMs...], tops: [[{symbol, rank, d30, w1}...]...] }.
 */
export function dailySlowTops(daily, { days = WINDOW_DAYS, n = 50, now = Date.now() } = {}) {
  const DAY = 86_400_000;
  const lastClosed = Math.floor(now / DAY) * DAY - DAY; // start of the last fully closed day
  const out = { days: [], tops: [] };
  for (let k = days - 1; k >= 0; k--) {
    const day = lastClosed - k * DAY;
    const rows = [];
    for (const [symbol, b] of Object.entries(daily)) {
      const i = b.t.indexOf(day);
      if (i < 30) continue;
      rows.push({ symbol, d30: (b.c[i] / b.c[i - 30] - 1) * 100, w1: (b.c[i] / b.c[i - 7] - 1) * 100 });
    }
    out.days.push(day);
    out.tops.push(rows.length >= n ? slowTop(rows, n).map(({ symbol, rank, d30, w1 }) => ({ symbol, rank, d30, w1 })) : []);
  }
  return out;
}

// Backtested setup (backtest/stablestrat.js): stable token (>= 20/30 days in the
// slow Top 50) + daily close above the previous 20-day high + 20-day box < 40%.
// Plan: stop = entry - 2 ATR14 (daily), target = +2R, exit after 10 days.
export const SETUP = { minDays: 20, box: 0.4, stopAtr: 2, targetR: 2, maxDays: 10, nearPct: 0.03 };

/**
 * Setup state of daily bars b ({t,h,l,c}) at index i (closed candle).
 * Returns { breakout, near, width20, hi20, entry, stop, target } or null.
 */
export function stableSetup(b, i) {
  if (i < 21) return null;
  let hi20 = 0; let lo20 = Infinity;
  for (let z = i - 20; z < i; z++) { hi20 = Math.max(hi20, b.h[z]); lo20 = Math.min(lo20, b.l[z]); }
  let atr = 0;
  for (let z = i - 13; z <= i; z++) atr += Math.max(b.h[z] - b.l[z], Math.abs(b.h[z] - b.c[z - 1]), Math.abs(b.l[z] - b.c[z - 1]));
  atr /= 14;
  const width20 = hi20 / lo20 - 1;
  const entry = b.c[i];
  const stop = entry - SETUP.stopAtr * atr;
  return {
    breakout: entry > hi20 && width20 < SETUP.box,
    near: entry <= hi20 && width20 < SETUP.box && hi20 / entry - 1 < SETUP.nearPct,
    width20, hi20, entry, stop, target: entry + SETUP.targetR * (entry - stop),
  };
}

/**
 * Per-symbol summary over the window + the live ranking.
 * history: output of dailySlowTops; live: slowTop(...) of now (or []).
 * Returns rows sorted by days in (desc) then average rank:
 * { symbol, daysIn, total, full (all days + now), inNow, rankNow, avgRank, ranks[] }.
 */
export function stabilityRows(history, live) {
  const total = history.days.length;
  const liveRank = new Map(live.map((r) => [r.symbol, r.rank]));
  const g = new Map();
  history.tops.forEach((top, k) => {
    for (const r of top) {
      if (!g.has(r.symbol)) g.set(r.symbol, { symbol: r.symbol, ranks: new Array(total).fill(null) });
      g.get(r.symbol).ranks[k] = r.rank;
    }
  });
  for (const r of live) if (!g.has(r.symbol)) g.set(r.symbol, { symbol: r.symbol, ranks: new Array(total).fill(null) });
  return [...g.values()].map((x) => {
    const inRanks = x.ranks.filter((v) => v != null);
    const rankNow = liveRank.get(x.symbol) ?? null;
    return {
      ...x,
      total,
      daysIn: inRanks.length,
      inNow: rankNow != null,
      rankNow,
      full: inRanks.length === total && total > 0 && (live.length === 0 || rankNow != null),
      avgRank: inRanks.length ? inRanks.reduce((a, b) => a + b, 0) / inRanks.length : null,
    };
  }).sort((a, b) => b.daysIn - a.daysIn || (b.inNow - a.inNow) || (a.avgRank ?? 99) - (b.avgRank ?? 99));
}
