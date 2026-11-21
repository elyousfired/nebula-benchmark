// Minute-precision replay that mirrors the live bot.
// The live bot re-evaluates every ~10 s with the forming 15m candle patched to the
// live price, so it catches Launchpad crosses that happen INSIDE a 15m candle.
// Here every 1-minute close plays the role of a bot tick:
//   price = 1m close; 15m history = candles closed before that minute + the forming
//   15m candle (high/low/close from the 1m candles so far) → score, Top 50, 24H curves,
//   Launchpad / Wall, crossings vs the previous minute, entries at the 1m close,
//   exits on the following 1m candles.

import { scoreUniverse, topList } from '../src/core/scoring.js';
import { collectiveLevels, sniperLevels } from '../src/core/levels.js';
import { detectCrossings, openPosition, unrealizedPnlPct, summarize, DEFAULT_CONFIG } from '../bot/engine.js';
import { stepCandle, Q } from './sim.js';

const M = 60_000;
const LAGS = { m15: 15 * M, h1: 60 * M, h4: 240 * M, d1: 1440 * M, w1: 7 * 1440 * M, d30: 30 * 1440 * M };

/**
 * @param T15     15m grid (open times), tokens[s].{o,h,l,c,turn24} on it
 * @param T1      1m grid (open times) covering the test window, tokens[s].m = {o,h,l,c} on it
 */
export function simulate1m({ T15, T1, tokens, cfg = DEFAULT_CONFIG, minTurnoverUniverse = 10_000, minTurnoverEntry = 0, maxRank = 50, spread = 0.0005 }) {
  const t0 = T15[0];
  const syms = Object.keys(tokens).filter((s) => tokens[s].m);
  const open = [];
  const closed = [];
  const cooldown = {};
  const levelsLog = [];
  const skipped = { chase: 0, wall: 0, liquidity: 0, cooldown: 0 };
  let prevPts = null;

  // Index of the 15m bar whose close time is <= ts (i.e. last bar closed at ts).
  const closedIdx = (ts) => Math.floor((ts - t0) / Q) - 1;

  for (let j = 0; j < T1.length; j++) {
    const now = T1[j] + M; // close of minute j
    const formingStart = Math.floor((now - 1) / Q) * Q; // 15m bar containing this minute
    const fIdx = (formingStart - t0) / Q;

    // 1) exits on minute j for positions opened before
    for (let k = open.length - 1; k >= 0; k--) {
      const m = tokens[open[k].symbol].m;
      const bar = { o: m.o[j], h: m.h[j], l: m.l[j], c: m.c[j] };
      if (!(bar.c > 0)) continue;
      const { position } = stepCandle(open[k], bar, now, cfg);
      if (position.status === 'CLOSED') {
        closed.push({ ...position, holdMs: position.closedAt - position.openedAt, turnover24h: open[k].turnover24h });
        cooldown[position.symbol] = now;
        open.splice(k, 1);
      } else open[k] = { ...position, turnover24h: open[k].turnover24h };
    }

    // 2) live state per token: price + forming 15m candle
    const live = {};
    const metrics = [];
    for (const s of syms) {
      const tk = tokens[s];
      const p = tk.m.c[j];
      if (!(p > 0)) continue;
      const lastClosed = fIdx - 1;
      if (!(tk.turn24[lastClosed] >= minTurnoverUniverse)) continue;
      // forming candle high from the 1m candles of this 15m bucket so far
      let fh = p;
      for (let x = j; x >= 0 && T1[x] >= formingStart; x--) if (tk.m.h[x] > fh) fh = tk.m.h[x];
      live[s] = { p, fh, turn: tk.turn24[lastClosed] };
      const perf = {};
      for (const [k, lag] of Object.entries(LAGS)) {
        const ref = tk.c[closedIdx(now - lag)];
        perf[k] = ref > 0 ? ((p - ref) / ref) * 100 : null;
      }
      metrics.push({ symbol: s, perf });
    }
    if (metrics.length < 20) { prevPts = null; continue; }
    const top = topList(scoreUniverse(metrics), 'month', 50, 'score');

    // 3) 24H curves (same definition as the bot / site)
    const curves = {};
    const baseIdx = closedIdx(now - 1440 * M);
    for (const t of top) {
      const tk = tokens[t.symbol];
      const base = tk.c[baseIdx];
      if (!(base > 0)) continue;
      const pts = [{ v: 0, hi: 0 }];
      for (let k = baseIdx + 1; k < fIdx; k++) {
        if (tk.c[k] > 0) pts.push({ v: ((tk.c[k] - base) / base) * 100, hi: ((tk.h[k] - base) / base) * 100 });
      }
      const L = live[t.symbol];
      pts.push({ v: ((L.p - base) / base) * 100, hi: ((L.fh - base) / base) * 100 });
      if (pts.length > 80) curves[t.symbol] = pts;
    }
    if (Object.keys(curves).length < 10) { prevPts = null; continue; }
    const levels = sniperLevels(collectiveLevels(curves));
    levelsLog.push({ t: now, entry: levels.entry, tp: levels.tp });
    const pts = {};
    for (const [s, cv] of Object.entries(curves)) pts[s] = cv[cv.length - 1].v;
    const ranks = Object.fromEntries(top.map((t) => [t.symbol, t.rank]));

    // 4) entries at the 1m close
    for (const s of detectCrossings(prevPts, pts, levels.entry, Infinity)) {
      if (pts[s] > levels.entry + cfg.maxChasePts) { skipped.chase++; continue; }
      if (open.some((p) => p.symbol === s)) continue;
      if ((ranks[s] ?? 99) > maxRank) continue;
      if (now - (cooldown[s] || 0) < cfg.cooldownMs) { skipped.cooldown++; continue; }
      if (!(live[s].turn >= minTurnoverEntry)) { skipped.liquidity++; continue; }
      const last = live[s].p;
      const r = openPosition({ symbol: s, ask: last * (1 + spread), last, curvePts: pts[s], levels, now, rank: ranks[s] }, cfg);
      if (r.skip) { skipped.wall++; continue; }
      open.push({ ...r.position, turnover24h: live[s].turn });
    }
    prevPts = pts;
  }

  const lastJ = T1.length - 1;
  const stillOpen = open.map((p) => ({ ...p, markPct: unrealizedPnlPct(p, tokens[p.symbol].m.c[lastJ], cfg) }));
  return { closed, open: stillOpen, summary: summarize(closed), skipped, levelsLog };
}
