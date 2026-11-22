import { useEffect, useMemo, useState } from 'react';
import { Header } from './components/Panels.jsx';
import { Card } from './Top5Page.jsx';
import { topList } from './core/scoring.js';
import { fmtTime } from './lib/format.js';

const API_EVERY = 5 * 60_000;

/**
 * Tokens that are in BOTH the Top 5 by 30D score and the Top 5 by 24H score
 * (same lists as the /top5 page, from the shared scan).
 */
export default function ComboPage({ scan, top50, onBack }) {
  const month = useMemo(() => top50.slice(0, 5), [top50]);
  const day = useMemo(() => topList(scan.tokens, 'day', 5, 'score'), [scan.tokens]);
  const dayRank = useMemo(() => Object.fromEntries(day.map((t) => [t.symbol, t.rank])), [day]);
  const both = useMemo(() => month.filter((t) => dayRank[t.symbol]), [month, dayRank]);
  const ready = scan.status === 'ready' && !scan.scanning;
  const key = useMemo(() => (ready ? both.map((t) => t.symbol).sort().join(',') : ''), [ready, both]);
  const [boxes, setBoxes] = useState({});

  useEffect(() => {
    if (!key) return undefined;
    let alive = true;
    const load = () => fetch(`/api/squeeze?symbols=${key}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { if (alive) setBoxes(Object.fromEntries(d.rows.map((r) => [r.symbol, r]))); })
      .catch(() => {});
    load();
    const id = setInterval(load, API_EVERY);
    return () => { alive = false; clearInterval(id); };
  }, [key]);

  const names = (l) => l.map((t) => `#${t.rank} ${t.base}`).join(', ') || '—';

  return (
    <div className="app">
      <Header scan={scan} onRescan={scan.rescan} />
      <nav className="controls">
        <a className="btn" href="/" onClick={onBack}>← Benchmark</a>
        <span className="card-title">🎯 TOP 5 30J ∩ TOP 5 24H</span>
        <span className="muted small">Uniquement les tokens présents à la fois dans le Top 5 du score 30J et dans le Top 5 du score 24H.</span>
      </nav>
      {!ready && month.length > 0 && <div className="card warn small">⏳ Scan en cours ({scan.progress.done}/{scan.progress.total}) : résultat provisoire, il peut changer à la fin du scan.</div>}

      <div className="card sentiment small">
        <span className="chip gold">Top 5 30J : <b>{names(month)}</b></span>
        <span className="chip">Top 5 24H : <b>{names(day)}</b></span>
      </div>

      {!month.length ? (
        <div className="card empty">{scan.status === 'error' ? `Impossible de charger Bybit : ${scan.error}` : 'Scan du Top 50…'}</div>
      ) : !both.length ? (
        <div className="card empty">Aucun token n'est dans les deux Top 5 en ce moment.</div>
      ) : (
        <div className="t5-grid">
          {both.map((t) => (
            <div key={t.symbol} className="t5-combo">
              <div className="muted small">30J #{t.rank} · 24H #{dayRank[t.symbol]}</div>
              <Card t={t} b={boxes[t.symbol]} label="30J" horizon="month" />
            </div>
          ))}
        </div>
      )}
      <footer className="footer">Graphique : bougies 4H sur ~30 jours, box 14J. Prix live Bybit · MAJ {fmtTime(Date.now())} · Ceci n'est pas un conseil financier.</footer>
    </div>
  );
}
