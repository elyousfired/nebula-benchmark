# Nebula · Top 50 Benchmark (v2)

This is a rebuild, from zero, of the **TOP 50 BENCHMARK: PRIX VS SCORE** page. The old page was `src/MonthlyTop50BenchmarkComparator.jsx`, a single 8,584-line file. The new one is a standalone Vite + React app with no chart dependency: the charts are drawn in SVG.

## Run it

```bash

npm install
npm run dev     # http://localhost:5173
npm test        # tests for the logic (node:test, no dependency)
npm run build
```

**Vercel:** import this repo as a new project (Vite framework, default settings). The `api/bybit.js` function is a fallback proxy restricted to `kline` and `tickers`. It runs in the region set in `vercel.json` (`fra1`) because Bybit blocks US IPs.

## Structure

```
src/core/        pure logic, tested
  bars.js          parsing, merging, aligned 4H resampling, EMA, price at a given time
  metrics.js       15m/1h/4h/24h/7d/30d performance, 30D high, 4H EMA20/50, phase
  scoring.js       percentile score 0–100 + confluence, top lists
  curves.js        curves aligned by timestamp + benchmark + EMA20
  levels.js        24H launchpad / rejection wall
  volumeProfile.js collective profile, POC, value area
  backtest.js      24H replay (first of TP / SL touched)
  signals.js       live launchpad alerts
  universe.js      pair filter (BTC/ETH, stables, leveraged, tokenized stocks)
src/lib/         Bybit client (retry, rate limit, proxy fallback), CoinGecko, formatting
src/hooks/       useMarketScan (data + refresh), useSignals (alerts + localStorage)
src/components/  PerfChart (SVG), panels, table
api/bybit.js     whitelisted Vercel proxy
dev/mockBybit.js synthetic Bybit data (tests + offline preview)
```

## Fixes compared with the old page

| Problem in the old page | Fix |
|---|---|
| "30D" = 1000 × 15m candles ≈ **10.4 days** (also affected the 30D high, ATH 30D and EMA50 4H) | 1H candles × 1000 (≈41 days), lookbacks measured by **timestamp** |
| 4H candles built every 16 candles from index 0 (not aligned, last one partial) | 1H → 4H resampling **aligned on the UTC grid** |
| Curves aligned by **array index** (shifted when a token was missing candles) | Aligned by **timestamp**; a missing token is simply left out of the average at that time |
| Score = confluence points (0–12) + raw % (one +80% token dominated everything) | Score 0–100 = **weighted percentile rank** × (0.5 + 0.5 × confluence) |
| `price < ema20 - 3.0` (3 dollars, not 3%) | 4H EMA20 distance in % |
| Missing history → perf = 0 | `null`, and the token is excluded from that horizon's ranking |
| Failed fetch → old cache returned silently, still shown as "100% LIVE" | **STALE** / failure counts in the header, STALE badge per token |
| Public CORS proxies (allorigins, corsproxy…) | Direct call, then the site's own `/api/bybit` proxy if needed |
| `price24hPcnt` guessed with `abs < 1` (wrong above +100%) | Always ratio × 100 |
| Win rate shown as **80%** when no trade was decided; TP checked before SL | `—` when nothing is decided; outcome = **first** level touched |
| Full scan (650 × 1000 candles) every 35 s; raw string candles kept in state | Tickers every 20 s, last candles every 5 min, full scan every 60 min; numbers parsed once |
| "Achat / Vente" presented as real flow | Labelled "est." (estimated from candle shape) |
| Tokens from `token_entries.json` scanned even if delisted | Universe = top 500 Bybit pairs by 24h turnover |

## Not carried over (v1)

Corridor Sniper chart, DeFiLlama diagnostics, synthetic candle chart and the TradingView R:R tool. They can be added later as separate components on top of `core/`.
