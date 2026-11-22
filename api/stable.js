// Slow Top 50 (30D + 7D perf) at each of the last 30 daily closes, for the
// /stable page. Same universe as the site (selectUniverse on Bybit spot
// tickers). Region fra1 (vercel.json). Edge-cached 1 hour.

import { selectUniverse } from '../src/core/universe.js';
import { dailySlowTops, WINDOW_DAYS } from '../src/core/stable.js';

const BYBIT = 'https://api.bybit.com/v5/market';
const DAY = 86_400_000;

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

async function pool(items, worker, concurrency = 10) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const it = items[next++]; try { await worker(it); } catch { /* skipped */ } }
  }));
}

export async function buildStable(now = Date.now()) {
  const tickers = (await get('tickers', { category: 'spot' })).list || [];
  const universe = selectUniverse(tickers, { limit: 500 }).map((t) => t.symbol);
  const daily = {};
  await pool(universe, async (symbol) => {
    const list = (await get('kline', { category: 'spot', symbol, interval: 'D', limit: String(WINDOW_DAYS + 40) })).list || [];
    const rows = list.map((k) => [Number(k[0]), Number(k[4])]).filter(([t, c]) => c > 0 && t + DAY <= now).sort((a, b) => a[0] - b[0]);
    if (rows.length > 30) daily[symbol] = { t: rows.map((r) => r[0]), c: rows.map((r) => r[1]) };
  });
  return { generatedAt: now, universe: universe.length, loaded: Object.keys(daily).length, ...dailySlowTops(daily, { now }) };
}

export default async function handler(req, res) {
  try {
    const body = await buildStable();
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=1800');
    res.status(200).json(body);
  } catch (e) {
    res.status(502).json({ error: `upstream error: ${e.message}` });
  }
}
