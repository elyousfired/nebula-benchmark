// Market caps for the listed tokens (free CoinGecko API, cached 5 min).
// When several coins share a ticker, the one with the largest market cap wins.

const TTL = 5 * 60_000;
const cache = new Map(); // SYM -> { marketCap, volume, at }

export function cachedCaps(symbols) {
  const out = {};
  for (const s of symbols) {
    const c = cache.get(s);
    if (c) out[s] = c;
  }
  return out;
}

export async function fetchMarketCaps(symbols) {
  const now = Date.now();
  const missing = symbols.filter((s) => {
    const c = cache.get(s);
    return !c || now - c.at > TTL;
  });
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50).map((s) => s.toLowerCase());
    // Through our own function: CoinGecko's free API sends no CORS header on errors / rate limits.
    const url = `/api/coingecko?symbols=${chunk.join(',')}`;
    try {
      const res = await fetch(url);
      if (!res.ok) break; // 429 etc: keep cached values, try again later
      const data = await res.json();
      const best = new Map();
      for (const c of Array.isArray(data) ? data : []) {
        const s = String(c.symbol || '').toUpperCase();
        if (!s) continue;
        const cur = best.get(s);
        if (!cur || (c.market_cap || 0) > cur.marketCap) {
          best.set(s, { marketCap: c.market_cap || 0, volume: c.total_volume || 0, at: now });
        }
      }
      for (const [s, v] of best) cache.set(s, v);
    } catch {
      break;
    }
  }
  return cachedCaps(symbols);
}
