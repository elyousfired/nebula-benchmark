import { useEffect, useMemo, useState } from 'react';
import { Header } from './components/Panels.jsx';
import { SqueezeChart } from './components/SqueezeChart.jsx';
import { fmtPct, fmtPrice, fmtTime, fmtUsd, pctClass, PHASES } from './lib/format.js';

const API_EVERY = 5 * 60_000;
const PERFS = [['m15', '15m'], ['h1', '1h'], ['h4', '4h'], ['d1', '24h'], ['w1', '7J'], ['d30', '30J']];

/**
 * The first 5 of the Top 50 (30D score). `top50` is App's own list from the
 * shared scan, so ranks and prices are exactly the main page's.
 */
export default function Top5Page({ scan, top50, onBack }) {
  const top5 = top50.slice(0, 5);
  const ready = scan.status === 'ready' && !scan.scanning;
  const key = useMemo(() => (ready ? top5.map((t) => t.symbol).sort().join(',') : ''), [ready, top5]);
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
        <span className="card-title">🥇 TOP 5 · SCORE 30D</span>
        <span className="muted small">Les 5 premiers du Top 50 de la page principale, mêmes rangs et mêmes prix (live).</span>
      </nav>
      {!ready && top5.length > 0 && <div className="card warn small">⏳ Scan en cours ({scan.progress.done}/{scan.progress.total}) : classement provisoire, il peut changer à la fin du scan.</div>}
      {err && <div className="error-line">⚠ box 14J indisponible : {err}</div>}

      {!top5.length ? (
        <div className="card empty">{scan.status === 'error' ? `Impossible de charger Bybit : ${scan.error}` : 'Scan du Top 50…'}</div>
      ) : <div className="t5-grid">{top5.map((t) => {
        const b = boxes[t.symbol];
        const ph = PHASES[t.phase];
        // Chart always shows; the 14-day box is added once /api/squeeze answers.
        const row = b ? { ...b, price: t.price } : { symbol: t.symbol, price: t.price };
        const dist = b ? t.price / b.high - 1 : null;
        return (
          <div key={t.symbol} className="card t5-card">
            <div className="card-head">
              <div className="t5-title">
                <span className="t5-rank">#{t.rank}</span>
                <span className="t5-sym">{t.base}</span>
                <span className="t5-price">{fmtPrice(t.price)}</span>
                {ph && <span className="chip" style={{ color: ph.color, borderColor: `${ph.color}66` }} title={ph.desc}>{ph.label}</span>}
                {b && <span className={`sq-st ${b.status}`}>{b.status}</span>}
              </div>
              <div className="vp-legend">
                <span className="chip gold">Score 30D <b>{t.scores?.month?.toFixed(1) ?? '—'}</b></span>
                <span className="chip">Vol 24h <b>{fmtUsd(t.turnover24h)}</b></span>
              </div>
            </div>
            <div className="t5-perfs">
              {PERFS.map(([k, label]) => (
                <div key={k} className="t5-perf"><span className="muted small">{label}</span><b className={pctClass(t.perf[k])}>{fmtPct(t.perf[k])}</b></div>
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
      })}</div>}
      <footer className="footer">Graphique : bougies 4H sur ~30 jours, box 14J (plafond en pointillés). Prix live Bybit · MAJ {fmtTime(Date.now())} · Ceci n'est pas un conseil financier.</footer>
    </div>
  );
}
