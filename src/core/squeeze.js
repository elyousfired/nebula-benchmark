// Squeeze Radar: volatility-contraction boxes on 4H candles.
// Pure functions only (shared by api/squeeze.js, the page and the tests).
// Bars are the ascending { t, o, h, l, c, v, q } objects from core/bars.js.

import { HOUR, DAY } from './bars.js';

export const H4 = 4 * HOUR;
export const BOX_BARS = 84; // 14 days of 4H candles
export const HIST_BARS = 720; // 120 days of 4H candles
export const MIN_HIST = 360; // need at least 60 days of history for a percentile
export const QUIET_MAX = 10; // quiet_pct <= 10 => squeeze
export const NEAR_CEIL = 0.03; // COILED: price below the ceiling by less than 3%

export const STATUS_ORDER = { BREAKOUT: 0, COILED: 1, QUIET: 2, NORMAL: 3 };

/** Box over the `n` candles before index i (candle i itself excluded). */
export function boxAt(bars, i, n = BOX_BARS) {
  if (i < n || i > bars.t.length) return null;
  let high = -Infinity;
  let low = Infinity;
  for (let k = i - n; k < i; k++) {
    if (bars.h[k] > high) high = bars.h[k];
    if (bars.l[k] < low) low = bars.l[k];
  }
  if (!(low > 0)) return null;
  return { high, low, rng: high / low - 1, from: bars.t[i - n] };
}

/** rng14 for every index (null while fewer than n candles precede it). */
export function rngSeries(bars, n = BOX_BARS) {
  const out = new Array(bars.t.length).fill(null);
  for (let i = n; i < bars.t.length; i++) out[i] = boxAt(bars, i, n).rng;
  return out;
}

/** Percentile (0–100) of `value` within `history`: share of values <= value. */
export function percentileOf(value, history) {
  const xs = history.filter((x) => x != null && Number.isFinite(x));
  if (value == null || !xs.length) return null;
  let le = 0;
  for (const x of xs) if (x <= value) le++;
  return (le / xs.length) * 100;
}

/** quiet_pct at index i: rng[i] vs the `hist` rng values before it. */
export function quietPctAt(rng, i, { hist = HIST_BARS, minHist = MIN_HIST } = {}) {
  if (rng[i] == null) return null;
  const past = rng.slice(Math.max(0, i - hist), i).filter((x) => x != null);
  if (past.length < minHist) return null;
  return percentileOf(rng[i], past);
}

/** 24h turnover / average daily turnover over 7 days, from 1H bars. */
export function volRatio(bars1h) {
  const q = bars1h.q;
  if (q.length < 168) return null;
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const d1 = sum(q.slice(-24));
  const avg7 = sum(q.slice(-168)) / 7;
  return avg7 > 0 ? d1 / avg7 : null;
}

/** Index of the 4H candle containing time t, or -1. */
function bar4At(b4, t) {
  for (let j = b4.t.length - 1; j >= 0; j--) if (b4.t[j] <= t) return t < b4.t[j] + H4 ? j : -1;
  return -1;
}

/**
 * Breakout in the last 24h: a closed 1H candle closed above the ceiling of the
 * box of its 4H candle, while quiet_pct of that 4H candle (box built from the
 * candles before it) was <= QUIET_MAX. The latest closed 1H must still be
 * above that ceiling. Returns { t, level, quiet } (t = close time) or null.
 */
export function findBreakout(b4, rng, b1h, now) {
  const closed = [];
  for (let k = 0; k < b1h.t.length; k++) if (b1h.t[k] + HOUR <= now) closed.push(k);
  if (!closed.length) return null;
  let event = null;
  for (const k of closed) {
    const t = b1h.t[k];
    if (t + HOUR <= now - DAY) continue;
    const j = bar4At(b4, t);
    if (j < 0) continue;
    const box = boxAt(b4, j);
    const quiet = quietPctAt(rng, j);
    if (box && quiet != null && quiet <= QUIET_MAX && b1h.c[k] > box.high) {
      event = { t: t + HOUR, level: box.high, quiet };
      break;
    }
  }
  if (!event) return null;
  const last = closed[closed.length - 1];
  return b1h.c[last] > event.level ? event : null;
}

