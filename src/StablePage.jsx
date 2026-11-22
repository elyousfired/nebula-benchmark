import { useEffect, useMemo, useState } from 'react';
import { Header } from './components/Panels.jsx';
import { slowTop, stabilityRows } from './core/stable.js';
import { fmtPct, fmtPrice, pctClass, PHASES } from './lib/format.js';

// Slow Top 50 (50% perf 30J + 50% perf 7J) and who stayed in it over a rolling
// 30 days: history = the 30 last daily closes (/api/stable, cached 1h),
// "now" = live from the page's scan (prices every 20 s).
const RELOAD_EVERY = 30 * 60_000;
const FILTERS = [
  { key: 'all', label: 'Tous', ok: () => true },
  { key: '20', label: '≥ 20 j', ok: (r) => r.daysIn >= 20 },
  { key: '25', label: '≥ 25 j', ok: (r) => r.daysIn >= 25 },
  { key: 'full', label: 'Tout le mois', ok: (r) => r.full },
];

/** Daily slow rank over 30 days + live point: top = #1, bottom = #50, gaps = out. */
function RankSpark({ ranks, now }) {
  const pts = [...ranks, now];
  const W = 130; const H = 26;
  const x = (i) => (i / (pts.length - 1)) * (W - 4) + 2;
  const y = (r) => 2 + ((r - 1) / 49) * (H - 4);
  const segs = [];
  let cur = [];
  pts.forEach((v, i) => { if (v == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push([x(i), y(v)]); });
  if (cur.length) segs.push(cur);
  return (
    <svg width={W} height={H} className="st-spark" aria-label="rang quotidien sur 30 jours">
      {segs.map((s, i) => (s.length === 1
        ? <circle key={i} cx={s[0][0]} cy={s[0][1]} r="1.5" />
        : <polyline key={i} points={s.map((p) => p.join(',')).join(' ')} />))}
      {now != null && <circle cx={x(pts.length - 1)} cy={y(now)} r="2.5" className="st-now" />}
    </svg>
  );
}

export default function StablePage({ scan, onBack }) {
  const [hist, setHist] = useState(null);
  const [err, setErr] = useState(null);
  const [filter, setFilter] = useState('20');

  useEffect(() => {
    let alive = true;
    const load = () => fetch('/api/stable')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { if (alive) { setHist(d); setErr(null); } })
      .catch((e) => alive && setErr(e.message));
    load();
    const id = setInterval(load, RELOAD_EVERY);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const ready = scan.status === 'ready' && !scan.scanning;
  // Live slow Top 50 from the scan (30J / 7J perfs at the live price).
  const live = useMemo(
    () => (ready ? slowTop(scan.tokens.map((t) => ({ symbol: t.symbol, d30: t.perf.d30, w1: t.perf.w1 })), 50) : []),
    [ready, scan.tokens],
  );
  const tok = useMemo(() => Object.fromEntries(scan.tokens.map((t) => [t.symbol, t])), [scan.tokens]);
  const rows = useMemo(() => (hist ? stabilityRows(hist, live) : []), [hist, live]);
  const shown = rows.filter(FILTERS.find((f) => f.key === filter).ok);
  const fullCount = rows.filter((r) => r.full).length;
  const day = (t) => new Date(t).toISOString().slice(5, 10);

  return (
    <div className="app">
      <Header scan={scan} onRescan={scan.rescan} />
      <nav className="controls">
        <a className="btn" href="/" onClick={onBack}>← Benchmark</a>
        <span className="card-title">🧱 TOP 50 STABLE · 30 JOURS GLISSANTS</span>
        {hist && <span className="muted small">Clôtures du {day(hist.days[0])} au {day(hist.days[hist.days.length - 1])} + maintenant (live)</span>}
      </nav>
      {err && <div className="error-line">⚠ Historique indisponible : {err}</div>}
      {!ready && <div className="card warn small">⏳ Scan en cours ({scan.progress.done}/{scan.progress.total}) : la colonne « Maintenant » sera complète à la fin du scan.</div>}

      <div className="card sentiment">
        <span className="pill live">✅ Restés dans le Top 50 tout le mois : {hist && ready ? fullCount : '…'}</span>
        <span className="muted small">Classement lent = 50 % perf 30 jours + 50 % perf 7 jours (percentiles sur tout l'univers). Un token « tout le mois » était dans ce Top 50 à chacune des 30 dernières clôtures journalières ET maintenant.</span>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="card-title">Présence dans le Top 50 lent</div>
          <div className="seg">{FILTERS.map((f) => <button key={f.key} className={filter === f.key ? 'on' : ''} onClick={() => setFilter(f.key)}>{f.label}</button>)}</div>
        </div>
        {!hist ? <div className="muted">{err ? '—' : 'Calcul des 30 derniers jours…'}</div> : shown.length === 0 ? <div className="muted">Aucun token pour ce filtre.</div> : (
          <div className="table-wrap">
            <table className="sq-table">
              <thead><tr>
                <th>#</th><th>Token</th><th>Jours dans le Top 50</th><th>Maintenant</th><th>Rang moyen</th><th>Rang 30 jours</th>
                <th>Prix</th><th>30J</th><th>7J</th><th>24h</th><th>Phase</th>
              </tr></thead>
              <tbody>
                {shown.map((r, i) => {
                  const t = tok[r.symbol];
                  const ph = t ? PHASES[t.phase] : null;
                  return (
                    <tr key={r.symbol} className={r.full ? 'on' : ''}>
                      <td className="muted">{i + 1}</td>
                      <td><b>{r.symbol.replace('USDT', '')}</b>{r.full && ' ✅'}</td>
                      <td><div className="st-bar"><div style={{ width: `${(r.daysIn / r.total) * 100}%` }} /></div><b>{r.daysIn}/{r.total}</b></td>
                      <td>{!ready ? '…' : r.rankNow == null ? <span className="neg">sorti</span> : <b>#{r.rankNow}</b>}</td>
                      <td>{r.avgRank == null ? '—' : r.avgRank.toFixed(1)}</td>
                      <td><RankSpark ranks={r.ranks} now={r.rankNow} /></td>
                      <td>{t ? fmtPrice(t.price) : '—'}</td>
                      <td className={pctClass(t?.perf.d30)}>{fmtPct(t?.perf.d30)}</td>
                      <td className={pctClass(t?.perf.w1)}>{fmtPct(t?.perf.w1)}</td>
                      <td className={pctClass(t?.perf.d1)}>{fmtPct(t?.perf.d1)}</td>
                      <td>{ph ? <span style={{ color: ph.color }}>{ph.label}</span> : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="muted small">Rang 30 jours : rang à chaque clôture journalière (haut = #1, bas = #50, vide = hors Top 50) ; le gros point = maintenant. L'historique utilise les clôtures journalières Bybit (mis à jour toutes les heures) ; « Maintenant » et les perfs sont calculés en live comme sur la page principale.</div>
      </div>
      <footer className="footer">Données : Bybit spot · Ceci n'est pas un conseil financier.</footer>
    </div>
  );
}
