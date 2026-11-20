import { DAY, INTERVAL_MS, priceAt, resample, emaSeries, barsLength } from './bars.js';

/**
 * Horizon definitions for the performance curves.
 *  - 24H: 15m candles (96 points)
 *  - 7D : 1H candles (168 points)
 *  - 30D: 4H candles aligned on UTC (180 points), built from 1H
 * The base price (0 pts) is taken from the same series the table uses, so the
 * last point of each curve equals the token's performance in the table.
 */
export const CURVE_HORIZONS = {
  day: { window: DAY, src: 'bars15', srcIv: INTERVAL_MS['15'], iv: INTERVAL_MS['15'] },
  week: { window: 7 * DAY, src: 'bars60', srcIv: INTERVAL_MS['60'], iv: INTERVAL_MS['60'] },
  month: { window: 30 * DAY, src: 'bars60', srcIv: INTERVAL_MS['60'], iv: INTERVAL_MS['240'] },
};

/**
 * Curve for one token: [{ x, v, hi, q, up }] where x is the bar CLOSE time
 * (the forming bar is stamped `now`), v = close vs base in %, hi = high vs base,
 * q = quote turnover of the bar, up = close >= open.
 * Every token shares the same x grid because candles are aligned on UTC.
 */
export function tokenCurve(series, horizon, now) {
  const def = CURVE_HORIZONS[horizon];
  const src = series?.[def.src];
  if (!barsLength(src)) return null;
  const from = now - def.window;
  const base = priceAt(src, def.srcIv, from);
  if (!(base > 0)) return null;
  const bars = def.iv === def.srcIv ? src : resample(src, def.iv);
  const pts = [{ x: from, v: 0, hi: 0, q: 0, up: true }];
  for (let i = 0; i < barsLength(bars); i++) {
    const close = bars.t[i] + def.iv;
    if (close <= from) continue;
    // Partial first 4H bucket overlapping the window start: skip to keep the base clean.
    if (bars.t[i] < from) continue;
    pts.push({
      x: Math.min(close, now),
      v: ((bars.c[i] - base) / base) * 100,
      hi: ((bars.h[i] - base) / base) * 100,
      q: bars.q[i],
      up: bars.c[i] >= bars.o[i],
    });
  }
  return pts.length >= 2 ? pts : null;
}

/**
 * Average curve of a set of tokens, matched by timestamp (not by array index:
 * a token missing a candle is simply not counted at that time), plus its EMA20.
 */
export function benchmarkCurve(curvesBySymbol) {
  const acc = new Map();
  for (const pts of Object.values(curvesBySymbol)) {
    if (!pts) continue;
    for (const p of pts) {
      const a = acc.get(p.x) || { sum: 0, n: 0 };
      a.sum += p.v;
      a.n += 1;
      acc.set(p.x, a);
    }
  }
  const xs = [...acc.keys()].sort((a, b) => a - b);
  const bench = xs.map((x) => ({ x, v: acc.get(x).sum / acc.get(x).n, n: acc.get(x).n }));
  const ema = emaSeries(bench.map((p) => p.v), 20);
  return {
    bench,
    ema: bench.map((p, i) => ({ x: p.x, v: ema[i] })).filter((p) => Number.isFinite(p.v)),
  };
}

export function buildCurves(list, seriesBySymbol, horizon, now) {
  const curves = {};
  for (const t of list) {
    const c = tokenCurve(seriesBySymbol[t.symbol], horizon, now);
    if (c) curves[t.symbol] = c;
  }
  return { curves, ...benchmarkCurve(curves) };
}
