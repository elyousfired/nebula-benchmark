// Slow Top 50 (30D + 7D perf) at each of the last 30 daily closes, plus the
// backtested "stable breakout" signals of the last 10 days and the tokens close
// to one, for the /stable page. Same universe as the site. Region fra1
// (vercel.json). Edge-cached 1 hour.

import { selectUniverse } from '../src/core/universe.js';
import { dailySlowTops, stableSetup, SETUP, WINDOW_DAYS } from '../src/core/stable.js';

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

/** Breakout signals of the last `SETUP.maxDays` days and tokens near one, from the daily bars. */
export function stableSignals(daily, h40) {
  const nDays = h40.days.length;
  const daysIn = (s, k) => { let n = 0; for (let z = k - WINDOW_DAYS + 1; z <= k; z++) if (z >= 0 && h40.tops[z].some((r) => r.symbol === s)) n++; return n; };
  const signals = []; const watch = [];
  for (const [s, b] of Object.entries(daily)) {
    for (let k = nDays - SETUP.maxDays; k < nDays; k++) {
      const i = b.t.indexOf(h40.days[k]);
      if (i < 0 || daysIn(s, k) < SETUP.minDays) continue;
      const x = stableSetup(b, i);
      if (!x) continue;
      if (x.breakout) {
        let state = 'OPEN';
        for (let j = i + 1; j < b.t.length; j++) {
          if (b.l[j] <= x.stop) { state = 'SL'; break; }
          if (b.h[j] >= x.target) { state = 'TP'; break; }
        }
        signals.push({ symbol: s, day: b.t[i], entry: x.entry, stop: x.stop, target: x.target, width20: x.width20, expires: b.t[i] + DAY + SETUP.maxDays * DAY, state });
      } else if (x.near && k === nDays - 1) {
        watch.push({ symbol: s, day: b.t[i], close: x.entry, hi20: x.hi20, width20: x.width20, dist: x.hi20 / x.entry - 1 });
      }
    }
  }
  return { signals: signals.sort((a, b) => b.day - a.day), watch: watch.sort((a, b) => a.dist - b.dist) };
}

export async function buildStable(now = Date.now()) {
  const tickers = (await get('tickers', { category: 'spot' })).list || [];
  const universe = selectUniverse(tickers, { limit: 500 }).map((t) => t.symbol);
  const daily = {};
  await pool(universe, async (symbol) => {
    const list = (await get('kline', { category: 'spot', symbol, interval: 'D', limit: String(WINDOW_DAYS + 50) })).list || [];
    const rows = list.map((k) => [Number(k[0]), Number(k[2]), Number(k[3]), Number(k[4])]).filter(([t, , , c]) => c > 0 && t + DAY <= now).sort((a, b) => a[0] - b[0]);
    if (rows.length > 30) daily[symbol] = { t: rows.map((r) => r[0]), h: rows.map((r) => r[1]), l: rows.map((r) => r[2]), c: rows.map((r) => r[3]) };
  });
  // 40 days of tops so the last 10 days each have their own 30-day window.
  const h40 = dailySlowTops(daily, { now, days: WINDOW_DAYS + SETUP.maxDays });
  const { signals, watch } = stableSignals(daily, h40);
  return {
    generatedAt: now, universe: universe.length, loaded: Object.keys(daily).length,
    days: h40.days.slice(-WINDOW_DAYS), tops: h40.tops.slice(-WINDOW_DAYS), setup: SETUP, signals, watch,
  };
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
