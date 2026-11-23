import { useEffect, useMemo, useState } from 'react';
import { Header } from './components/Panels.jsx';
import { WaveChart } from './components/WaveChart.jsx';
import { reliability } from './FollowersPage.jsx';
import CATS from './data/categories.json';

// Forecast of the next BTC rally per token: its average amplification of BTC's
// past rallies × the chosen BTC rally. The category (CoinGecko narrative) is
// shown for information only: it plays no part in the ranking or the forecast.
const pc = (x) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`);
const xx = (x) => (x == null || !Number.isFinite(x) ? '—' : `${x.toFixed(1)}×`);
const cls = (x) => (x == null ? 'muted' : x > 0 ? 'pos' : x < 0 ? 'neg' : '');
const catOf = (symbol) => { const c = CATS.tokens[symbol.replace(/USDT$/, '')]; return c ? (Array.isArray(c) ? c : c.all) : []; };

export default function ForecastPage({ scan, onBack }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [move, setMove] = useState(null);
  const [onlyReliable, setOnlyReliable] = useState(true);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/followers')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, []);

  const avgMove = useMemo(() => {
    if (!data) return 0.3;
    const ups = data.waves.map((w, k) => (w.kind === 'up' && !w.open ? data.btc[k].ret : null)).filter((x) => x != null);
    return ups.reduce((a, b) => a + b, 0) / ups.length;
  }, [data]);
  const btcMove = move ?? avgMove;

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toUpperCase();
    return data.tokens
      .map((t) => ({ ...t, rel: reliability(t, data.waves, data.btc), cats: catOf(t.symbol), forecast: t.upAmp != null ? t.upAmp * btcMove : null }))
      .filter((t) => (!onlyReliable || t.rel.ok) && (t.symbol.includes(needle) || t.cats.some((c) => c.toUpperCase().includes(needle))))
      .sort((a, b) => (b.forecast ?? -99) - (a.forecast ?? -99));
  }, [data, btcMove, onlyReliable, q]);

  return (
    <div className="app">
      <Header scan={scan} onRescan={scan.rescan} />
      <nav className="controls">
        <a className="btn" href="/" onClick={onBack}>← Benchmark</a>
        <span className="card-title">🔭 PRÉVISION DE LA PROCHAINE HAUSSE DU BTC</span>
      </nav>
      {err && <div className="error-line">⚠ {err}</div>}
      {!data ? <div className="card empty">{err ? '—' : 'Calcul sur tout Bybit spot… (~10 s)'}</div> : (
        <>
          <div className="card sentiment">
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>Hausse du BTC <b>{Math.round(btcMove * 100)} %</b>
              <input type="range" min="5" max="150" step="5" value={Math.round(btcMove * 100)} onChange={(e) => setMove(Number(e.target.value) / 100)} /></label>
            <span className="muted small">Prévision = amplification moyenne du token pendant les hausses passées du BTC (Ampl. ↑) × la hausse choisie. Projection « si ça se répète comme avant », pas une prévision garantie. La catégorie (CoinGecko) est affichée à titre d'information et n'entre pas dans le calcul.</span>
          </div>

          {sel && (
            <div className="card">
              <div className="card-head">
                <div className="card-title">{sel.replace('USDT', '')} (jaune) contre BTC (blanc)</div>
                <button className="btn" onClick={() => setSel(null)}>✕</button>
              </div>
              <WaveChart symbol={sel} waves={data.waves} />
            </div>
          )}

          <div className="card">
            <div className="card-head">
              <div className="card-title">{rows.length} tokens · triés par prévision</div>
              <div className="row-gap">
                <input placeholder="Token ou catégorie" value={q} onChange={(e) => setQ(e.target.value)} className="t5-search" />
                <button className={`toggle ${onlyReliable ? 'on' : ''}`} onClick={() => setOnlyReliable(!onlyReliable)}>Fiables seulement {onlyReliable ? '(ON)' : '(OFF)'}</button>
              </div>
            </div>
            <div className="table-wrap">
              <table className="sq-table">
                <thead><tr>
                  <th>#</th><th>Token</th><th>Catégorie</th><th title="Fidélité 4/4 + plus haut plus haut + plus bas plus haut">Fiable</th>
                  {data.waves.map((w) => <th key={w.name}>{w.name}</th>)}
                  <th>Ampl. ↑</th><th>Ampl. ↓</th><th>Prévision</th>
                </tr></thead>
                <tbody>
                  <tr className="on"><td /><td><b>BTC</b></td><td>—</td><td>—</td>{data.btc.map((m, k) => <td key={k} className={cls(m.ret)}>{pc(m.ret)}</td>)}<td>1.0×</td><td>1.0×</td><td className="pos"><b>{pc(btcMove)}</b></td></tr>
                  {rows.map((t, i) => (
                    <tr key={t.symbol} className={sel === t.symbol ? 'on' : ''} onClick={() => setSel(t.symbol)}>
                      <td className="muted">{i + 1}</td>
                      <td><b>{t.symbol.replace('USDT', '')}</b></td>
                      <td className="muted small">{t.cats.length ? t.cats.slice(0, 2).join(' · ') : '—'}</td>
                      <td>{t.rel.ok ? '✅' : ''}</td>
                      {t.moves.map((m, k) => <td key={k} className={cls(m?.ret)}>{pc(m?.ret)}</td>)}
                      <td className={t.upAmp > 1 ? 'pos' : ''}>{xx(t.upAmp)}</td>
                      <td className={t.downAmp > 1 ? 'neg' : ''}>{xx(t.downAmp)}</td>
                      <td className={cls(t.forecast)}><b>{pc(t.forecast)}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      <footer className="footer">Ceci n'est pas un conseil financier.</footer>
    </div>
  );
}
