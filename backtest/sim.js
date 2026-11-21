// Walk-forward simulation of the Launchpad strategy on a 15m grid.
// At every 15m close t, ONLY data up to t is used to:
//   rank the universe (30D score) → Top 50 → 24H curves → Launchpad / Rejection Wall,
//   detect crossings vs the previous step, open positions, and manage exits on the
//   following candles. Same engine (bot/engine.js) as the paper bot.

import { scoreUniverse, topList } from '../src/core/scoring.js';
import { collectiveLevels, sniperLevels } from '../src/core/levels.js';
import { detectCrossings, openPosition, updatePosition, unrealizedPnlPct, summarize, DEFAULT_CONFIG } from '../bot/engine.js';

export const Q = 15 * 60_000;
const LOOK = { m15: 1, h1: 4, h4: 16, d1: 96, w1: 672, d30: 2880 };

/** Rolling 24h quote turnover per bar. */
export function rolling24h(q) {
  const out = new Float64Array(q.length).fill(NaN);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < q.length; i++) {
    if (Number.isFinite(q[i])) { sum += q[i]; n++; }
    if (i >= 96 && Number.isFinite(q[i - 96])) { sum -= q[i - 96]; n--; }
    if (i >= 95 && n >= 80) out[i] = sum;
  }
  return out;
}

function perfAt(c, i, lag) {
  const j = i - lag;
  if (j < 0) return null;
  const a = c[j];
  const b = c[i];
  if (!(a > 0) || !(b > 0)) return null;
  return ((b - a) / a) * 100;
}

/** 24H curve at step i, same definition as the site (base = close 24h earlier). */
function dayCurve(tk, i) {
  const base = tk.c[i - 96];
  if (!(base > 0)) return null;
  const pts = [{ x: i - 96, v: 0, hi: 0 }];
  for (let k = i - 95; k <= i; k++) {
    if (!(tk.c[k] > 0)) continue;
    pts.push({ x: k, v: ((tk.c[k] - base) / base) * 100, hi: ((tk.h[k] - base) / base) * 100 });
  }
  return pts.length > 80 ? pts : null;
}

/**
 * Feed one candle to a position along a plausible intrabar path
 * (green: O→L→H→C, red: O→H→L→C). A stop crossed inside the candle fills at the
 * stop minus slippage; a gap through the stop at the open fills at the open.
 */
export function stepCandle(pos, bar, time, cfg, slip = 0.0005) {
  const path = bar.c >= bar.o ? [bar.o, bar.l, bar.h, bar.c] : [bar.o, bar.h, bar.l, bar.c];
  let p = pos;
  const events = [];
  let prev = null;
  for (const raw of path) {
    if (p.status !== 'OPEN') break;
    let px = raw;
    if (prev != null && px < prev && px <= p.stop && prev > p.stop) px = p.stop * (1 - slip);
    const r = updatePosition(p, { bid: px, now: time }, cfg);
    p = r.position;
    events.push(...r.events);
    prev = raw;
  }
  return { position: p, events };
}

/**
 * @param T       grid of candle open times (ascending, 15m)
 * @param tokens  { [sym]: { o,h,l,c,q: Float64Array (NaN = missing), turn24: Float64Array } }
 * @param startIdx first step of the test window (needs ≥ 2880+96 bars of history before)
 */
export function simulate({ T, tokens, startIdx, cfg = DEFAULT_CONFIG, minTurnoverUniverse = 10_000, minTurnoverEntry = 0, spread = 0.0005 }) {
  const syms = Object.keys(tokens);
  const open = [];
  const closed = [];
  const cooldown = {};
  const levelsLog = [];
  let prevPts = null;
  let skipped = { chase: 0, wall: 0, liquidity: 0, cooldown: 0 };

  for (let i = startIdx; i < T.length; i++) {
    const now = T[i] + Q; // close time of candle i

    // 1) exits on candle i for positions opened earlier
    for (let k = open.length - 1; k >= 0; k--) {
      const tk = tokens[open[k].symbol];
      const bar = { o: tk.o[i], h: tk.h[i], l: tk.l[i], c: tk.c[i] };
      if (!(bar.c > 0)) continue;
      const { position } = stepCandle(open[k], bar, now, cfg);
      if (position.status === 'CLOSED') {
        closed.push({ ...position, holdMs: position.closedAt - position.openedAt, turnover24h: open[k].turnover24h });
        cooldown[position.symbol] = now;
        open.splice(k, 1);
      } else open[k] = { ...position, turnover24h: open[k].turnover24h };
    }

    // 2) point-in-time universe + 30D score
    const metrics = [];
    for (const s of syms) {
      const tk = tokens[s];
      if (!(tk.c[i] > 0) || !(tk.turn24[i] >= minTurnoverUniverse)) continue;
      const perf = {};
      for (const [k, lag] of Object.entries(LOOK)) perf[k] = perfAt(tk.c, i, lag);
      metrics.push({ symbol: s, perf });
    }
    if (metrics.length < 20) { prevPts = null; continue; }
    const top = topList(scoreUniverse(metrics), 'month', 50, 'score');

    // 3) 24H curves of the Top 50 → levels
    const curves = {};
    for (const t of top) {
      const cv = dayCurve(tokens[t.symbol], i);
      if (cv) curves[t.symbol] = cv;
    }
    if (Object.keys(curves).length < 10) { prevPts = null; continue; }
    const levels = sniperLevels(collectiveLevels(curves));
    levelsLog.push({ t: now, entry: levels.entry, tp: levels.tp, n: Object.keys(curves).length });

    const pts = {};
    for (const [s, cv] of Object.entries(curves)) pts[s] = cv[cv.length - 1].v;
    const ranks = Object.fromEntries(top.map((t) => [t.symbol, t.rank]));

    // 4) entries at the close of candle i
    const prevForCross = prevPts;
    for (const s of detectCrossings(prevForCross, pts, levels.entry, Infinity)) {
      if (pts[s] > levels.entry + cfg.maxChasePts) { skipped.chase++; continue; }
      if (open.some((p) => p.symbol === s)) continue;
      if (now - (cooldown[s] || 0) < cfg.cooldownMs) { skipped.cooldown++; continue; }
      const tk = tokens[s];
      if (!(tk.turn24[i] >= minTurnoverEntry)) { skipped.liquidity++; continue; }
      const last = tk.c[i];
      const r = openPosition({ symbol: s, ask: last * (1 + spread), last, curvePts: pts[s], levels, now, rank: ranks[s] }, cfg);
      if (r.skip) { skipped.wall++; continue; }
      open.push({ ...r.position, turnover24h: tk.turn24[i] });
    }
    prevPts = pts;
  }

  // Mark open positions at the last close.
  const lastI = T.length - 1;
  const stillOpen = open.map((p) => ({ ...p, markPct: unrealizedPnlPct(p, tokens[p.symbol].c[lastI], cfg) }));
  return { closed, open: stillOpen, summary: summarize(closed), skipped, levelsLog };
}
