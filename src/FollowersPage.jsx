import { useEffect, useMemo, useState } from 'react';
import { Header } from './components/Panels.jsx';
import { WaveChart } from './components/WaveChart.jsx';

// BTC waves (up / down, fixed dates) and how every Bybit spot token followed
// them. Data: /api/followers (daily, 1 h cache); the wave in progress uses the
// page's live prices.
const pc = (x) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`);
const xx = (x) => (x == null || !Number.isFinite(x) ? '—' : `${x.toFixed(1)}×`);
const cls = (x) => (x == null ? 'muted' : x > 0 ? 'pos' : x < 0 ? 'neg' : '');
const SORTS = [
  { key: 'asym', label: 'Asymétrie', fn: (t) => t.asym ?? -99 },
  { key: 'upAmp', label: 'Ampl. hausse', fn: (t) => t.upAmp ?? -99 },
  { key: 'fidelity', label: 'Fidélité', fn: (t) => t.fidelity * 1000 + (t.corr ?? 0) },
];

export default function FollowersPage({ scan, onBack }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [view, setView] = useState('all'); // 'all' or a wave index
  const [sort, setSort] = useState('asym');
  const [onlyFull, setOnlyFull] = useState(true);
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

  const live = useMemo(() => Object.fromEntries(scan.tokens.map((t) => [t.symbol, t.price])), [scan.tokens]);
  const btcLive = scan.btc?.price;
  // Move in wave k, live for the wave in progress.
  const mv = (t, k) => {
    const m = t.moves[k];
    if (!m) return null;
    const w = data.waves[k];
    const px = t.symbol === 'BTCUSDT' ? btcLive : live[t.symbol];
    return w.open && px > 0 ? px / m.p0 - 1 : m.ret;
  };
  const btcRow = data ? { symbol: 'BTCUSDT', moves: data.btc } : null;

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toUpperCase();
    let r = data.tokens.filter((t) => t.symbol.includes(needle));
    if (view === 'all') {
      if (onlyFull) r = r.filter((t) => t.fidelity === data.waves.length);
      const f = SORTS.find((s) => s.key === sort).fn;
      return r.sort((a, b) => f(b) - f(a));
    }
    const k = view;
    const up = data.waves[k].kind === 'up';
    return r.filter((t) => t.moves[k]).sort((a, b) => (up ? b.moves[k].max - a.moves[k].max : mv(b, k) - mv(a, k)));
  }, [data, view, sort, onlyFull, q, live]); // eslint-disable-line react-hooks/exhaustive-deps

  const w = view === 'all' ? null : data?.waves[view];

  return (
    <div className="app">
      <Header scan={scan} onRescan={scan.rescan} />
      <nav className="controls">
        <a className="btn" href="/" onClick={onBack}>← Benchmark</a>
        <span className="card-title">₿ MOUVEMENTS DU BTC ET DES ALTCOINS</span>
      </nav>
      {err && <div className="error-line">⚠ {err}</div>}
      {!data ? <div className="card empty">{err ? '—' : 'Calcul sur tout Bybit spot… (~10 s)'}</div> : (
        <>
          <div className="card">
            <div className="wv-timeline">
              {data.waves.map((x, k) => (
                <button key={x.name} className={`wv-seg ${x.kind} ${view === k ? 'on' : ''}`} style={{ flex: Math.max(1, (x.t1 - x.t0) / 86_400_000) }} onClick={() => setView(view === k ? 'all' : k)}>
                  <b>{x.name}{x.open ? ' (en cours)' : ''}</b>
                  <span>{x.start} → {x.end || 'maintenant'}</span>
                  <span>BTC <b>{pc(mv(btcRow, k))}</b></span>
                </button>
              ))}
            </div>
            <div className="row-gap">
              <button className={`btn ${view === 'all' ? 'primary' : ''}`} onClick={() => setView('all')}>Résumé des 4 vagues</button>
              <span className="muted small">Cliquez une vague pour voir tous les tokens pendant cette vague. Mouvement = du premier jour (ouverture) au dernier jour de la vague ; la vague en cours est calculée au prix live.</span>
            </div>
          </div>

          {sel && (
            <div className="card">
              <div className="card-head">
                <div className="card-title">{sel.replace('USDT', '')} (jaune) contre BTC (blanc) · base 100 au début de la Hausse 1</div>
                <button className="btn" onClick={() => setSel(null)}>✕</button>
              </div>
              <WaveChart symbol={sel} waves={data.waves} />
            </div>
          )}

          <div className="card">
            <div className="card-head">
              <div className="card-title">{rows.length} tokens · {w ? `${w.name} : BTC ${pc(mv(btcRow, view))}` : 'résumé'}</div>
              <div className="row-gap">
                <input placeholder="Chercher un token" value={q} onChange={(e) => setQ(e.target.value)} className="t5-search" />
                {view === 'all' && <div className="seg">{SORTS.map((s) => <button key={s.key} className={sort === s.key ? 'on' : ''} onClick={() => setSort(s.key)}>{s.label}</button>)}</div>}
                {view === 'all' && <button className={`toggle ${onlyFull ? 'on' : ''}`} onClick={() => setOnlyFull(!onlyFull)}>Suit BTC sur les {data.waves.length} vagues {onlyFull ? '(ON)' : '(OFF)'}</button>}
              </div>
            </div>
            <div className="table-wrap">
              {view === 'all' ? (
                <table className="sq-table">
                  <thead><tr>
                    <th>#</th><th>Token</th><th title="Vagues où le token est allé dans le sens du BTC">Fidélité</th>
                    {data.waves.map((x) => <th key={x.name}>{x.name}</th>)}
                    <th title="Hausse du token / hausse du BTC (moyenne)">Ampl. ↑</th><th title="Baisse du token / baisse du BTC (moyenne)">Ampl. ↓</th><th title="Ampl. ↑ / Ampl. ↓ : > 1 = monte plus qu'il ne baisse">Asymétrie</th><th>Corr.</th>
                  </tr></thead>
                  <tbody>
                    <tr className="on"><td /><td><b>BTC</b></td><td>—</td>{data.waves.map((x, k) => <td key={x.name} className={cls(mv(btcRow, k))}><b>{pc(mv(btcRow, k))}</b></td>)}<td>1.0×</td><td>1.0×</td><td>1.0</td><td>1.00</td></tr>
                    {rows.map((t, i) => (
                      <tr key={t.symbol} className={sel === t.symbol ? 'on' : ''} onClick={() => setSel(t.symbol)}>
                        <td className="muted">{i + 1}</td>
                        <td><b>{t.symbol.replace('USDT', '')}</b></td>
                        <td className={t.fidelity === t.waves ? 'pos' : ''}>{t.fidelity}/{t.waves}</td>
                        {data.waves.map((x, k) => <td key={x.name} className={cls(mv(t, k))}>{pc(mv(t, k))}</td>)}
                        <td className={t.upAmp > 1 ? 'pos' : ''}>{xx(t.upAmp)}</td>
                        <td className={t.downAmp > 1 ? 'neg' : ''}>{xx(t.downAmp)}</td>
                        <td className={t.asym > 1 ? 'pos' : 'neg'}><b>{t.asym == null ? '—' : t.asym.toFixed(1)}</b></td>
                        <td>{t.corr == null ? '—' : t.corr.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="sq-table">
                  <thead><tr><th>#</th><th>Token</th><th>{w.kind === 'up' ? 'Max atteint' : 'Pire point'}</th><th>Mouvement{w.open ? ' (live)' : ''}</th><th>vs BTC</th><th>Corr.</th></tr></thead>
                  <tbody>
                    <tr className="on"><td /><td><b>BTC</b></td><td>{pc(w.kind === 'up' ? data.btc[view].max : data.btc[view].min)}</td><td className={cls(mv(btcRow, view))}><b>{pc(mv(btcRow, view))}</b></td><td>—</td><td>1.00</td></tr>
                    {rows.map((t, i) => {
                      const m = t.moves[view]; const v = mv(t, view); const b = mv(btcRow, view);
                      return (
                        <tr key={t.symbol} className={sel === t.symbol ? 'on' : ''} onClick={() => setSel(t.symbol)}>
                          <td className="muted">{i + 1}</td>
                          <td><b>{t.symbol.replace('USDT', '')}</b></td>
                          <td className={cls(w.kind === 'up' ? m.max : m.min)}><b>{pc(w.kind === 'up' ? m.max : m.min)}</b></td>
                          <td className={cls(v)}>{pc(v)}</td>
                          <td className={v > b ? 'pos' : 'neg'}>{v > b ? 'mieux' : 'moins bien'}</td>
                          <td>{t.corr == null ? '—' : t.corr.toFixed(2)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            <div className="muted small">Cliquez un token pour voir sa courbe contre le BTC. Fidélité = nombre de vagues où le token est allé dans le même sens que le BTC. Ampl. ↑ 2× = quand le BTC monte de 20 %, le token monte de 40 % (moyenne des hausses). Données Bybit spot journalières, mises à jour toutes les heures.</div>
          </div>
        </>
      )}
      <footer className="footer">Ceci n'est pas un conseil financier.</footer>
    </div>
  );
}
