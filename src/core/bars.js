// Bar series helpers. A "bars" object holds parallel numeric arrays sorted by
// start time ascending: { t, o, h, l, c, v, q } where t = bar open time (ms UTC),
// v = base volume, q = quote turnover (USDT).

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const INTERVAL_MS = {
  '15': 15 * MIN,
  '60': HOUR,
  '240': 4 * HOUR,
};

export function emptyBars() {
  return { t: [], o: [], h: [], l: [], c: [], v: [], q: [] };
}

export function barsLength(bars) {
  return bars ? bars.t.length : 0;
}

/**
 * Parse a Bybit v5 kline list (newest first, string fields) into ascending bars.
 * Duplicate timestamps are collapsed (last one wins). Invalid rows are skipped.
 */
export function parseKlines(list) {
  const rows = [];
  for (const k of list || []) {
    const t = Number(k[0]);
    const o = Number(k[1]);
    const h = Number(k[2]);
    const l = Number(k[3]);
    const c = Number(k[4]);
    const v = Number(k[5]) || 0;
    const q = Number(k[6]) || v * c || 0;
    if (!Number.isFinite(t) || !(c > 0) || !(h > 0) || !(l > 0)) continue;
    rows.push([t, o > 0 ? o : c, h, l, c, v, q]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  const out = emptyBars();
  for (const r of rows) {
    const n = out.t.length;
    if (n > 0 && out.t[n - 1] === r[0]) {
      out.o[n - 1] = r[1]; out.h[n - 1] = r[2]; out.l[n - 1] = r[3];
      out.c[n - 1] = r[4]; out.v[n - 1] = r[5]; out.q[n - 1] = r[6];
      continue;
    }
    out.t.push(r[0]); out.o.push(r[1]); out.h.push(r[2]); out.l.push(r[3]);
    out.c.push(r[4]); out.v.push(r[5]); out.q.push(r[6]);
  }
  return out;
}

/** Merge two bar sets by timestamp; bars from `b` override `a`. Optional cap on length. */
export function mergeBars(a, b, maxLen = Infinity) {
  if (!barsLength(a)) return trim(b, maxLen);
  if (!barsLength(b)) return trim(a, maxLen);
  const map = new Map();
  for (const src of [a, b]) {
    for (let i = 0; i < src.t.length; i++) {
      map.set(src.t[i], [src.o[i], src.h[i], src.l[i], src.c[i], src.v[i], src.q[i]]);
    }
  }
  const keys = [...map.keys()].sort((x, y) => x - y);
  const out = emptyBars();
  for (const t of keys) {
    const r = map.get(t);
    out.t.push(t); out.o.push(r[0]); out.h.push(r[1]); out.l.push(r[2]);
    out.c.push(r[3]); out.v.push(r[4]); out.q.push(r[5]);
  }
  return trim(out, maxLen);
}

function trim(bars, maxLen) {
  const n = barsLength(bars);
  if (n <= maxLen) return bars;
  const s = n - maxLen;
  const out = {};
  for (const k of Object.keys(bars)) out[k] = bars[k].slice(s);
  return out;
}

/** Index of the last bar that had fully closed at time `ts` (t + interval <= ts), or -1. */
export function lastClosedIndexAt(bars, intervalMs, ts) {
  const t = bars.t;
  let lo = 0;
  let hi = t.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] + intervalMs <= ts) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

/**
 * Price at time `ts` = close of the last bar closed at or before `ts`.
 * Returns null when history doesn't reach back that far (instead of a fake 0),
 * or when that bar is far older than `ts` (gap / delisted period).
 */
export function priceAt(bars, intervalMs, ts) {
  const i = lastClosedIndexAt(bars, intervalMs, ts);
  if (i < 0) return null;
  if (ts - (bars.t[i] + intervalMs) > intervalMs * 4) return null;
  return bars.c[i];
}

/**
 * Resample to a larger interval aligned on the UTC grid (floor(t / toMs) * toMs),
 * e.g. 1H -> 4H gives bars starting 00:00, 04:00, 08:00 UTC like the exchange.
 */
export function resample(bars, toMs) {
  const out = emptyBars();
  const n = barsLength(bars);
  for (let i = 0; i < n; i++) {
    const bucket = Math.floor(bars.t[i] / toMs) * toMs;
    const j = out.t.length - 1;
    if (j >= 0 && out.t[j] === bucket) {
      if (bars.h[i] > out.h[j]) out.h[j] = bars.h[i];
      if (bars.l[i] < out.l[j]) out.l[j] = bars.l[i];
      out.c[j] = bars.c[i];
      out.v[j] += bars.v[i];
      out.q[j] += bars.q[i];
    } else {
      out.t.push(bucket); out.o.push(bars.o[i]); out.h.push(bars.h[i]); out.l.push(bars.l[i]);
      out.c.push(bars.c[i]); out.v.push(bars.v[i]); out.q.push(bars.q[i]);
    }
  }
  return out;
}

/**
 * Exponential moving average, seeded with the SMA of the first `period` values
 * (TradingView convention). Entries before the seed are NaN. Non-finite inputs
 * are skipped (the previous EMA value is carried).
 */
export function emaSeries(values, period) {
  const out = new Array(values.length).fill(NaN);
  const alpha = 2 / (period + 1);
  let sum = 0;
  let count = 0;
  let ema = NaN;
  for (let i = 0; i < values.length; i++) {
    const x = values[i];
    if (!Number.isFinite(x)) { out[i] = ema; continue; }
    if (count < period) {
      sum += x;
      count++;
      if (count === period) ema = sum / period;
    } else {
      ema = x * alpha + ema * (1 - alpha);
    }
    out[i] = ema;
  }
  return out;
}

/**
 * Apply a live price to the bar currently forming (if any) so curves and
 * metrics end on the real current price. Returns a new bars object.
 */
export function patchLive(bars, intervalMs, price, now) {
  const n = barsLength(bars);
  if (!n || !(price > 0)) return bars;
  const last = n - 1;
  if (now < bars.t[last] || now >= bars.t[last] + intervalMs) return bars;
  const out = { ...bars, h: bars.h.slice(), l: bars.l.slice(), c: bars.c.slice() };
  out.c[last] = price;
  if (price > out.h[last]) out.h[last] = price;
  if (price < out.l[last]) out.l[last] = price;
  return out;
}

/** Slice of bars whose start time is >= fromTs. */
export function barsSince(bars, fromTs) {
  const n = barsLength(bars);
  let s = 0;
  while (s < n && bars.t[s] < fromTs) s++;
  const out = {};
  for (const k of Object.keys(bars)) out[k] = bars[k].slice(s);
  return out;
}
