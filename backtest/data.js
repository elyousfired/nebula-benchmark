// Shared candle loader for the backtests: Bybit spot klines from `fromMs` to now,
// kept for good in backtest/cache/{SYMBOL}_{4h|1h|D}.json (gitignored).
// Each call only downloads what is missing: the new candles since the last one stored,
// and the older ones if `fromMs` goes further back than what is stored.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bybitGet } from '../src/lib/bybit.js';
import { parseKlines, HOUR, DAY } from '../src/core/bars.js';

export const CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cache');
const IV = { '240': 4 * HOUR, '60': HOUR, D: DAY };

/** Bybit rows (newest first) with open time in [fromMs, endMs]. */
async function pull(symbol, interval, fromMs, endMs) {
  const rows = [];
  let end = endMs;
  while (end >= fromMs) {
    const r = await bybitGet('kline', { category: 'spot', symbol, interval, limit: '1000', end: String(end) });
    const list = r.list || [];
    if (!list.length) break;
    rows.push(...list.filter((x) => Number(x[0]) >= fromMs));
    const oldest = Number(list[list.length - 1][0]);
    if (list.length < 1000 || oldest <= fromMs) break;
    end = oldest - IV[interval];
  }
  return rows;
}

export async function range(symbol, interval, fromMs) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${symbol}_${interval === '240' ? '4h' : interval === '60' ? '1h' : 'D'}.json`);
  let c = null;
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no cache */ }
  const now = Date.now();
  if (!c?.rows?.length) {
    const rows = await pull(symbol, interval, fromMs, now);
    fs.writeFileSync(file, JSON.stringify({ from: fromMs, fetchedAt: now, rows }));
    return parseKlines(rows);
  }
  const byT = new Map(c.rows.map((r) => [r[0], r]));
  let changed = false;
  // newer candles (the last stored one is re-fetched: it may have been still open)
  if (now - c.fetchedAt >= IV[interval]) {
    const newest = Math.max(...c.rows.map((r) => Number(r[0])));
    for (const r of await pull(symbol, interval, newest, now)) byT.set(r[0], r);
    changed = true;
  }
  // older candles, only if asked further back than stored
  if (fromMs < c.from) {
    for (const r of await pull(symbol, interval, fromMs, c.from - 1)) byT.set(r[0], r);
    changed = true;
  }
  const rows = [...byT.values()].sort((a, b) => Number(b[0]) - Number(a[0]));
  if (changed) fs.writeFileSync(file, JSON.stringify({ from: Math.min(c.from, fromMs), fetchedAt: changed ? now : c.fetchedAt, rows }));
  return parseKlines(rows.filter((r) => Number(r[0]) >= fromMs));
}
