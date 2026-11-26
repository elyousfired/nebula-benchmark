// Squeeze Radar backtest logic (pure). Same rules as src/core/squeeze.js:
// box14 on 4H (current candle excluded), quiet_pct vs 120 days, signal when a
// closed 1H candle closes above the ceiling while quiet_pct <= 10.

import { HOUR, DAY } from '../src/core/bars.js';
import { H4, rngSeries, boxAt, quietPctAt, QUIET_MAX, btcRegime, setupScore } from '../src/core/squeeze.js';

const FEE = 0.001; // 0.1% per side (Bybit spot taker)
/** [target, hours] exits tested: take profit at +target, else close after `hours`. */
export const EXIT_VARIANTS = [[0.10, 48], [0.05, 24], [0.10, 72]];

/** Last index with t[i] <= ts (binary search), or -1. */
export function idxAt(t, ts) {
  let lo = 0; let hi = t.length - 1; let r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (t[m] <= ts) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}

/** Close of the last 1H candle closed at or before ts. */
export function closeAt(b1h, ts) {
  const i = idxAt(b1h.t, ts - HOUR);
  return i < 0 ? null : b1h.c[i];
}

/**
 * Exit plan on 1H bars after entry: stop = middle of the box, target = ceiling
 * + box height. If both are touched in the same candle the stop wins
 * (conservative). Not hit after `maxDays` -> exit at that close.
 * Returns { exit, outcome: 'TP'|'SL'|'TIME', ret (net of fees), hours }.
 */
export function simulateExit(b1h, k, { entry, high, low, maxDays = 14 }) {
  const stop = (high + low) / 2;
  const target = high + (high - low);
  const end = b1h.t[k] + maxDays * DAY;
  let i = k + 1;
  for (; i < b1h.t.length && b1h.t[i] < end; i++) {
    if (b1h.l[i] <= stop) return done(stop, 'SL', i);
    if (b1h.h[i] >= target) return done(target, 'TP', i);
  }
  if (i >= b1h.t.length || b1h.t[i - 1] + HOUR < end) return null; // not enough future data
  return done(b1h.c[i - 1], 'TIME', i - 1);

  function done(exit, outcome, j) {
    return { exit, outcome, stop, target, ret: (exit * (1 - FEE)) / (entry * (1 + FEE)) - 1, hours: Math.round((b1h.t[j] + HOUR - b1h.t[k] - HOUR) / HOUR) };
  }
}

/**
 * Hold 7 days, no stop / no target: best high (max gain) and worst low (max
 * drawdown) reached after entry, and when the best high happened.
 * null when 7 days of future data are not available yet.
 */
export function path7d(b1h, k, entry) {
  const end = b1h.t[k] + HOUR + 7 * DAY;
  if (b1h.t[b1h.t.length - 1] + HOUR < end) return { max7d: null, min7d: null, maxAtH: null };
  let hi = -Infinity; let lo = Infinity; let at = 0;
  for (let i = k + 1; i < b1h.t.length && b1h.t[i] < end; i++) {
    if (b1h.h[i] > hi) { hi = b1h.h[i]; at = i - k; }
    if (b1h.l[i] < lo) lo = b1h.l[i];
  }
  return { max7d: hi / entry - 1, min7d: lo / entry - 1, maxAtH: at };
}

/**
 * Take profit at +target if a 1H high reaches it within `hours`, otherwise exit
 * at the close `hours` after entry. No stop. Net of fees. null without enough data.
 */
export function exitTargetOrTime(b1h, k, entry, { target = 0.10, hours = 48 } = {}) {
  const end = b1h.t[k] + HOUR + hours * HOUR;
  if (b1h.t[b1h.t.length - 1] + HOUR < end) return null;
  const tp = entry * (1 + target);
  let i = k + 1;
  for (; i < b1h.t.length && b1h.t[i] < end; i++) {
    if (b1h.h[i] >= tp) return { outcome: 'TP', ret: (tp * (1 - FEE)) / (entry * (1 + FEE)) - 1, hours: i - k, t: b1h.t[i] + HOUR };
  }
  return { outcome: 'TIME', ret: (b1h.c[i - 1] * (1 - FEE)) / (entry * (1 + FEE)) - 1, hours: i - 1 - k, t: b1h.t[i - 1] + HOUR };
}

/**
 * Daily snapshots (00:00 UTC) of the live Top 5 setup score for one symbol,
 * using only data known at that moment, plus what happened next.
 */