/** Status from the measured values (price can be a live price). */
export function classify({ quiet, price, ceiling, breakout }) {
  if (breakout) return 'BREAKOUT';
  if (quiet == null || quiet > QUIET_MAX) return 'NORMAL';
  if (price > 0 && ceiling > 0 && price < ceiling && ceiling / price - 1 < NEAR_CEIL) return 'COILED';
  return 'QUIET';
}

/**
 * Full analysis of one symbol. b4 = 4H bars (last one = current, still open),
 * b1h = 1H bars, `price` = latest price (defaults to the last 1H close).
 */
export function analyzeSymbol({ symbol, b4, b1h, now, price }) {
  const last = b4.t.length - 1;
  if (last < BOX_BARS) return null;
  const rng = rngSeries(b4);
  const box = boxAt(b4, last);
  const quiet = quietPctAt(rng, last);
  const px = price > 0 ? price : b1h.c[b1h.c.length - 1] || b4.c[last];
  const breakout = findBreakout(b4, rng, b1h, now);
  const histBars = rng.slice(Math.max(0, last - HIST_BARS), last).filter((x) => x != null).length;
  return {
    symbol,
    price: px,
    high: box.high,
    low: box.low,
    boxFrom: box.from,
    rng14: box.rng,
    quietPct: quiet,
    histDays: Math.round(histBars / 6),
    volRatio: volRatio(b1h),
    distPct: box.high > 0 ? px / box.high - 1 : null, // < 0 below the ceiling, > 0 above
    breakout,
    status: classify({ quiet, price: px, ceiling: box.high, breakout }),
  };
}

/** BREAKOUT, then COILED, then QUIET, then NORMAL; ties by distance to the ceiling. */
export function sortRows(rows) {
  const d = (r) => (r.distPct == null ? Infinity : Math.abs(r.distPct));
  return [...rows].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || d(a) - d(b));
}

/**
 * BTC regime from daily bars (last bar = today, open):
 * bull = close > SMA50 and 20-day return > +5%, bear = close < SMA50 and
 * 20-day return < -5%, otherwise chop.
 */
export function btcRegime(daily) {
  const c = daily.c;
  if (c.length < 51) return null;
  const close = c[c.length - 1];
  const sma50 = c.slice(-50).reduce((s, x) => s + x, 0) / 50;
  const ret20 = close / c[c.length - 21] - 1;
  let state = 'chop';
  if (close > sma50 && ret20 > 0.05) state = 'bull';
  else if (close < sma50 && ret20 < -0.05) state = 'bear';
  return { state, close, sma50, ret20 };
}

/**
 * Setup score 0–100: how ready a token looks to break up out of its box.
 * 50% tightness (low quiet_pct), 30% proximity to the ceiling (within 10%),
 * 20% volume pickup (vol_ratio, capped at 2x). A breakout counts as at the ceiling.
 */
export function setupScore(r) {
  const tight = 1 - Math.min(100, r.quietPct ?? 100) / 100;
  const d = r.distPct;
  const prox = r.status === 'BREAKOUT' || (d != null && d >= 0) ? 1 : d == null ? 0 : Math.max(0, 1 + d / 0.10);
  const vol = Math.min(1, Math.max(0, (r.volRatio ?? 0) / 2));
  return Math.round((0.5 * tight + 0.3 * prox + 0.2 * vol) * 100);
}

/**
 * Charts to show: every token with a signal (BREAKOUT / COILED, or a symbol in
 * `signalSymbols`), then the best setup scores until there are `n`.
 * Each pick: { ...row, score, reason: 'signal' | 'top' }.
 */
export function pickTop(rows, { n = 5, signalSymbols = [] } = {}) {
  const sig = new Set(signalSymbols);
  const scored = rows.map((r) => ({ ...r, score: setupScore(r) })).sort((a, b) => b.score - a.score);
  const isSig = (r) => r.status === 'BREAKOUT' || r.status === 'COILED' || sig.has(r.symbol);
  const signals = scored.filter(isSig).map((r) => ({ ...r, reason: 'signal' }));
  const rest = scored.filter((r) => !isSig(r)).slice(0, Math.max(0, n - signals.length)).map((r) => ({ ...r, reason: 'top' }));
  return [...signals, ...rest];
}
