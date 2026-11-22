// Shared candle loader for the backtests: Bybit spot klines from `fromMs` to
// now, cached in backtest/cache/{SYMBOL}_{4h|1h|D}.json for 12 h.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bybitGet } from '../src/lib/bybit.js';
import { parseKlines, HOUR, DAY } from '../src/core/bars.js';

export const CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cache');
const IV = { '240': 4 * HOUR, '60': HOUR, D: DAY };

export async function range(symbol, interval, fromMs) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${symbol}_${interval === '240' ? '4h' : interval === '60' ? '1h' : 'D'}.json`);
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c.from <= fromMs && Date.now() - c.fetchedAt < 12 * HOUR) return parseKlines(c.rows);
  } catch { /* no cache */ }
  const rows = [];
  let end = Date.now();
  while (end > fromMs) {
    const r = await bybitGet('kline', { category: 'spot', symbol, interval, limit: '1000', end: String(end) });
    const list = r.list || [];
    if (!list.length) break;
    rows.push(...list);
    const oldest = Number(list[list.length - 1][0]);
    if (list.length < 1000) break;
    end = oldest - IV[interval];
  }
  fs.writeFileSync(file, JSON.stringify({ from: fromMs, fetchedAt: Date.now(), rows }));
  return parseKlines(rows);
}
