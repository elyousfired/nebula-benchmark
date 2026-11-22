import { useEffect, useMemo, useState } from 'react';
import { Header } from './components/Panels.jsx';
import { fmtPct, fmtPrice, pctClass, PHASES } from './lib/format.js';

// Presence of each token in the Top 50 (30D score) over the last 30 days,
// computed by the agent from its 4H photos (github.com/elyousfired/nebula-top50-agent).
const URL_STABILITY = 'https://raw.githubusercontent.com/elyousfired/nebula-top50-agent/main/data/stability.json';
const RELOAD_EVERY = 10 * 60_000;
const MINS = [0.4, 0.6, 0.8];

const pc0 = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

/** Daily average rank over 30 days: top = rank 1, bottom = rank 50, gaps when out of the Top 50. */
function RankSpark({ daily }) {
  const W = 120; const H = 26;
  const x = (i) => (i / (daily.length - 1)) * (W - 2) + 1;
  const y = (r) => 2 + ((r - 1) / 49) * (H - 4);
  const segs = [];
  let cur = [];
  daily.forEach((v, i) => { if (v == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`); });
  if (cur.length) segs.push(cur);
  return (
    <svg width={W} height={H} className="st-spark" aria-label="rang quotidien sur 30 jours">
      <line x1="0" x2={W} y1={y(5)} y2={y(5)} className="st-top5" />
      {segs.map((s, i) => (s.length === 1 ? <circle key={i} cx={s[0].split(',')[0]} cy={s[0].split(',')[1]} r="1.5" /> : <polyline key={i} points={s.join(' ')} />))}
    </svg>
  );
}

export default function StablePage({ scan, onBack }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [min, setMin] = useState(0.6);
  const [onlyNow, setOnlyNow] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => fetch(URL_STABILITY, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { if (alive) { setData(d); setErr(null); } })
      .catch((e) => alive && setErr(e.message));
    load();
    const id = setInterval(load, RELOAD_EVERY);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const live = useMemo(() => Object.fromEntries(scan.tokens.map((t) => [t.symbol, t])), [scan.tokens]);
  const rows = useMemo(() => (data?.tokens || []).filter((t) => t.presence30 >= min && (!onlyNow || t.rank != null)), [data, min, onlyNow]);

  return (
    <div className="app">
      <Header scan={scan} onRescan={scan.rescan} />
      <nav className="controls">
        <a className="btn" href="/" onClick={onBack}>← Benchmark</a>
        <span className="card-title">🧱 TOP 50 · LES PLUS STABLES (30 JOURS)</span>
        {data && <span className="muted small">{data.photos} photos de 4h · dernière {new Date(data.lastPhoto).toISOString().slice(5, 16).replace('T', ' ')} UTC</span>}
      </nav>
      {err && <div className="error-line">⚠ Données de l'agent indisponibles : {err}</div>}

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Présence dans le Top 50 (score 30J)</div>
            <div className="muted small">Part des photos de 4h des 30 derniers jours où le token était dans le Top 50. Un token qui reste longtemps dans la liste suit une vraie tendance ; le Top 5, lui, change en moins de 2 jours.</div>
          </div>
          <div className="row-gap">
            <div className="seg">{MINS.map((m) => <button key={m} className={min === m ? 'on' : ''} onClick={() => setMin(m)}>≥ {m * 100}%</button>)}</div>
            <button className={`toggle ${onlyNow ? 'on' : ''}`} onClick={() => setOnlyNow(!onlyNow)}>Dans le Top 50 maintenant {onlyNow ? '(ON)' : '(OFF)'}</button>
          </div>
        </div>
        {!data ? <div className="muted">{err ? '—' : 'Chargement…'}</div> : rows.length === 0 ? <div className="muted">Aucun token avec ce niveau de présence.</div> : (
          <div className="table-wrap">
            <table className="sq-table">
              <thead><tr>
                <th>#</th><th>Token</th><th>Présence 30J</th><th>7J</th><th>Top 5</th><th>Rang moyen</th><th title="Rang à la dernière photo de l'agent (toutes les 4h)">Rang (photo agent)</th>
                <th>Série en cours</th><th>Plus longue série</th><th>Tendance du rang</th><th>Rang 30J</th><th>Prix</th><th>24h</th><th>7J</th><th>Phase</th>
              </tr></thead>
              <tbody>
                {rows.map((t, i) => {
                  const l = live[t.symbol];
                  const ph = l ? PHASES[l.phase] : null;
                  return (
                    <tr key={t.symbol}>
                      <td className="muted">{i + 1}</td>
                      <td><b>{t.symbol.replace('USDT', '')}</b></td>
                      <td><div className="st-bar"><div style={{ width: `${t.presence30 * 100}%` }} /></div><b>{pc0(t.presence30)}</b></td>
                      <td>{pc0(t.presence7)}</td>
                      <td className={t.top5 >= 0.15 ? 'gold' : ''}>{pc0(t.top5)}</td>
                      <td>{t.avgRank.toFixed(1)}</td>
                      <td>{t.rank == null ? <span className="muted">hors Top 50</span> : <b>#{t.rank}</b>}</td>
                      <td>{t.currentDays ? `${t.currentDays.toFixed(1)} j` : '—'}</td>
                      <td>{t.longestDays.toFixed(1)} j</td>
                      <td className={t.rankTrend == null ? 'muted' : t.rankTrend < -3 ? 'pos' : t.rankTrend > 3 ? 'neg' : ''}>
                        {t.rankTrend == null ? '—' : t.rankTrend < -3 ? `↑ monte (${t.rankTrend.toFixed(0)})` : t.rankTrend > 3 ? `↓ baisse (+${t.rankTrend.toFixed(0)})` : '→ stable'}
                      </td>
                      <td><RankSpark daily={t.daily} /></td>
                      <td>{l ? fmtPrice(l.price) : '—'}</td>
                      <td className={pctClass(l?.perf.d1)}>{fmtPct(l?.perf.d1)}</td>
                      <td className={pctClass(l?.perf.w1)}>{fmtPct(l?.perf.w1)}</td>
                      <td>{ph ? <span style={{ color: ph.color }}>{ph.label}</span> : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="muted small">Rang 30J : rang moyen de chaque jour (haut = #1, bas = #50, trait = #5, vide = hors Top 50). Tendance : rang moyen des 7 derniers jours comparé aux 23 jours d'avant. Prix, 24h, 7J et phase : live depuis le scan de la page.</div>
      </div>
      <footer className="footer">Données : agent Top 50 (GitHub Actions toutes les 4h) · Ceci n'est pas un conseil financier.</footer>
    </div>
  );
}
