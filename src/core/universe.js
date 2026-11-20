// Which Bybit spot pairs we scan.

const STABLES = new Set([
  'USDC', 'USDT', 'FDUSD', 'DAI', 'TUSD', 'USDE', 'PYUSD', 'USDD', 'BUSD', 'USD1', 'RLUSD',
  'EUR', 'EURC', 'EURI', 'USTC', 'USDQ', 'USDR', 'XUSD', 'BFUSD', 'USDG', 'AUSD',
  'USDS', 'USDY', 'USAT', 'USD0', 'BUSDT', 'FRAX', 'LUSD', 'GHO', 'CRVUSD', 'SUSD', 'USDB', 'USDX',
  'PAXG', 'XAUT',
]);

/** Stablecoins and dollar/gold-backed tokens (flat lines that drag the benchmark toward 0). */
export function isStable(base) {
  return STABLES.has(base) || /^USD[A-Z0-9]{0,2}$/.test(base) || /^[A-Z]{0,2}USD[A-Z]?$/.test(base);
}
const MAJORS_EXCLUDED = new Set(['BTC', 'ETH']);
const STOCK_TICKERS = [
  'AAPL', 'TSLA', 'NVDA', 'AMZN', 'MSFT', 'GOOGL', 'GOOG', 'META', 'COIN', 'MSTR', 'HOOD',
  'SPY', 'QQQ', 'CRCL', 'NFLX', 'AMD', 'PLTR', 'INTC', 'ORCL', 'GME', 'BABA', 'AVGO', 'MCD',
];

export function isLeveraged(base) {
  return /\d+[LS]$/.test(base);
}

export function isTokenizedStock(base) {
  if (!base.endsWith('X')) return false;
  const root = base.slice(0, -1);
  return STOCK_TICKERS.includes(root);
}

/**
 * Filter + rank Bybit spot tickers: USDT pairs only, no BTC/ETH (they would flatten
 * the altcoin benchmark), no stables, leveraged tokens or tokenized stocks,
 * minimum 24h turnover, then top `limit` by turnover.
 */
export function selectUniverse(tickers, { limit = 500, minTurnover = 10_000 } = {}) {
  return (tickers || [])
    .filter((t) => typeof t?.symbol === 'string' && t.symbol.endsWith('USDT'))
    .map((t) => ({ ...t, base: t.symbol.slice(0, -4) }))
    .filter((t) => t.base && !MAJORS_EXCLUDED.has(t.base) && !isStable(t.base))
    .filter((t) => !isLeveraged(t.base) && !isTokenizedStock(t.base))
    .filter((t) => Number(t.turnover24h) >= minTurnover && Number(t.lastPrice) > 0)
    .sort((a, b) => Number(b.turnover24h) - Number(a.turnover24h))
    .slice(0, limit);
}
