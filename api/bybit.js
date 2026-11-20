// Vercel serverless proxy for Bybit public market data, used only when the
// browser cannot reach api.bybit.com directly. Whitelisted endpoints only,
// so it can't be abused as an open proxy.
// Region is set in vercel.json (Bybit blocks US IPs).

const ALLOWED = new Set(['kline', 'tickers']);
const ALLOWED_PARAMS = new Set(['category', 'symbol', 'interval', 'limit', 'start', 'end']);

export default async function handler(req, res) {
  const { endpoint, ...rest } = req.query || {};
  if (!ALLOWED.has(endpoint)) {
    res.status(400).json({ retCode: -1, retMsg: 'endpoint not allowed' });
    return;
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(rest)) {
    if (ALLOWED_PARAMS.has(k) && typeof v === 'string') qs.set(k, v);
  }
  try {
    const upstream = await fetch(`https://api.bybit.com/v5/market/${endpoint}?${qs}`, {
      headers: { 'User-Agent': 'nebula-benchmark/1.0' },
    });
    const body = await upstream.text();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', endpoint === 'tickers' ? 's-maxage=5' : 's-maxage=30, stale-while-revalidate=60');
    res.status(upstream.status).send(body);
  } catch (e) {
    res.status(502).json({ retCode: -1, retMsg: `upstream error: ${e.message}` });
  }
}
