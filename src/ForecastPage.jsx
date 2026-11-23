import { useEffect, useMemo, useState } from 'react';
import { Header } from './components/Panels.jsx';
import { WaveChart } from './components/WaveChart.jsx';
import { reliability } from './FollowersPage.jsx';
import { rankCategories } from './core/categories.js';
import CATS from './data/categories.json';

// Forecast of the next BTC rally by narrative category: each category ranked by
// how its tokens amplified BTC's past rallies (median), "if it repeats like before".
const pc = (x) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`);
const xx = (x) => (x == null || !Number.isFinite(x) ? '—' : `${x.toFixed(1)}×`);
const cls = (x) => (x == null ? 'muted' : x > 0 ? 'pos' : x < 0 ? 'neg' : '');
const catOf = (symbol) => { const c = CATS.tokens[symbol.replace(/USDT$/, '')]; return c ? (Array.isArray(c) ? c[0] : c.main) : null; };

export default function ForecastPage({ scan, onBack }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [move, setMove] = useState(null);
  const [open, setOpen] = useState({});
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
  const cats = useMemo(() => (data
    ? rankCategories(data.tokens, data.waves, data.btc, catOf, (t) => reliability(t, data.waves, data.btc).ok, btcMove)
    : []), [data, btcMove]);

  return (
    <div className="app">
      <Header scan={scan} onRescan={scan.rescan} />
      <nav className="controls">
        <a className="btn" href="/" onClick={onBack}>← Benchmark</a>
        <span className="card-title">🔭 PRÉVISION DE LA PROCHAINE HAUSSE · PAR CATÉGORIE</span>
      </nav>
      {err && <div className="error-line">⚠ {err}</div>}
      {!data ? <div className="card empty">{err ? '—' : 'Calcul sur tout Bybit spot… (~10 s)'}</div> : (
        <>
          <div className="card sentiment">
            <label className="sim-controls" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>Hausse du BTC <b>{Math.round(btcMove * 100)} %</b>
              <input type="range" min="5" max="150" step="5" value={Math.round(btcMove * 100)} onChange={(e) => setMove(Number(e.target.value) / 100)} /></label>
            <span className="muted small">Prévision = amplification médiane de la catégorie pendant les hausses passées du BTC × la hausse choisie. Catégories : CoinGecko (thème principal de chaque token). Projection « si ça se répète comme avant », pas une prévision garantie.</span>
          </div>

          <div className="card">
            <div className="card-title">CLASSEMENT DES CATÉGORIES</div>
            <div className="table-wrap">
              <table className="sq-table">
                <thead><tr>
                  <th>Rang</th><th>Catégorie</th><th>Tokens</th><th title="Fidélité 4/4 + plus haut plus haut + plus bas plus haut">Fiables</th><th title="Ont fait mieux que le BTC dans chaque hausse">Battent BTC</th>
                  {data.waves.map((w) => <th key={w.name}>{w.name} (méd.)</th>)}
                  <th>Ampl. ↑ méd.</th><th>Ampl. ↓ méd.</th><th>Prévision</th>
                </tr></thead>
                <tbody>
                  <tr className="on"><td /><td><b>BTC</b></td><td>—</td><td>—</td><td>—</td>{data.btc.map((m, k) => <td key={k} className={cls(m.ret)}>{pc(m.ret)}</td>)}<td>1.0×</td><td>1.0×</td><td className="pos"><b>{pc(btcMove)}</b></td></tr>
                  {cats.map((c, i) => (
                    <tr key={c.cat} onClick={() => document.getElementById(`cat-${i}`)?.scrollIntoView({ behavior: 'smooth' })}>
                      <td className="t5-rank">#{i + 1}</td>
                      <td><b>{c.cat}</b></td>
                      <td>{c.n}</td>
                      <td className={c.reliable ? 'pos' : 'muted'}>{c.reliable}</td>
                      <td>{c.beatAll}</td>
                      {c.waveMed.map((v, k) => <td key={k} className={cls(v)}>{pc(v)}</td>)}
                      <td className={c.upAmp > 1 ? 'pos' : ''}>{xx(c.upAmp)}</td>
                      <td className={c.downAmp > 1 ? 'neg' : ''}>{xx(c.downAmp)}</td>
                      <td className={cls(c.forecast)}><b>{pc(c.forecast)}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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

          {cats.map((c, i) => {
            const shown = open[c.cat] ? c.tokens : c.tokens.slice(0, 8);
            return (
              <div key={c.cat} id={`cat-${i}`} className="card">
                <div className="card-head">
                  <div className="card-title"><span className="t5-rank">#{i + 1}</span> {c.cat} · prévision <span className={cls(c.forecast)}>{pc(c.forecast)}</span> · {c.n} tokens · {c.reliable} fiables</div>
                  {c.tokens.length > 8 && <button className="btn" onClick={() => setOpen({ ...open, [c.cat]: !open[c.cat] })}>{open[c.cat] ? 'Réduire' : `Voir les ${c.tokens.length}`}</button>}
                </div>
                <div className="table-wrap">
                  <table className="sq-table">
                    <thead><tr><th>Token</th><th>Fiable</th>{data.waves.map((w) => <th key={w.name}>{w.name}</th>)}<th>Ampl. ↑</th><th>Ampl. ↓</th><th>Prévision</th></tr></thead>
                    <tbody>
                      {shown.map((t) => (
                        <tr key={t.symbol} className={sel === t.symbol ? 'on' : ''} onClick={() => setSel(t.symbol)}>
                          <td><b>{t.symbol.replace('USDT', '')}</b></td>
                          <td>{t.reliable ? '✅' : ''}</td>
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
            );
          })}
        </>
      )}
      <footer className="footer">Ceci n'est pas un conseil financier.</footer>
    </div>
  );
}
