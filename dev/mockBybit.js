// Deterministic synthetic Bybit v5 market data, used by tests and the
// offline preview. Responses mimic the real API shape.

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export const MOCK_SYMBOLS = [
  'SOL', 'XRP', 'DOGE', 'SUI', 'PEPE', 'WIF', 'ADA', 'AVAX', 'LINK', 'TON', 'NEAR', 'APT', 'ARB', 'OP',
  'INJ', 'TIA', 'SEI', 'JUP', 'PYTH', 'RNDR', 'FET', 'ONDO', 'ENA', 'BONK', 'TRX', 'DOT', 'LTC', 'BCH',
  'HBAR', 'AAVE', 'UNI', 'MNT', 'KAS', 'STX', 'IMX', 'GALA', 'SAND', 'MANA', 'AXS', 'LDO', 'CRV', 'RUNE',
  'HYPE', 'VIRTUAL', 'AI16Z', 'TAO', 'WLD', 'STRK', 'ZRO', 'POPCAT', 'MEW', 'BRETT', 'NOT', 'ORDI',
  'BTC', 'ETH', 'USDC', 'BTC3L', 'AAPLX',
].map((b) => `${b}USDT`);

// 15m path anchored on a fixed date, so the price really moves as time passes
// (each bar is generated once and cached).
const ANCHOR = Date.UTC(2026, 8, 1);
const Q = 15 * 60000;
const paths = new Map();

function path15(symbol, now) {
  let p = paths.get(symbol);
  if (!p) {
    const drift = (rng(hash(symbol))() - 0.42) * 0.0015 * 0.5;
    const vol = (0.004 + rng(hash(symbol) + 7)() * 0.012) * 0.5;
    p = { r: rng(hash(symbol) + 15), drift, vol, price: 0.01 + rng(hash(symbol) + 3)() * 50, rows: [] };
    paths.set(symbol, p);
  }
  const endT = Math.floor(now / Q) * Q;
  let t = p.rows.length ? p.rows[p.rows.length - 1][0] + Q : ANCHOR;
  while (t <= endT) {
    const o = p.price;
    const pump = p.r() < 0.003 ? 0.05 : 0;
    const c = Math.max(1e-6, o * (1 + p.drift + pump + (p.r() - 0.5) * 2 * p.vol));
    const h = Math.max(o, c) * (1 + p.r() * p.vol);
    const l = Math.min(o, c) * (1 - p.r() * p.vol);
    const v = 1000 + p.r() * 100000;
    p.rows.push([t, o, h, l, c, v, v * c]);
    p.price = c;
    t += Q;
  }
  return p.rows;
}

export function mockKlines(symbol, interval, limit, now) {
  const iv = Number(interval) * 60000;
  const n = Math.min(Number(limit) || 200, 1000);
  // One 15m path (~42 days) aggregated to the requested interval, so 15m / 1H
  // series and the ticker price are consistent with each other.
  const endT = Math.floor(now / Q) * Q;
  const all = path15(symbol, now).filter((r) => r[0] <= endT);
  const base = all.slice(Math.max(0, all.length - 4040));
  const rows = [];
  for (const r of base) {
    const t = Math.floor(r[0] / iv) * iv;
    const last = rows[rows.length - 1];
    if (last && last[0] === t) {
      last[2] = Math.max(last[2], r[2]); last[3] = Math.min(last[3], r[3]);
      last[4] = r[4]; last[5] += r[5]; last[6] += r[6];
    } else rows.push([t, r[1], r[2], r[3], r[4], r[5], r[6]]);
  }
  rows.splice(0, Math.max(0, rows.length - n));
  return {
    retCode: 0,
    retMsg: 'OK',
    result: {
      category: 'spot',
      symbol,
      list: rows.reverse().map((r) => r.map((x, i) => (i === 0 ? String(x) : String(Number(x.toPrecision(8)))))),
    },
  };
}

export function mockTickers(now) {
  return {
    retCode: 0,
    retMsg: 'OK',
    result: {
      category: 'spot',
      list: MOCK_SYMBOLS.map((s) => {
        const k = mockKlines(s, '15', 97, now).result.list;
        const last = Number(k[0][4]);
        const prev = Number(k[96][4]);
        let turnover = 0;
        for (let i = 0; i < 96; i++) turnover += Number(k[i][6]);
        if (s === 'BTCUSDT') return { symbol: s, lastPrice: '59017.8', price24hPcnt: '-0.0414', turnover24h: '1500000000' };
        return {
          symbol: s,
          lastPrice: String(last),
          bid1Price: String(last * 0.9995),
          ask1Price: String(last * 1.0005),
          price24hPcnt: String((last - prev) / prev),
          turnover24h: String(turnover),
        };
      }),
    },
  };
}

/** Route a Bybit URL (or our /api/bybit proxy URL) to a mock JSON body. */
export function mockBybitResponse(url, now) {
  const u = new URL(url, 'http://localhost');
  const endpoint = u.pathname.endsWith('/kline') ? 'kline' : u.pathname.endsWith('/tickers') ? 'tickers' : u.searchParams.get('endpoint');
  if (endpoint === 'tickers') {
    const sym = u.searchParams.get('symbol');
    const all = mockTickers(now);
    if (sym) all.result.list = all.result.list.filter((t) => t.symbol === sym);
    return all;
  }
  if (endpoint === 'kline') {
    return mockKlines(u.searchParams.get('symbol'), u.searchParams.get('interval'), u.searchParams.get('limit'), now);
  }
  return { retCode: 10001, retMsg: 'unknown endpoint' };
}
