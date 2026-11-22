// "Capitulation" signal (pure): price near its 30-day low after a big drop,
// optionally with rising volume. Only candles closed at the signal are used.

import { HOUR, DAY } from '../src/core/bars.js';
import { closeAt, exitTargetOrTime, path7d } from './squeezeSim.js';

/** Rolling max (or min) over the last `n` values, inclusive (monotonic deque). */
export function rolling(values, n, isMax = true) {
  const out = new Array(values.length).fill(null);
  const dq = [];
  for (let i = 0; i < values.length; i++) {
    const better = (a, b) => (isMax ? a >= b : a <= b);
    while (dq.length && better(values[i], values[dq[dq.length - 1]])) dq.pop();
    dq.push(i);
    if (dq[0] <= i - n) dq.shift();
    if (i >= n - 1) out[i] = values[dq[0]];
  }
  return out;
}

/**
 * Signals for one symbol. Rules at a closed 1H candle k:
 *   nearLow: close <= 30-day low * (1 + nearLow)
 *   drop:    close <= 30-day high * (1 - drop)
 *   minVol:  24h turnover / 7-day daily average >= minVol (0 = no volume rule)
 * One signal per symbol every `cooldownDays`.
 */
export function capitulationSignals(b1, { from, nearLow = 0.05, drop = 0.25, minVol = 0, cooldownDays = 3 } = {}) {
  const N = 720;
  const hi = rolling(b1.h, N, true);
  const lo = rolling(b1.l, N, false);
  const pre = [0];
  for (const q of b1.q) pre.push(pre[pre.length - 1] + q);
  const qsum = (a, b) => pre[b + 1] - pre[a];
  const out = [];
  let last = -Infinity;
  for (let k = N; k < b1.t.length; k++) {
    const t = b1.t[k] + HOUR; // close time
    if (t < from || t - last < cooldownDays * DAY) continue;
    const c = b1.c[k];
    if (c > lo[k] * (1 + nearLow) || c > hi[k] * (1 - drop)) continue;
    const d7 = qsum(k - 167, k) / 7;
    const vol = d7 > 0 ? qsum(k - 23, k) / d7 : null;
    if (minVol > 0 && !(vol >= minVol)) continue;
    last = t;
    const fwd = (h) => (b1.t[b1.t.length - 1] + HOUR >= t + h * HOUR ? closeAt(b1, t + h * HOUR) / c - 1 : null);
    out.push({ t, entry: c, vol, fromHigh: c / hi[k] - 1, fromLow: c / lo[k] - 1, r24h: fwd(24), r3d: fwd(72), r7d: fwd(168), ...path7d(b1, k, c), tp: exitTargetOrTime(b1, k, c, { target: 0.10, hours: 48 }) });
  }
  return out;
}
