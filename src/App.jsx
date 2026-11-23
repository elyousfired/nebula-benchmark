import { useEffect, useMemo, useState } from 'react';
import { useMarketScan } from './hooks/useMarketScan.js';
import { useSignals } from './hooks/useSignals.js';
import { topList, HORIZONS } from './core/scoring.js';
import { buildCurves } from './core/curves.js';
import { collectiveLevels, sniperLevels } from './core/levels.js';
import { volumeProfile } from './core/volumeProfile.js';
import { replayAll } from './core/backtest.js';
import { marketSentiment } from './core/sentiment.js';
import { fetchMarketCaps, cachedCaps } from './lib/coingecko.js';
import { PerfChart } from './components/PerfChart.jsx';
import { TokenTable } from './components/TokenTable.jsx';
import { Header, Controls, SentimentBar, VolumeProfilePanel, QuantPanel, SignalsPanel, Toast } from './components/Panels.jsx';
import { colorOf, fmtPts } from './lib/format.js';
import SqueezePage from './SqueezePage.jsx';
import AgentPage from './AgentPage.jsx';
import Top5Page from './Top5Page.jsx';
import ComboPage from './ComboPage.jsx';
import StablePage from './StablePage.jsx';
import FollowersPage from './FollowersPage.jsx';
import ForecastPage from './ForecastPage.jsx';

const ROUTES = { '/squeeze': 'squeeze', '/agent': 'agent', '/top5': 'top5', '/combo': 'combo', '/stable': 'stable', '/btc': 'btc', '/forecast': 'forecast' };
const routeOf = () => ROUTES[window.location.pathname.replace(/\/$/, '')] || 'main';

const OPTS_KEY = 'nebula_bench_v2_opts';
const DEFAULT_OPTS = { universe: 'score', horizon: 'month', topN: 50, showBench: true, showLevels: true, showProfile: true };

function loadOpts() {
  try { return { ...DEFAULT_OPTS, ...JSON.parse(localStorage.getItem(OPTS_KEY) || '{}') }; } catch { return DEFAULT_OPTS; }
}

/** Bucket size so the profile has at most ~60 rows. */
function pickBucket(curves) {
  let lo = 0; let hi = 0;
  for (const pts of Object.values(curves)) for (const p of pts) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; }
  const raw = (hi - lo) / 60;
  return [1, 2, 5, 10, 20, 25, 50].find((s) => s >= raw) || 100;
}

