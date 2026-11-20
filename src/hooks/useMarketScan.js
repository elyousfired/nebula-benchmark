import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchTickers, fetchKlines, pool, currentRoute } from '../lib/bybit.js';
import { parseKlines, mergeBars, patchLive, INTERVAL_MS } from '../core/bars.js';
import { computeTokenMetrics, tickerPct24h } from '../core/metrics.js';
import { scoreUniverse } from '../core/scoring.js';
import { selectUniverse } from '../core/universe.js';

// Refresh policy (the old page re-downloaded 650 × 1000 candles every 35 s):
//  - tickers (1 request for all prices)  every 20 s  -> live prices & perfs
//  - last 4 candles per token            every 5 min -> curves move forward
//  - full rescan                          every 60 min or on demand
const TICKER_EVERY = 20_000;
const TAIL_EVERY = 5 * 60_000;
const FULL_EVERY = 60 * 60_000;
const TICKER_STALE_AFTER = 70_000;

const LEN15 = 100; // ~25h of 15m candles
const LEN60 = 1000; // ~41 days of 1H candles (Bybit max per request)

export function useMarketScan({ universeSize = 500 } = {}) {
  const seriesRef = useRef({}); // sym -> { bars15, bars60 }
  const liveRef = useRef({}); // sym -> live-patched series used for curves
  const tickersRef = useRef({}); // sym -> ticker
  const symbolsRef = useRef([]);
  const busyRef = useRef(false);

  const [state, setState] = useState({
    status: 'idle', // idle | scanning | ready | error
    progress: { done: 0, total: 0 },
    tokens: [],
    version: 0,
    lastTickerAt: 0,
    lastTailAt: 0,
    btc: null,
    failed: 0,
    error: null,
    route: 'direct',
  });

  const recompute = useCallback((extra = {}) => {
    const now = Date.now();
    const out = [];
    const live = {};
    for (const sym of symbolsRef.current) {
      const s = seriesRef.current[sym];
      if (!s) continue;
      const tk = tickersRef.current[sym];
      const price = Number(tk?.lastPrice);
      const ls = {
        bars15: patchLive(s.bars15, INTERVAL_MS['15'], price, now),
        bars60: patchLive(s.bars60, INTERVAL_MS['60'], price, now),
      };
      live[sym] = ls;
      const m = computeTokenMetrics({ symbol: sym, ...ls, ticker: tk, now });
      if (m) out.push(m);
    }
    liveRef.current = live;
    const scored = scoreUniverse(out);
    setState((st) => ({ ...st, ...extra, tokens: scored, version: st.version + 1, route: currentRoute() }));
  }, []);

  const applyTickers = useCallback((list) => {
    const map = {};
    for (const t of list) map[t.symbol] = t;
    tickersRef.current = map;
    const b = map.BTCUSDT;
    return b ? { price: Number(b.lastPrice), change24h: tickerPct24h(b), turnover24h: Number(b.turnover24h) } : null;
  }, []);

  const fullScan = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setState((st) => ({ ...st, status: st.tokens.length ? 'ready' : 'scanning', scanning: true, error: null, progress: { done: 0, total: 0 } }));
    try {
      const tickers = await fetchTickers();
      const btc = applyTickers(tickers);
      const universe = selectUniverse(tickers, { limit: universeSize });
      symbolsRef.current = universe.map((t) => t.symbol);
      setState((st) => ({ ...st, btc, lastTickerAt: Date.now(), progress: { done: 0, total: universe.length } }));

      let lastPaint = 0;
      const results = await pool(
        symbolsRef.current,
        async (sym) => {
          const [k15, k60] = await Promise.all([fetchKlines(sym, '15', LEN15), fetchKlines(sym, '60', LEN60)]);
          seriesRef.current[sym] = { bars15: parseKlines(k15), bars60: parseKlines(k60) };
          return true;
        },
        {
          concurrency: 6,
          onProgress: (done, total) => {
            setState((st) => ({ ...st, progress: { done, total } }));
            if (done - lastPaint >= 60) { lastPaint = done; recompute(); }
          },
        },
      );
      const failed = results.filter((r) => r && r.error).length;
      recompute({ status: 'ready', scanning: false, failed, lastTailAt: Date.now() });
    } catch (e) {
      setState((st) => ({ ...st, status: st.tokens.length ? 'ready' : 'error', scanning: false, error: e.message || String(e) }));
    } finally {
      busyRef.current = false;
    }
  }, [applyTickers, recompute, universeSize]);

  const refreshTickers = useCallback(async () => {
    try {
      const tickers = await fetchTickers();
      const btc = applyTickers(tickers);
      recompute({ btc, lastTickerAt: Date.now() });
    } catch {
      // keep old data; the header turns STALE after TICKER_STALE_AFTER
      setState((st) => ({ ...st }));
    }
  }, [applyTickers, recompute]);

  const refreshTails = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const results = await pool(symbolsRef.current, async (sym) => {
        const s = seriesRef.current[sym];
        if (!s) return true;
        const [k15, k60] = await Promise.all([fetchKlines(sym, '15', 4), fetchKlines(sym, '60', 4)]);
        seriesRef.current[sym] = {
          bars15: mergeBars(s.bars15, parseKlines(k15), LEN15 + 20),
          bars60: mergeBars(s.bars60, parseKlines(k60), LEN60),
        };
        return true;
      }, { concurrency: 6 });
      recompute({ lastTailAt: Date.now(), failed: results.filter((r) => r && r.error).length });
    } finally {
      busyRef.current = false;
    }
  }, [recompute]);

  useEffect(() => {
    fullScan();
    const a = setInterval(refreshTickers, TICKER_EVERY);
    const b = setInterval(refreshTails, TAIL_EVERY);
    const c = setInterval(fullScan, FULL_EVERY);
    // Re-render once in a while so the STALE badge appears even if every request fails.
    const d = setInterval(() => setState((st) => ({ ...st })), 10_000);
    return () => { clearInterval(a); clearInterval(b); clearInterval(c); clearInterval(d); };
  }, [fullScan, refreshTickers, refreshTails]);

  const now = Date.now();
  const tickerStale = state.lastTickerAt > 0 && now - state.lastTickerAt > TICKER_STALE_AFTER;
  const staleTokens = state.tokens.filter((t) => t.stale).length;

  return {
    ...state,
    tickerStale,
    staleTokens,
    liveSeries: liveRef.current,
    rescan: fullScan,
  };
}
