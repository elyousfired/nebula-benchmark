// Squeeze Radar data: 4H boxes, quiet_pct, volume ratio and status for the
// Top 50 (30D score) symbols the page sends, plus the BTC regime.
// Region fra1 (vercel.json; Bybit blocks US IPs). Edge-cached 15 minutes.
//
// GET /api/squeeze?symbols=AAAUSDT,BBBUSDT,...   (max 50, sorted by the page)

import { parseKlines } from '../src/core/bars.js';
import { analyzeSymbol, btcRegime, sortRows } from '../src/core/squeeze.js';

const BYBIT = 'https://api.bybit.com/v5/market/kline';
const SYM = /^[A-Z0-9]{1,20}USDT$/;

async function klines(symbol, interval, limit) {
  const qs = new URLSearchParams({ category: 'spot', symbol, interval, limit: String(limit) });
  let err;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`${BYBIT}?${qs}`, { headers: { 'User-Agent': 'nebula-benchmark/1.0' } });
      const j = await r.json();
      if (j.retCode === 0) return parseKlines(j.result?.list || []);
      err = new Error(j.retMsg || `retCode ${j.retCode}`);
    } catch (e) {
      err = e;
    }
    await new Promise((res) => setTimeout(res, 400 * (a + 1)));
  }
  throw err;
}

async function pool(items, worker, concurrency = 10) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await worker(items[i]); } catch (e) { out[i] = { error: e.message || String(e) }; }
    }
  }));
  return out;
}

export async function buildSqueeze(symbols, now = Date.now()) {
  const [btcDaily, rows] = await Promise.all([
    klines('BTCUSDT', 'D', 60).catch(() => null),
    pool(symbols, async (symbol) => {
      const [b4, b1h] = await Promise.all([klines(symbol, '240', 1000), klines(symbol, '60', 200)]);
      return analyzeSymbol({ symbol, b4, b1h, now });
    }),
  ]);
  const ok = rows.filter((r) => r && !r.error);
  return {
    generatedAt: now,
    regime: btcDaily ? btcRegime(btcDaily) : null,
    rows: sortRows(ok),
    failed: symbols.filter((s, i) => !rows[i] || rows[i].error),
  };
}

export default async function handler(req, res) {
  const symbols = [...new Set(String(req.query?.symbols || '').toUpperCase().split(',').filter(Boolean))];
  if (!symbols.length || symbols.length > 50 || !symbols.every((s) => SYM.test(s))) {
    res.status(400).json({ error: 'symbols: 1-50 Bybit USDT spot symbols, comma separated' });
    return;
  }
  try {
    const body = await buildSqueeze(symbols.sort());
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=300');
    res.status(200).json(body);
  } catch (e) {
    res.status(502).json({ error: `upstream error: ${e.message}` });
  }
}
