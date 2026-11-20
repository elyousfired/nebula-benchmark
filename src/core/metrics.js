import { DAY, HOUR, MIN, INTERVAL_MS, priceAt, resample, emaSeries, barsSince, barsLength } from './bars.js';

const I15 = INTERVAL_MS['15'];
const I60 = INTERVAL_MS['60'];
const I240 = INTERVAL_MS['240'];

/** Lookback windows used for performance figures (ms). */
export const WINDOWS = {
  m15: 15 * MIN,
  h1: HOUR,
  h4: 4 * HOUR,
  d1: DAY,
  w1: 7 * DAY,
  d30: 30 * DAY,
};

export function pctChange(from, to) {
  if (!(from > 0) || !(to > 0)) return null;
  return ((to - from) / from) * 100;
}

const round = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(d)));

/**
 * Bybit v5 `price24hPcnt` is always a ratio ("0.0123" = +1.23%).
 * (The old code guessed with |x| < 1, which broke on moves above +100%.)
 */
export function tickerPct24h(ticker) {
  const r = Number(ticker?.price24hPcnt);
  return Number.isFinite(r) ? r * 100 : null;
}

/** Market phase on 4H, thresholds kept from the original strategy. */
export function classifyPhase({ p30d, p1w, p1d, p4h, p15m, distEma20, pullbackFromHigh }) {
  const n = (x) => (x == null ? 0 : x);
  const isClimax = n(distEma20) > 24 || (n(p30d) > 55 && n(distEma20) > 16);
  // Original used `price < ema20 - 3.0` (3 dollars, not 3%) — fixed to a % distance.
  const isDropping = n(p1d) < -2 || n(p4h) < -1.5 || (n(pullbackFromHigh) < -8 && n(p1d) < 0) || n(distEma20) < -3;
  const isPullbackRetest = (n(p30d) >= 12 || n(p1w) >= 6)
    && n(pullbackFromHigh) <= -6
    && n(distEma20) >= -4 && n(distEma20) <= 6
    && n(p15m) >= -0.6;
  const isExpansion = (n(p1d) > 1.5 || n(p4h) > 0.5) && n(distEma20) > 3;

  if (isClimax) return 'CLIMAX';
  if (isDropping && !isPullbackRetest) return 'CORRECTION';
  if (isPullbackRetest) return 'PULLBACK';
  if (isExpansion) return 'EXPANSION';
  return 'ACCUMULATION';
}

/**
 * Up-candle vs down-candle turnover estimate over a window, from candle shape
 * (close location in the range). This is an ESTIMATE, not real taker flow.
 */
export function estimateBuySell(bars) {
  let buy = 0;
  let sell = 0;
  for (let i = 0; i < barsLength(bars); i++) {
    const q = bars.q[i];
    if (!(q > 0)) continue;
    const range = bars.h[i] - bars.l[i];
    const r = range > 0 ? (bars.c[i] - bars.l[i]) / range : 0.5;
    buy += q * r;
    sell += q * (1 - r);
  }
  const tot = buy + sell;
  return { buyPct: tot > 0 ? (buy / tot) * 100 : 50, buy, sell };
}

/**
 * All per-token figures. Every lookback uses timestamps (not candle counts):
 *  - 15m bars (≈100) for 15m / 1h / 4h / 24h
 *  - 1H bars (1000 ≈ 41 days) for 7D / 30D, 30D high, and aligned 4H EMAs.
 * Missing history returns null, never a fake 0.
 */
export function computeTokenMetrics({ symbol, bars15, bars60, ticker, now }) {
  const lastClose15 = barsLength(bars15) ? bars15.c[bars15.c.length - 1] : null;
  const tickerPrice = Number(ticker?.lastPrice);
  const price = tickerPrice > 0 ? tickerPrice : lastClose15;
  if (!(price > 0)) return null;

  const perfFrom = (bars, iv, w) => round(pctChange(priceAt(bars, iv, now - w), price));
  const p15m = perfFrom(bars15, I15, WINDOWS.m15);
  const p1h = perfFrom(bars15, I15, WINDOWS.h1);
  const p4h = perfFrom(bars15, I15, WINDOWS.h4);
  const p1d = perfFrom(bars15, I15, WINDOWS.d1);
  const p1w = perfFrom(bars60, I60, WINDOWS.w1);
  const p30d = perfFrom(bars60, I60, WINDOWS.d30);

  // 30-day range (real 30 days of 1H candles).
  const last30 = barsSince(bars60, now - WINDOWS.d30);
  let high30d = null;
  let low30d = null;
  for (let i = 0; i < barsLength(last30); i++) {
    if (high30d == null || last30.h[i] > high30d) high30d = last30.h[i];
    if (low30d == null || last30.l[i] < low30d) low30d = last30.l[i];
  }
  if (high30d != null && price > high30d) high30d = price;
  const base30d = priceAt(bars60, I60, now - WINDOWS.d30);
  const maxPointsMonth = round(pctChange(base30d, high30d));
  const pullbackFromHigh = round(pctChange(high30d, price));

  // 4H candles aligned on the UTC grid, EMAs warmed with ~250 bars.
  const bars4h = resample(bars60, I240);
  const closes4h = bars4h.c.slice();
  if (closes4h.length) closes4h[closes4h.length - 1] = price;
  const ema20s = emaSeries(closes4h, 20);
  const ema50s = emaSeries(closes4h, 50);
  const ema20 = ema20s.length ? ema20s[ema20s.length - 1] : NaN;
  const ema50 = ema50s.length ? ema50s[ema50s.length - 1] : NaN;
  const ema20prev = ema20s.length >= 4 ? ema20s[ema20s.length - 4] : NaN;
  const distEma20 = Number.isFinite(ema20) ? round(pctChange(ema20, price), 1) : null;
  const slopeEma20 = Number.isFinite(ema20) && Number.isFinite(ema20prev) ? round(pctChange(ema20prev, ema20)) : null;

  const day15 = barsSince(bars15, now - DAY);
  const flow = estimateBuySell(day15);
  const turnoverTicker = Number(ticker?.turnover24h);
  let turnoverBars = 0;
  for (let i = 0; i < barsLength(day15); i++) turnoverBars += day15.q[i];
  const turnover24h = turnoverTicker > 0 ? turnoverTicker : turnoverBars;

  const lastBarT15 = barsLength(bars15) ? bars15.t[bars15.t.length - 1] : 0;
  const dataAgeMs = lastBarT15 ? now - (lastBarT15 + I15) : Infinity;

  const perf = { m15: p15m, h1: p1h, h4: p4h, d1: p1d, w1: p1w, d30: p30d };
  const phase = classifyPhase({ p30d, p1w, p1d, p4h, p15m, distEma20, pullbackFromHigh });

  return {
    symbol,
    base: symbol.replace(/USDT$/, ''),
    price,
    perf,
    high30d,
    low30d,
    maxPointsMonth,
    pullbackFromHigh,
    ema20_4h: Number.isFinite(ema20) ? ema20 : null,
    ema50_4h: Number.isFinite(ema50) ? ema50 : null,
    distEma20,
    slopeEma20,
    phase,
    turnover24h,
    buyPctEst: round(flow.buyPct, 1),
    change24hTicker: round(tickerPct24h(ticker)),
    // A 15m series whose last closed bar is > 45 min old is stale (failed refresh).
    stale: dataAgeMs > 45 * MIN,
  };
}
