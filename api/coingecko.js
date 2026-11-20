// Market caps from CoinGecko's free API, cached at the edge for 5 minutes.
// Only `symbols` (letters, digits, commas) is forwarded.

export default async function handler(req, res) {
  const symbols = String(req.query?.symbols || '').toLowerCase();
  if (!/^[a-z0-9,]{1,800}$/.test(symbols)) {
    res.status(400).json({ error: 'invalid symbols' });
    return;
  }
  try {
    const upstream = await fetch(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&symbols=${symbols}&per_page=250&page=1`,
      { headers: { accept: 'application/json' } },
    );
    const body = await upstream.text();
    res.setHeader('Content-Type', 'application/json');
    if (upstream.ok) res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(upstream.status).send(body);
  } catch (e) {
    res.status(502).json({ error: `upstream error: ${e.message}` });
  }
}
