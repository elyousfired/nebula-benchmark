// BTC waves (up / down, the user's dates) and how every Bybit spot token moved
// in each: close-to-close move, best / worst point, start price (for live
// moves), and scores of how it follows BTC. Region fra1, cached 1 hour.

import { selectUniverse } from '../src/core/universe.js';
import { tokenSwings, corrBeta, waveScores } from '../src/core/btcswings.js';

const BYBIT = 'https://api.bybit.com/v5/market';
const DAY = 86_400_000;
// BTC waves (UTC). end null = wave in progress (up to the last closed day). Edit here to change them.
export const WAVES = [
  { name: 'Hausse 1', kind: 'up', start: '2026-03-02', end: '2026-05-26' },
  { name: 'Baisse 1', kind: 'down', start: '2026-05-26', end: '2026-07-01' },
  { name: 'Hausse 2', kind: 'up', start: '2026-07-01', end: '2026-09-21' },
  { name: 'Baisse 2', kind: 'down', start: '2026-09-21', end: null },
];

async function get(path, params) {
  let err;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`${BYBIT}/${path}?${new URLSearchParams(params)}`, { headers: { 'User-Agent': 'nebula-benchmark/1.0' } });
      const j = await r.json();
      if (j.retCode === 0) return j.result;
      err = new Error(j.retMsg || `retCode ${j.retCode}`);
    } catch (e) { err = e; }
    await new Promise((res) => setTimeout(res, 400 * (a + 1)));
  }
  throw err;
}

async function daily(symbol, limit, now) {
  const list = (await get('kline', { category: 'spot', symbol, interval: 'D', limit: String(limit) })).list || [];
  const rows = list.map((k) => [Number(k[0]), Number(k[2]), Number(k[3]), Number(k[4])]).filter((r) => r[3] > 0 && r[0] + DAY <= now).sort((a, b) => a[0] - b[0]);
  return { t: rows.map((r) => r[0]), h: rows.map((r) => r[1]), l: rows.map((r) => r[2]), c: rows.map((r) => r[3]) };
}

export async function buildFollowers(now = Date.now()) {
  const lastClosed = Math.floor(now / DAY) * DAY - DAY;
  // Entry at the close of the day before the start (= open of the start day), through the end day.
  const waves = WAVES.map((w) => ({ ...w, open: w.end == null, t0: Date.parse(w.start) - DAY, t1: w.end ? Date.parse(w.end) : lastClosed }));
  const days = Math.ceil((now - waves[0].t0) / DAY) + 5;
  const btc = await daily('BTCUSDT', days, now);
  const btcMoves = tokenSwings(btc, waves);
  // Latest BTC low: the lowest daily low of the wave in progress (moves automatically if BTC makes a new low).
  const cur = waves[waves.length - 1];
  let iLow = -1;
  for (let i = 0; i < btc.t.length; i++) if (btc.t[i] > cur.t0 && btc.t[i] <= cur.t1 && (iLow < 0 || btc.l[i] < btc.l[iLow])) iLow = i;
  const low = iLow >= 0 ? { t: btc.t[iLow], btcLow: btc.l[iLow], btcClose: btc.c[iLow] } : null;
  const tickers = (await get('tickers', { category: 'spot' })).list || [];
  const universe = selectUniverse(tickers, { limit: 500 }).map((t) => t.symbol);
  const tokens = [];
  let next = 0;
  await Promise.all(Array.from({ length: 10 }, async () => {
    while (next < universe.length) {
      const s = universe[next++];
      try {
        const b = await daily(s, days, now);
        const moves = tokenSwings(b, waves);
        if (moves.every((m) => m == null)) continue;
        const iL = low ? b.t.indexOf(low.t) : -1;
        tokens.push({ symbol: s, moves, pLow: iL >= 0 ? b.c[iL] : null, ...waveScores(waves, moves, btcMoves), ...corrBeta(b, btc, waves[0].t0) });
      } catch { /* skipped */ }
    }
  }));
  return { generatedAt: now, waves, btc: btcMoves, low, universe: universe.length, tokens };
}

export default async function handler(req, res) {
  try {
    const body = await buildFollowers();
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=1800');
    res.status(200).json(body);
  } catch (e) {
    res.status(502).json({ error: `upstream error: ${e.message}` });
  }
}
