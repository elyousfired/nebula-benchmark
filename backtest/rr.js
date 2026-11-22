// R-multiple exit simulation (pure). R = distance entry -> stop.

import { HOUR } from '../src/core/bars.js';

const FEE = 0.001; // 0.1% per side

export { atrAt } from '../src/core/squeeze.js';

/**
 * Long from the close of 1H candle k. Stop / target checked on later 1H candles
 * (same candle touching both -> stop). Time exit after `maxH` hours.
 * Returns { R, ret, outcome: 'TP'|'SL'|'TIME', exitT } net of fees, or null
 * when there are not enough future candles.
 */
export function simulateR(b1, k, { entry, stop, target, maxH }) {
  const risk = (entry - stop) / entry;
  if (!(risk > 0)) return null;
  const end = b1.t[k] + HOUR + maxH * HOUR;
  if (b1.t[b1.t.length - 1] + HOUR < end) return null;
  const done = (px, outcome, i) => {
    const ret = (px * (1 - FEE)) / (entry * (1 + FEE)) - 1;
    return { R: ret / risk, ret, outcome, exitT: b1.t[i] + HOUR };
  };
  let i = k + 1;
  for (; i < b1.t.length && b1.t[i] < end; i++) {
    if (b1.l[i] <= stop) return done(stop, 'SL', i);
    if (target != null && b1.h[i] >= target) return done(target, 'TP', i);
  }
  return done(b1.c[i - 1], 'TIME', i - 1);
}

/** Stats on a list of trades ({R, ret, exitT}). */
export function rStats(trades) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const Rs = trades.map((t) => t.R);
  const wins = Rs.filter((r) => r > 0);
  const losses = Rs.filter((r) => r <= 0);
  const sum = Rs.reduce((a, b) => a + b, 0);
  const gp = wins.reduce((a, b) => a + b, 0);
  const gl = -losses.reduce((a, b) => a + b, 0);
  let eq = 0; let peak = 0; let dd = 0;
  for (const t of [...trades].sort((a, b) => a.exitT - b.exitT)) { eq += t.R; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  return {
    n, expR: sum / n, totalR: sum, win: wins.length / n,
    avgWin: wins.length ? gp / wins.length : 0, avgLoss: losses.length ? -gl / losses.length : 0,
    pf: gl > 0 ? gp / gl : Infinity, maxDD: dd,
  };
}