export function scoreSnapshots({ symbol, b4, b1h, from }) {
  const rng = rngSeries(b4);
  const out = [];
  const lastT = b1h.t[b1h.t.length - 1] + HOUR;
  for (let t = Math.ceil(from / DAY) * DAY; t + 2 * DAY <= lastT; t += DAY) {
    const k = idxAt(b1h.t, t - HOUR); // last 1H closed at t
    const j = idxAt(b4.t, t); // 4H candle open at t (excluded from its box)
    if (k < 167 || j < 0 || b1h.t[k] + HOUR !== t) continue;
    const box = boxAt(b4, j);
    const quietPct = quietPctAt(rng, j);
    if (!box || quietPct == null) continue;
    const price = b1h.c[k];
    const r = { quietPct, distPct: price / box.high - 1, volRatio: volRatioAt(b1h, k), status: 'NORMAL' };
    const fwd = (h) => (t + h * HOUR <= lastT ? closeAt(b1h, t + h * HOUR) / price - 1 : null);
    let max2 = -Infinity;
    for (let i = k + 1; i < b1h.t.length && b1h.t[i] < t + 2 * DAY; i++) max2 = Math.max(max2, b1h.h[i] / price - 1);
    out.push({
      symbol, t, ...r, score: setupScore(r), r1d: fwd(24), r2d: fwd(48), r7d: fwd(168), max2d: max2,
      tp10: exitTargetOrTime(b1h, k, price, { target: 0.10, hours: 48 }),
    });
  }
  return out;
}

/** 24h / 7d turnover ratio at 1H index k (closed candles only). */
function volRatioAt(b1h, k) {
  if (k < 167) return null;
  let d1 = 0; let d7 = 0;
  for (let i = k - 167; i <= k; i++) { d7 += b1h.q[i]; if (i > k - 24) d1 += b1h.q[i]; }
  return d7 > 0 ? d1 / (d7 / 7) : null;
}

/** BTC regime using only daily candles closed before ts. */
export function regimeAt(btcDaily, ts) {
  const i = idxAt(btcDaily.t, ts - DAY);
  if (i < 50) return null;
  const sl = { c: btcDaily.c.slice(0, i + 1) };
  return btcRegime(sl)?.state ?? null;
}

/**
 * Every signal for one symbol. One signal per box: after a signal, the next one
 * needs `cooldownDays` and the price back under the ceiling first.
 */
export function findSignals({ symbol, b4, b1h, btcDaily, from, cooldownDays = 3, quietMax = QUIET_MAX }) {
  const rng = rngSeries(b4);
  const quietCache = new Map();
  const quiet = (j) => {
    if (!quietCache.has(j)) quietCache.set(j, quietPctAt(rng, j));
    return quietCache.get(j);
  };
  const out = [];
  let lastSignal = -Infinity;
  let armed = true;
  for (let k = 1; k < b1h.t.length; k++) {
    const t = b1h.t[k];
    if (t < from) continue;
    const j = idxAt(b4.t, t);
    if (j < 0 || t >= b4.t[j] + H4) continue;
    const box = boxAt(b4, j);
    if (!box) continue;
    const above = b1h.c[k] > box.high;
    if (!above) { armed = true; continue; }
    if (!armed || t - lastSignal < cooldownDays * DAY) continue;
    const q = quiet(j);
    if (q == null || q > quietMax) continue;
    armed = false;
    lastSignal = t;
    const entry = b1h.c[k];
    const closeT = t + HOUR;
    const fwd = (h) => { const c = closeAt(b1h, closeT + h * HOUR); return c && b1h.t[b1h.t.length - 1] + HOUR >= closeT + h * HOUR ? c / entry - 1 : null; };
    out.push({
      symbol, t: closeT, entry, high: box.high, low: box.low, rng14: box.rng, quiet: q,
      volRatio: volRatioAt(b1h, k), regime: regimeAt(btcDaily, closeT),
      r24h: fwd(24), r3d: fwd(72), r7d: fwd(168),
      days: [1, 2, 3, 4, 5, 6, 7].map((d) => fwd(24 * d)),
      ...path7d(b1h, k, entry),
      exits: Object.fromEntries(EXIT_VARIANTS.map(([target, hours]) => [`${target}/${hours}`, exitTargetOrTime(b1h, k, entry, { target, hours })])),
      plan: simulateExit(b1h, k, { entry, high: box.high, low: box.low }),
    });
  }
  return out;
}
