// Market caps for the listed tokens (free CoinGecko API, cached 5 min).
// When several coins share a ticker, the one with the largest market cap wins.

const TTL = 5 * 60_000;
const cache = new Map(); // SYM -> { marketCap, volume, at } (marketCap 0 = not found)
let blockedUntil = 0; // back off after a 429

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
  if (now < blockedUntil) return cachedCaps(symbols);
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
      if (!res.ok) { // 429 etc: keep cached values, wait before asking again
        blockedUntil = Date.now() + 2 * 60_000;
        break;
      }
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
      // Remember misses too, so unknown tickers aren't re-requested on every refresh.
      for (const s of chunk) if (!best.has(s.toUpperCase())) cache.set(s.toUpperCase(), { marketCap: 0, volume: 0, at: now });
      for (const [s, v] of best) cache.set(s, v);
    } catch {
      break;
    }
  }
  return cachedCaps(symbols);
}