export default function App() {
  const scan = useMarketScan();
  // One scan for both pages: switching route never rescans, so /squeeze sees the exact same Top 50.
  const [route, setRoute] = useState(routeOf);
  useEffect(() => { const f = () => setRoute(routeOf()); window.addEventListener('popstate', f); return () => window.removeEventListener('popstate', f); }, []);
  const go = (path) => (e) => { e.preventDefault(); window.history.pushState(null, '', path); setRoute(routeOf()); window.scrollTo(0, 0); };
  const [opts, setOpts] = useState(loadOpts);
  const [highlight, setHighlight] = useState(null);
  const [caps, setCaps] = useState({});
  const set = (patch) => setOpts((o) => {
    const n = { ...o, ...patch };
    try { localStorage.setItem(OPTS_KEY, JSON.stringify(n)); } catch { /* ignore */ }
    return n;
  });

  const { version, tokens, liveSeries } = scan;
  const ready = scan.status === 'ready' && !scan.scanning;
  const now = useMemo(() => Date.now(), [version]); // eslint-disable-line react-hooks/exhaustive-deps

  // Top 50 for the table; chart shows the first N.
  const list = useMemo(() => topList(tokens, opts.horizon, 50, opts.universe), [tokens, opts.horizon, opts.universe]);
  const chartList = useMemo(() => list.slice(0, opts.topN), [list, opts.topN]);

  const chart = useMemo(
    () => buildCurves(chartList, liveSeries, opts.horizon, now),
    [chartList, liveSeries, opts.horizon, now],
  );

  // 24H curves of the 50 listed tokens drive the launchpad levels and the replay.
  const day = useMemo(
    () => (opts.horizon === 'day' && opts.topN === 50 ? chart : buildCurves(list, liveSeries, 'day', now)),
    [opts.horizon, opts.topN, chart, list, liveSeries, now],
  );
  const levels = useMemo(() => (Object.keys(day.curves).length ? collectiveLevels(day.curves) : null), [day]);
  const sniper = useMemo(() => (levels ? sniperLevels(levels) : null), [levels]);
  const bt = useMemo(() => (sniper ? replayAll(day.curves, sniper) : null), [day, sniper]);

  // Alerts always watch the Top 50 by 30D score, on 24H curves.
  const alertList = useMemo(() => topList(tokens, 'month', 50, 'score'), [tokens]);
  const alertCurves = useMemo(() => buildCurves(alertList, liveSeries, 'day', now).curves, [alertList, liveSeries, now]);
  const alertRanks = useMemo(() => Object.fromEntries(alertList.map((t) => [t.symbol, t.rank])), [alertList]);
  const signals = useSignals({ curves: alertCurves, levels: sniper, ranks: alertRanks, version, enabled: ready });

  // Collective volume profile over every scanned token.
  const vp = useMemo(() => {
    if (!opts.showProfile || !tokens.length) return { buckets: [] };
    const all = buildCurves(tokens, liveSeries, opts.horizon, now).curves;
    return volumeProfile(all, { bucket: pickBucket(all) });
  }, [opts.showProfile, opts.horizon, tokens, liveSeries, now]);

  const sentiment = useMemo(() => marketSentiment(chart.curves), [chart]);

  // Market caps for Vol/MC (top 50 only, cached 5 min).
  const capKey = list.map((t) => t.base).sort().join(',');
  useEffect(() => {
    if (!capKey) return undefined;
    const bases = capKey.split(',');
    setCaps(cachedCaps(bases));
    let alive = true;
    fetchMarketCaps(bases).then((c) => { if (alive) setCaps(c); });
    return () => { alive = false; };
  }, [capKey]);

  const hlines = opts.showLevels && opts.horizon === 'day' && sniper ? [
    { v: sniper.tp, label: 'Mur de rejet / TP', short: `TP ${fmtPts(sniper.tp, 1)}`, color: '#f43f5e' },
    { v: sniper.entry, label: 'Launchpad', short: `LP ${fmtPts(sniper.entry, 1)}`, color: '#22d3ee' },
    { v: sniper.sl, label: 'Stop', short: `SL ${fmtPts(sniper.sl, 1)}`, color: '#f87171', dash: '2 4' },
  ] : [];

  const order = chartList.map((t) => t.symbol).filter((s) => chart.curves[s]);
  const lastBench = chart.bench.length ? chart.bench[chart.bench.length - 1].v : null;
  const lastEma = chart.ema.length ? chart.ema[chart.ema.length - 1].v : null;
  const hLabel = HORIZONS[opts.horizon].label;

  if (route === 'forecast') return <ForecastPage scan={scan} onBack={go('/')} />;
  if (route === 'btc') return <FollowersPage scan={scan} onBack={go('/')} />;
  if (route === 'stable') return <StablePage scan={scan} onBack={go('/')} />;
  if (route === 'combo') return <ComboPage scan={scan} top50={alertList} onBack={go('/')} />;
  if (route === 'top5') return <Top5Page scan={scan} top50={alertList} onBack={go('/')} />;
  if (route === 'agent') return <AgentPage onBack={go('/')} />;
  if (route === 'squeeze') return <SqueezePage scan={scan} top50={alertList} onBack={go('/')} signalSymbols={signals.history.filter((s) => s.status === 'ACTIVE').map((s) => s.symbol)} />;

  return (
    <div className="app">
      <Header scan={scan} onRescan={scan.rescan} />
      <Controls opts={opts} set={set} />
      <div className="controls"><a className="btn" href="/top5" onClick={go('/top5')}>🥇 Top 5 →</a><a className="btn" href="/combo" onClick={go('/combo')}>🎯 Top 5 30J ∩ 24H →</a><a className="btn" href="/stable" onClick={go('/stable')}>🧱 Top 50 stables →</a><a className="btn" href="/btc" onClick={go('/btc')}>₿ Hausses BTC →</a><a className="btn" href="/forecast" onClick={go('/forecast')}>🔭 Prévision →</a><a className="btn" href="/squeeze" onClick={go('/squeeze')}>📦 Squeeze Radar →</a><a className="btn" href="/agent" onClick={go('/agent')}>🤖 Agent Top 50 →</a></div>

      {tokens.length === 0 ? (
        <div className="card empty">
          {scan.status === 'error' ? `Impossible de charger Bybit : ${scan.error}` : 'Chargement des données Bybit…'}
        </div>
      ) : (
        <>
          <SentimentBar s={sentiment} horizonLabel={hLabel} />

          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">
                  {opts.universe === 'peak' ? '🔥 TOP PICS (ATH 30D)' : '👑 TOP SCORE'} · COURBES {hLabel} · TOP {opts.topN}
                </div>
                <div className="muted small">
                  Performance en points (%) depuis le début de la période · bougies {opts.horizon === 'day' ? '15m' : opts.horizon === 'week' ? '1H' : '4H'} alignées UTC
                </div>
              </div>
              {opts.showBench && (
                <div className="vp-legend">
                  <span className="chip">Benchmark <b>{fmtPts(lastBench)}</b></span>
                  <span className="chip gold">EMA20 bench <b>{fmtPts(lastEma)}</b></span>
                </div>
              )}
            </div>
            <PerfChart
              curves={chart.curves}
              order={order}
              bench={chart.bench}
              ema={chart.ema}
              hlines={hlines}
              horizon={opts.horizon}
              highlight={highlight}
              onHighlight={setHighlight}
              showBench={opts.showBench}
            />
            <div className="legend">
              {order.map((s) => (
                <button key={s} className={`legend-item ${highlight === s ? 'on' : ''}`} onClick={() => setHighlight(highlight === s ? null : s)}>
                  <span className="dot" style={{ background: colorOf(s) }} />{s.replace('USDT', '')}
                </button>
              ))}
            </div>
          </div>

          <div className="grid-2">
            {opts.showProfile ? <VolumeProfilePanel vp={vp} horizonLabel={hLabel} /> : <div />}
            <div className="stack">
              {bt && <QuantPanel levels={levels} sniper={sniper} bt={bt} />}
              <SignalsPanel signals={signals} />
            </div>
          </div>

          <TokenTable list={list} horizon={opts.horizon} highlight={highlight} onHighlight={setHighlight} caps={caps} />
        </>
      )}
      <Toast signal={signals.toast} onClose={signals.dismissToast} />
      <footer className="footer">Données : Bybit v5 (spot) · Market caps : CoinGecko · Ceci n'est pas un conseil financier.</footer>
    </div>
  );
}
