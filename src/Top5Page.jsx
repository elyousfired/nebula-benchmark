import { useEffect, useMemo, useState } from 'react';
import { Header } from './components/Panels.jsx';
import { SqueezeChart } from './components/SqueezeChart.jsx';
import { topList } from './core/scoring.js';
import { fmtPct, fmtPrice, fmtTime, fmtUsd, pctClass, PHASES } from './lib/format.js';

const API_EVERY = 5 * 60_000;
const PERFS = [['m15', '15m'], ['h1', '1h'], ['h4', '4h'], ['d1', '24h'], ['w1', '7J'], ['d30', '30J']];
const SECTIONS = [
  { horizon: 'month', label: '30J', title: '🥇 TOP 5 · SCORE 30J' },
  { horizon: 'week', label: '7J', title: '🥈 TOP 5 · SCORE 7J' },
  { horizon: 'day', label: '24H', title: '🥉 TOP 5 · SCORE 24H' },
];

/** One token card: perfs, phase, score of its horizon, squeeze state and 4H chart. */
export function Card({ t, b, label, horizon }) {
  const ph = PHASES[t.phase];
  // Chart always shows; the 14-day box is added once /api/squeeze answers.
  const row = b ? { ...b, price: t.price } : { symbol: t.symbol, price: t.price };
  const dist = b ? t.price / b.high - 1 : null;
  return (
    <div className="card t5-card">
      <div className="card-head">
        <div className="t5-title">
          <span className="t5-rank">#{t.rank}</span>
          <span className="t5-sym">{t.base}</span>
          <span className="t5-price">{fmtPrice(t.price)}</span>
          {ph && <span className="chip" style={{ color: ph.color, borderColor: `${ph.color}66` }} title={ph.desc}>{ph.label}</span>}
          {b && <span className={`sq-st ${b.status}`}>{b.status}</span>}
        </div>
        <div className="vp-legend">
          <span className="chip gold">Score {label} <b>{t.scores?.[horizon]?.toFixed(1) ?? '—'}</b></span>
          <span className="chip">Vol 24h <b>{fmtUsd(t.turnover24h)}</b></span>
        </div>
      </div>
      <div className="t5-perfs">
        {PERFS.map(([k, l]) => (
          <div key={k} className="t5-perf"><span className="muted small">{l}</span><b className={pctClass(t.perf[k])}>{fmtPct(t.perf[k])}</b></div>
        ))}
        <div className="t5-perf"><span className="muted small">vs plus haut 30J</span><b className={pctClass(t.pullbackFromHigh)}>{fmtPct(t.pullbackFromHigh)}</b></div>
        <div className="t5-perf"><span className="muted small">vs EMA20 4H</span><b className={pctClass(t.distEma20)}>{fmtPct(t.distEma20, 1)}</b></div>
        <div className="t5-perf"><span className="muted small">Quiet %</span><b className={b?.quietPct <= 10 ? 'pos' : b?.quietPct <= 25 ? 'gold' : ''}>{b?.quietPct == null ? '—' : b.quietPct.toFixed(0)}</b></div>
        <div className="t5-perf"><span className="muted small">vs plafond 14J</span><b className={dist > 0 ? 'pos' : ''}>{dist == null ? '—' : fmtPct(dist * 100)}</b></div>
        <div className="t5-perf"><span className="muted small">Vol 24h/7J</span><b className={b?.volRatio > 1.5 ? 'pos' : ''}>{b?.volRatio == null ? '—' : `${b.volRatio.toFixed(2)}×`}</b></div>
      </div>
      <SqueezeChart row={row} livePrice={t.price} compact />
      {b?.plan && (
        <div className="small">Plan BREAKOUT : entrée <b>{fmtPrice(b.plan.entry)}</b> · SL <b className="neg">{fmtPrice(b.plan.stop)}</b> · TP <b className="pos">{fmtPrice(b.plan.target)}</b> · fin {new Date(b.plan.expires).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
      )}
    </div>
  );
}

/**
 * The first 5 by 30D, 7D and 24H score. `top50` is App's own 30D list from the
 * shared scan; the 7D and 24H lists use the same tokens and the same topList as
 * the main page with its horizon set to 7D / 24H.
 */
export default function Top5Page({ scan, top50, onBack }) {
  const lists = useMemo(() => ({
    month: top50.slice(0, 5),
    week: topList(scan.tokens, 'week', 5, 'score'),
    day: topList(scan.tokens, 'day', 5, 'score'),
  }), [top50, scan.tokens]);
  const ready = scan.status === 'ready' && !scan.scanning;
  const key = useMemo(
    () => (ready ? [...new Set(Object.values(lists).flat().map((t) => t.symbol))].sort().join(',') : ''),
    [ready, lists],
  );
  const [boxes, setBoxes] = useState({});
  const [err, setErr] = useState(null);

  // Box 14J, quiet %, squeeze status and plan from /api/squeeze (cached 15 min).
  useEffect(() => {
    if (!key) return undefined;
    let alive = true;
    const load = () => fetch(`/api/squeeze?symbols=${key}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { if (alive) { setBoxes(Object.fromEntries(d.rows.map((r) => [r.symbol, r]))); setErr(null); } })
      .catch((e) => alive && setErr(e.message));
    load();
    const id = setInterval(load, API_EVERY);
    return () => { alive = false; clearInterval(id); };
  }, [key]);

  return (
    <div className="app">
      <Header scan={scan} onRescan={scan.rescan} />
      <nav className="controls">
        <a className="btn" href="/" onClick={onBack}>← Benchmark</a>
        <span className="card-title">TOP 5 · 30J · 7J · 24H</span>
        <span className="muted small">Les 5 premiers par score, comme le classement de la page principale sur chaque horizon (mêmes tokens, prix live).</span>
      </nav>
      {!ready && lists.month.length > 0 && <div className="card warn small">⏳ Scan en cours ({scan.progress.done}/{scan.progress.total}) : classements provisoires, ils peuvent changer à la fin du scan.</div>}
      {err && <div className="error-line">⚠ box 14J indisponible : {err}</div>}

      {!lists.month.length ? (
        <div className="card empty">{scan.status === 'error' ? `Impossible de charger Bybit : ${scan.error}` : 'Scan du Top 50…'}</div>
      ) : SECTIONS.map((s) => (
        <section key={s.horizon} className="t5-section">
          <div className="card-title">{s.title}</div>
          <div className="t5-grid">
            {lists[s.horizon].map((t) => <Card key={t.symbol} t={t} b={boxes[t.symbol]} label={s.label} horizon={s.horizon} />)}
          </div>
        </section>
      ))}
      <footer className="footer">Graphique : bougies 4H sur ~30 jours, box 14J (plafond en pointillés). Prix live Bybit · MAJ {fmtTime(Date.now())} · Ceci n'est pas un conseil financier.</footer>
    </div>
  );
}
