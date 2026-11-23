// How every Bybit spot token moved during BTC's rallies. A rally runs from its
// start day (the user's marked low) to the top of that wave; for each token we
// give the best gain reached in that window (max high vs the price at the start)
// and where it finished. Region fra1, cached 1 hour.

import { selectUniverse } from '../src/core/universe.js';
import { tokenSwings, corrBeta } from '../src/core/btcswings.js';

const BYBIT = 'https://api.bybit.com/v5/market';
const DAY = 86_400_000;
// BTC rallies, start day -> top of the wave (UTC). Edit here to change them.
export const RALLIES = [
  { name: 'Hausse 1', start: '2026-03-02', end: '2026-05-26' },
  { name: 'Hausse 2', start: '2026-07-01', end: '2026-09-21' },
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

async function daily(symbol, limit) {
  const list = (await get('kline', { category: 'spot', symbol, interval: 'D', limit: String(limit) })).list || [];
  const rows = list.map((k) => [Number(k[0]), Number(k[2]), Number(k[3]), Number(k[4])]).filter((r) => r[3] > 0).sort((a, b) => a[0] - b[0]);
  return { t: rows.map((r) => r[0]), h: rows.map((r) => r[1]), l: rows.map((r) => r[2]), c: rows.map((r) => r[3]) };
}

export async function buildFollowers(now = Date.now()) {
  // Window: entry at the close of the day before the start (= open of the start day), through the end day.
  const windows = RALLIES.map((r) => ({ ...r, t0: Date.parse(r.start) - DAY, t1: Date.parse(r.end) }));
  const days = Math.ceil((now - windows[0].t0) / DAY) + 5;
  const btc = await daily('BTCUSDT', days);
  const btcMoves = tokenSwings(btc, windows);
  const tickers = (await get('tickers', { category: 'spot' })).list || [];
  const universe = selectUniverse(tickers, { limit: 500 }).map((t) => t.symbol);
  const tokens = [];
  let next = 0;
  await Promise.all(Array.from({ length: 10 }, async () => {
    while (next < universe.length) {
      const s = universe[next++];
      try {
        const b = await daily(s, days);
        const moves = tokenSwings(b, windows);
        if (moves.every((m) => m == null)) continue;
        const ok = moves.filter(Boolean);
        tokens.push({
          symbol: s, moves, ...corrBeta(b, btc, windows[0].t0),
          beatsBtc: moves.every((m, k) => m != null && m.max > btcMoves[k].max),
          avgMax: ok.reduce((a, m) => a + m.max, 0) / ok.length,
        });
      } catch { /* skipped */ }
    }
  }));
  return { generatedAt: now, rallies: windows, btc: btcMoves, universe: universe.length, tokens: tokens.sort((a, b) => b.avgMax - a.avgMax) };
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
