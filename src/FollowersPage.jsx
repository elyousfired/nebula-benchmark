import { useEffect, useMemo, useState } from 'react';
import { Header } from './components/Panels.jsx';
import { WaveChart } from './components/WaveChart.jsx';
import { SimChart, simColor } from './components/SimChart.jsx';
import { ZoomChart } from './components/ZoomChart.jsx';
import { PerfChart } from './components/PerfChart.jsx';
import { buildCurves } from './core/curves.js';
import { colorOf, fmtPts } from './lib/format.js';
import { reliability } from './core/btcswings.js';
import CATS from './data/categories.json';

const mainCat = (symbol) => { const c = CATS.tokens[symbol.replace(/USDT$/, '')]; return (Array.isArray(c) ? c[0] : c?.main) || 'Autres'; };

// BTC waves (up / down, fixed dates) and how every Bybit spot token followed
// them. Data: /api/followers (daily, 1 h cache); the wave in progress uses the
// page's live prices.
const pc = (x) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`);
const xx = (x) => (x == null || !Number.isFinite(x) ? '—' : `${x.toFixed(1)}×`);
const cls = (x) => (x == null ? 'muted' : x > 0 ? 'pos' : x < 0 ? 'neg' : '');
export { reliability } from './core/btcswings.js';

const SORTS = [
  { key: 'asym', label: 'Asymétrie', fn: (t) => t.asym ?? -99 },
  { key: 'upAmp', label: 'Ampl. hausse', fn: (t) => t.upAmp ?? -99 },
  // Fidelity first, then the most profitable: total of its moves in BTC's up waves.
  { key: 'fidelity', label: 'Fidélité', fn: (t) => t.fidelity * 1e6 + (t.upGain ?? -99) },
];

export default function FollowersPage({ scan, onBack }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [view, setView] = useState('all'); // 'all' or a wave index
  const [sort, setSort] = useState('asym');
  const [onlyFull, setOnlyFull] = useState(true);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const [simSel, setSimSel] = useState(null); // symbols in the simulation (null = default)
  const [simMove, setSimMove] = useState(null); // BTC move of the simulated rally (null = average of past rallies)
  const [simDays, setSimDays] = useState(null);

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
  // Live move since BTC's latest low (lowest point of the wave in progress, detected by the API).
  const sinceLow = (t) => (data?.low && t.pLow > 0 && live[t.symbol] > 0 ? live[t.symbol] / t.pLow - 1 : null);
  const btcSinceLow = data?.low && btcLive > 0 ? btcLive / data.low.btcClose - 1 : null;
  const lowHead = data?.low ? `Depuis creux BTC (${new Date(data.low.t).toISOString().slice(8, 10)}/${new Date(data.low.t).toISOString().slice(5, 7)})` : 'Depuis creux BTC';

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toUpperCase();
    let r = data.tokens.filter((t) => t.symbol.includes(needle)).map((t) => ({
      ...t,
      // Sum of the token's moves in BTC's up waves (its gain when riding the rallies).
      upGain: data.waves.reduce((a, w, k) => a + (w.kind === 'up' && t.moves[k] ? t.moves[k].ret : 0), 0),
    }));
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

  // Simulation: candidates = followed BTC on every wave, best asymmetry first.
  const sim = useMemo(() => {
    if (!data) return null;
    const ups = data.waves.map((x, k) => ({ x, k })).filter(({ x }) => x.kind === 'up' && !x.open);
    const avgMove = ups.reduce((a, { k }) => a + data.btc[k].ret, 0) / ups.length;
    const avgDays = Math.round(ups.reduce((a, { x }) => a + (x.t1 - x.t0) / 86_400_000, 0) / ups.length);
    const cands = data.tokens.filter((t) => t.fidelity === data.waves.length && t.asym != null).sort((a, b) => b.asym - a.asym);
    const reliable = cands.filter((t) => reliability(t, data.waves, data.btc).ok);
    return { avgMove, avgDays, cands, reliable };
  }, [data]);
  const simSyms = simSel ?? sim?.reliable.map((t) => t.symbol) ?? [];
  const toggleSim = (s) => {
    const cur = simSyms;
    setSimSel(cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]);
  };
  const [simQ, setSimQ] = useState('');
  const [monthHl, setMonthHl] = useState(null);
  const [monthH, setMonthH] = useState('month'); // 'month' (30 days) or 'd3' (zoom on the last 3 days)
  // Last 30 days of the simulation's tokens, same chart as the main page's Top 50 (4H, points since the start).
  const month = useMemo(() => {
    const list = simSyms.map((s) => scan.tokens.find((t) => t.symbol === s)).filter(Boolean);
    if (!list.length) return null;
    const c = buildCurves(list, scan.liveSeries, monthH, Date.now());
    return { ...c, order: list.map((t) => t.symbol).filter((s) => c.curves[s]) };
  }, [simSyms.join(','), scan.tokens, scan.liveSeries, monthH]); // eslint-disable-line react-hooks/exhaustive-deps
  // Chips: selected first, then the best 20 candidates (or every match of the search).
  const simChips = useMemo(() => {
    if (!sim) return [];
    const needle = simQ.trim().toUpperCase();
    const pool = needle ? sim.cands.filter((t) => t.symbol.includes(needle)) : sim.cands.slice(0, 20);
    const chosen = simSyms.map((s) => sim.cands.find((t) => t.symbol === s)).filter(Boolean);
    return [...chosen, ...pool.filter((t) => !simSyms.includes(t.symbol))];
  }, [sim, simQ, simSyms.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

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

          {sim && (
            <div className="card">
              <div className="card-title">✅ TOKENS FIABLES · {sim.reliable.length} sur {data.tokens.length}</div>
              <div className="muted small">Fiable = a suivi le BTC sur les {data.waves.length} vagues ET plus haut plus haut (sommet de la dernière hausse &gt; sommet de la précédente) ET plus bas plus haut (creux de la dernière baisse &gt; creux de la précédente). « Bat BTC » = a fait mieux que le BTC dans chaque hausse (information, pas obligatoire).</div>
              <div className="table-wrap">
                <table className="sq-table">
                  <thead><tr><th>Token</th>{data.waves.map((x) => <th key={x.name}>{x.name}</th>)}<th>{lowHead}</th><th>Ampl. ↑</th><th>Ampl. ↓</th><th>Asymétrie</th><th>Corr.</th><th>Bat BTC</th></tr></thead>
                  <tbody>
                    {sim.reliable.map((t) => (
                      <tr key={t.symbol} className={sel === t.symbol ? 'on' : ''} onClick={() => setSel(t.symbol)}>
                        <td><b>{t.symbol.replace('USDT', '')}</b></td>
                        {data.waves.map((x, k) => <td key={x.name} className={cls(mv(t, k))}>{pc(mv(t, k))}</td>)}
                        <td className={sinceLow(t) > btcSinceLow ? 'pos' : 'neg'}><b>{pc(sinceLow(t))}</b></td>
                        <td className="pos">{xx(t.upAmp)}</td><td className={t.downAmp > 1 ? 'neg' : ''}>{xx(t.downAmp)}</td>
                        <td className={t.asym > 1 ? 'pos' : 'neg'}><b>{t.asym.toFixed(1)}</b></td><td>{t.corr?.toFixed(2)}</td>
                        <td>{reliability(t, data.waves, data.btc).beat ? '✅' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {sim && (
            <div className="card">
              <div className="card-title">🔮 SIMULATION · prochaine hausse du BTC</div>
              <div className="muted small">Traits pleins = vraies courbes (base 100 au début de la Hausse 1). Pointillés = simulation : le BTC monte selon la forme moyenne de ses 2 hausses passées, et chaque token bouge de son amplification moyenne (Ampl. ↑) × le mouvement du BTC. C'est une projection « si ça se répète comme avant », pas une prévision.</div>
              <div className="row-gap sim-controls">
                <label>Hausse du BTC <b>{Math.round((simMove ?? sim.avgMove) * 100)} %</b>
                  <input type="range" min="5" max="150" step="5" value={Math.round((simMove ?? sim.avgMove) * 100)} onChange={(e) => setSimMove(Number(e.target.value) / 100)} /></label>
                <label>Durée <b>{simDays ?? sim.avgDays} j</b>
                  <input type="range" min="15" max="180" step="5" value={simDays ?? sim.avgDays} onChange={(e) => setSimDays(Number(e.target.value))} /></label>
              </div>
              <div className="sim-chips">
                <input placeholder="Ajouter un token…" value={simQ} onChange={(e) => setSimQ(e.target.value)} className="t5-search" />
                <button className="btn primary" onClick={() => setSimSel(sim.reliable.map((t) => t.symbol))}>✅ Fiables ({sim.reliable.length})</button>
                <button className="btn" onClick={() => setSimSel(sim.cands.slice(0, 10).map((t) => t.symbol))}>Top 10</button>
                <button className="btn" onClick={() => setSimSel([])}>Vider</button>
                {simChips.map((t) => {
                  const i = simSyms.indexOf(t.symbol);
                  return (
                    <button key={t.symbol} className={`chip ${i >= 0 ? 'on' : ''}`} style={i >= 0 ? { color: simColor(i), borderColor: simColor(i) } : null} onClick={() => toggleSim(t.symbol)}>
                      {t.symbol.replace('USDT', '')} · ↑{t.upAmp.toFixed(1)}× ↓{t.downAmp.toFixed(1)}×
                    </button>
                  );
                })}
                <span className="muted small">({simSyms.length} sélectionnés · {sim.cands.length} tokens ont suivi le BTC sur les {data.waves.length} vagues, classés par asymétrie)</span>
              </div>
              <SimChart waves={data.waves} tokens={simSyms.map((s) => data.tokens.find((t) => t.symbol === s)).filter(Boolean)} btcMove={simMove ?? sim.avgMove} days={simDays ?? sim.avgDays} />
            </div>
          )}

          {sim && (() => {
            // Tokens of the simulation list grouped by main category (CoinGecko), average gain per wave and since BTC's low.
            const toks = simSyms.map((s) => data.tokens.find((t) => t.symbol === s)).filter(Boolean);
            const groups = {};
            for (const t of toks) (groups[mainCat(t.symbol)] ||= []).push(t);
            const avg = (a) => { const v = a.filter((x) => x != null && Number.isFinite(x)); return v.length ? v.reduce((p, q) => p + q, 0) / v.length : null; };
            const rowsC = Object.entries(groups).map(([cat, list]) => ({
              cat, list, waves: data.waves.map((w, k) => avg(list.map((t) => mv(t, k)))), low: avg(list.map(sinceLow)),
            })).sort((a, b) => (b.low ?? -9) - (a.low ?? -9));
            return (
              <div className="card">
                <div className="card-title">🗂 CATÉGORIES DE LA LISTE · {toks.length} tokens</div>
                <div className="muted small">Catégorie principale de chaque token (CoinGecko). Gain = moyenne des tokens de la catégorie. Triées par le gain depuis le creux du BTC. Information seulement, n'entre dans aucun calcul.</div>
                <div className="table-wrap">
                  <table className="sq-table">
                    <thead><tr><th>Catégorie</th><th>Tokens</th>{data.waves.map((w) => <th key={w.name}>{w.name}</th>)}<th>{lowHead}</th></tr></thead>
                    <tbody>
                      <tr className="on"><td><b>BTC</b></td><td>—</td>{data.waves.map((w, k) => <td key={w.name} className={cls(mv(btcRow, k))}>{pc(mv(btcRow, k))}</td>)}<td className={cls(btcSinceLow)}><b>{pc(btcSinceLow)}</b></td></tr>
                      {rowsC.map((r) => (
                        <tr key={r.cat}>
                          <td><b>{r.cat}</b> <span className="muted">({r.list.length})</span></td>
                          <td className="small">{r.list.map((t) => t.symbol.replace('USDT', '')).join(', ')}</td>
                          {r.waves.map((v, k) => <td key={k} className={cls(v)}>{pc(v)}</td>)}
                          <td className={r.low > btcSinceLow ? 'pos' : 'neg'}><b>{pc(r.low)}</b></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}

          {sim && (
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">📅 DERNIER MOIS · COURBES 30J · {month?.order.length ?? 0} tokens de la simulation</div>
                  <div className="muted small">Performance en points (%) depuis le début de la période · bougies 4H alignées UTC · même graphique que le Top 50 de la page principale.</div>
                </div>
                {month && (
                  <div className="vp-legend">
                    <div className="seg">
                      <button className={monthH === 'month' ? 'on' : ''} onClick={() => setMonthH('month')}>30 jours</button>
                      <button className={monthH === 'd3' ? 'on' : ''} onClick={() => setMonthH('d3')}>3 derniers jours</button>
                    </div>
                    <span className="chip">Benchmark <b>{fmtPts(month.bench.length ? month.bench[month.bench.length - 1].v : null)}</b></span>
                    <span className="chip gold">EMA20 bench <b>{fmtPts(month.ema.length ? month.ema[month.ema.length - 1].v : null)}</b></span>
                  </div>
                )}
              </div>
              {!month ? <div className="muted small">{scan.tokens.length ? 'Aucun token sélectionné.' : 'Scan en cours…'}</div> : (
                <>
                  <PerfChart curves={month.curves} order={month.order} bench={month.bench} ema={month.ema} horizon={monthH} highlight={monthHl} onHighlight={setMonthHl} showBench />
                  <div className="legend">
                    {month.order.map((s) => (
                      <button key={s} className={`legend-item ${monthHl === s ? 'on' : ''}`} onClick={() => setMonthHl(monthHl === s ? null : s)}>
                        <span className="dot" style={{ background: colorOf(s) }} />{s.replace('USDT', '')}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {sim && (
            <div className="card">
              <div className="card-title">🔍 ZOOM · DERNIÈRES 24 H · réel (live) contre attendu</div>
              <div className="muted small">Trait plein = prix réel (bougies 1h + prix live, mis à jour toutes les 20 s). Pointillés = l'attendu : l'amplification du token × le mouvement RÉEL du BTC sur les mêmes 24 h (Ampl. ↑ quand le BTC monte, Ampl. ↓ quand il baisse). Tableau : réel sur 24 h, attendu, écart = réel − attendu (vert = fait mieux que prévu par rapport au BTC). Survolez une ligne pour la mettre en avant. Mêmes tokens que la simulation.</div>
              <ZoomChart
                waves={data.waves}
                tokens={simSyms.map((s) => data.tokens.find((t) => t.symbol === s)).filter(Boolean)}
                btcMove={simMove ?? sim.avgMove}
                days={simDays ?? sim.avgDays}
                prices={{ ...live, BTCUSDT: btcLive }}
              />
            </div>
          )}

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
                    <th title="Mouvement live depuis le dernier creux du BTC (détecté automatiquement)">{lowHead}</th>
                    <th title="Somme des mouvements du token pendant les hausses du BTC">Gain hausses</th><th title="Hausse du token / hausse du BTC (moyenne)">Ampl. ↑</th><th title="Baisse du token / baisse du BTC (moyenne)">Ampl. ↓</th><th title="Ampl. ↑ / Ampl. ↓ : > 1 = monte plus qu'il ne baisse">Asymétrie</th><th>Corr.</th>
                  </tr></thead>
                  <tbody>
                    <tr className="on"><td /><td><b>BTC</b></td><td>—</td>{data.waves.map((x, k) => <td key={x.name} className={cls(mv(btcRow, k))}><b>{pc(mv(btcRow, k))}</b></td>)}<td className={cls(btcSinceLow)}><b>{pc(btcSinceLow)}</b></td><td className="pos"><b>{pc(data.waves.reduce((a, w, k) => a + (w.kind === 'up' ? data.btc[k].ret : 0), 0))}</b></td><td>1.0×</td><td>1.0×</td><td>1.0</td><td>1.00</td></tr>
                    {rows.map((t, i) => (
                      <tr key={t.symbol} className={sel === t.symbol ? 'on' : ''} onClick={() => setSel(t.symbol)}>
                        <td className="muted">{i + 1}</td>
                        <td><b>{t.symbol.replace('USDT', '')}</b></td>
                        <td className={t.fidelity === t.waves ? 'pos' : ''}>{t.fidelity}/{t.waves}</td>
                        {data.waves.map((x, k) => <td key={x.name} className={cls(mv(t, k))}>{pc(mv(t, k))}</td>)}
                        <td className={sinceLow(t) > btcSinceLow ? 'pos' : 'neg'}><b>{pc(sinceLow(t))}</b></td>
                        <td className={cls(t.upGain)}><b>{pc(t.upGain)}</b></td>
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
