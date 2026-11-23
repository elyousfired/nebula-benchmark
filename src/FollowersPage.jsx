import { useEffect, useMemo, useState } from 'react';
import { Header } from './components/Panels.jsx';

// Every Bybit spot token during BTC's rallies (start day -> top of the wave):
// best gain reached in the window and where it finished. Data: /api/followers.
const pc = (x) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`);
const cls = (x) => (x == null ? 'muted' : x > 0 ? 'pos' : x < 0 ? 'neg' : '');
const day = (t) => new Date(t).toISOString().slice(0, 10);

export default function FollowersPage({ scan, onBack }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [onlyBeat, setOnlyBeat] = useState(false);
  const [q, setQ] = useState('');
  const [k, setK] = useState(0); // which rally is shown

  useEffect(() => {
    let alive = true;
    fetch('/api/followers')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, []);

  // Tokens of the selected rally, sorted by their max gain in it.
  const rows = useMemo(() => {
    if (!data) return [];
    const btcMax = data.btc[k]?.max ?? 0;
    return data.tokens
      .filter((t) => t.moves[k] && t.symbol.includes(q.trim().toUpperCase()) && (!onlyBeat || t.moves[k].max > btcMax))
      .sort((a, b) => b.moves[k].max - a.moves[k].max);
  }, [data, onlyBeat, q, k]);
  const r = data?.rallies[k];
  const btc = data?.btc[k];

  return (
    <div className="app">
      <Header scan={scan} onRescan={scan.rescan} />
      <nav className="controls">
        <a className="btn" href="/" onClick={onBack}>← Benchmark</a>
        <span className="card-title">₿ LES TOKENS PENDANT LES HAUSSES DU BTC</span>
      </nav>
      {err && <div className="error-line">⚠ {err}</div>}

      {data && (
        <div className="card sentiment">
          <div className="seg">
            {data.rallies.map((x, i) => <button key={x.name} className={k === i ? 'on' : ''} onClick={() => setK(i)}>{x.name === 'Hausse 1' ? '1re hausse' : '2e hausse'}</button>)}
          </div>
          <span className="chip"><b>{r.start} → {r.end}</b> · BTC max <b className="pos">{pc(btc?.max)}</b> · fin <b className={cls(btc?.ret)}>{pc(btc?.ret)}</b></span>
          <span className="muted small">Max = meilleur gain atteint pendant la hausse (plus haut / prix au début). Fin = gain au dernier jour de la hausse. Début = ouverture du premier jour.</span>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div className="card-title">{rows.length} tokens · {r ? (k === 0 ? '1re hausse' : '2e hausse') : ''} · triés par max</div>
          <div className="row-gap">
            <input placeholder="Chercher un token" value={q} onChange={(e) => setQ(e.target.value)} className="t5-search" />
            <button className={`toggle ${onlyBeat ? 'on' : ''}`} onClick={() => setOnlyBeat(!onlyBeat)}>Max &gt; BTC {onlyBeat ? '(ON)' : '(OFF)'}</button>
          </div>
        </div>
        {!data ? <div className="muted">{err ? '—' : 'Calcul sur tout Bybit spot… (~10 s)'}</div> : (
          <div className="table-wrap">
            <table className="sq-table">
              <thead><tr><th>#</th><th>Token</th><th>Max</th><th>Fin</th><th>Corr. BTC</th><th>Bat BTC</th></tr></thead>
              <tbody>
                <tr className="on">
                  <td /><td><b>BTC</b></td>
                  <td className="pos"><b>{pc(btc?.max)}</b></td><td className={cls(btc?.ret)}>{pc(btc?.ret)}</td><td>1.00</td><td>—</td>
                </tr>
                {rows.map((t, i) => (
                  <tr key={t.symbol}>
                    <td className="muted">{i + 1}</td>
                    <td><b>{t.symbol.replace('USDT', '')}</b></td>
                    <td className={cls(t.moves[k].max)}><b>{pc(t.moves[k].max)}</b></td>
                    <td className={cls(t.moves[k].ret)}>{pc(t.moves[k].ret)}</td>
                    <td>{t.corr == null ? '—' : t.corr.toFixed(2)}</td>
                    <td>{t.moves[k].max > (btc?.max ?? 0) ? '✅' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="muted small">Bybit spot, univers du site (≈320 tokens), bougies journalières. Données mises à jour toutes les heures ({data ? day(data.generatedAt) : '…'}). Les tokens listés après le début d'une hausse ont « — » pour celle-ci.</div>
      </div>
      <footer className="footer">Ceci n'est pas un conseil financier.</footer>
    </div>
  );
}
