import { useEffect, useMemo, useRef, useState } from 'react';
import { classify, sortRows, pickTop } from './core/squeeze.js';
import { fetchTickers } from './lib/bybit.js';
import { Header } from './components/Panels.jsx';
import { SqueezeChart } from './components/SqueezeChart.jsx';
import { fmtPct, fmtPrice, fmtTime } from './lib/format.js';

const API_EVERY = 5 * 60_000;
const TICKER_EVERY = 10_000;
const SEEN_KEY = 'nebula_squeeze_seen';
const REG = { bull: ['live', 'BULL'], chop: ['scan', 'CHOP'], bear: ['err', 'BEAR'] };

function loadSeen() { try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch { return new Set(); } }
function saveSeen(s) { try { localStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-300))); } catch { /* ignore */ } }

/**
 * `top50` is App's own topList(tokens, 'month', 50, 'score') from the shared
 * scan: the same tokens at the same moment as the main page, not a recompute.
 */
export default function SqueezePage({ scan, top50, onBack, signalSymbols = [] }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [prices, setPrices] = useState({});
  const [sel, setSel] = useState(null);
  const [perm, setPerm] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const seenRef = useRef(null);

  const ready = scan.status === 'ready' && !scan.scanning;
  const ranks = useMemo(() => Object.fromEntries(top50.map((t) => [t.symbol, t.rank])), [top50]);
  const key = useMemo(() => (ready ? top50.map((t) => t.symbol).sort().join(',') : ''), [ready, top50]);

  useEffect(() => {
    if (!key) return undefined;
    let alive = true;
    const load = () => fetch(`/api/squeeze?symbols=${key}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { if (alive) { setData(d); setErr(null); } })
      .catch((e) => alive && setErr(e.message));
    load();
    const id = setInterval(load, API_EVERY);
    return () => { alive = false; clearInterval(id); };
  }, [key]);

  useEffect(() => {
    const tick = () => fetchTickers().then((l) => setPrices(Object.fromEntries(l.map((t) => [t.symbol, Number(t.lastPrice)])))).catch(() => {});
    tick();
    const id = setInterval(tick, TICKER_EVERY);
    return () => clearInterval(id);
  }, []);

  // Live price -> distance and COILED/QUIET re-evaluated; BREAKOUT comes from closed 1H candles.
  // Only symbols in the current Top 50, with its live rank.
  const rows = useMemo(() => sortRows((data?.rows || []).filter((r) => ranks[r.symbol]).map((r) => {
    const price = prices[r.symbol] > 0 ? prices[r.symbol] : r.price;
    return { ...r, rank: ranks[r.symbol], price, distPct: price / r.high - 1, status: classify({ quiet: r.quietPct, price, ceiling: r.high, breakout: r.breakout }) };
  })), [data, prices, ranks]);
  const missing = top50.filter((t) => !rows.some((r) => r.symbol === t.symbol)).map((t) => t.symbol.replace('USDT', ''));

  // Notify on new breakouts (first load only marks what is already there).
  useEffect(() => {
    if (!data) return;
    const first = seenRef.current == null;
    if (first) seenRef.current = loadSeen();
    const seen = seenRef.current;
    for (const r of data.rows) {
      if (r.status !== 'BREAKOUT') continue;
      const k = `${r.symbol}:${r.breakout.t}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (!first && perm === 'granted' && data.regime?.state !== 'bear') {
        new Notification(`🚀 BREAKOUT ${r.symbol.replace('USDT', '')}`, { body: `Clôture 1H au-dessus de ${fmtPrice(r.breakout.level)} (quiet ${r.breakout.quiet.toFixed(0)}%)`, tag: k });
      }
    }
    saveSeen(seen);
  }, [data, perm]);

  const selRow = rows.find((r) => r.symbol === sel);
  const sigKey = signalSymbols.join(',');
  const picks = useMemo(() => pickTop(rows, { n: 5, signalSymbols: sigKey ? sigKey.split(',') : [] }), [rows, sigKey]);
  const reg = data?.regime;
  const bear = reg?.state === 'bear';

  return (
    <div className="app">
      <Header scan={scan} onRescan={scan.rescan} />
      <nav className="controls"><a className="btn" href="/" onClick={onBack}>← Benchmark</a><span className="card-title">SQUEEZE RADAR · TOP 50 SCORE 30D</span>
        <span className="muted small">{rows.length}/{top50.length} du Top 50{missing.length ? ` · sans données : ${missing.join(', ')}` : ''}</span></nav>

      <div className="card sentiment">
        {reg ? (
          <>
            <span className={`pill ${REG[reg.state][0]}`}>● BTC {REG[reg.state][1]}</span>
            {bear && <span className="sq-warn" dir="rtl">⛔ ما تدخلش: الستراتيجية ما كتخدمش فالسوق الهابط</span>}
            <span className="chip">Close <b>{fmtPrice(reg.close)}</b></span>
            <span className="chip">SMA50 D <b>{fmtPrice(reg.sma50)}</b></span>
            <span className="chip">Ret 20J <b className={reg.ret20 >= 0 ? 'pos' : 'neg'}>{fmtPct(reg.ret20 * 100)}</b></span>
          </>
        ) : <span className="muted">Régime BTC…</span>}
        <span className="muted small" style={{ marginLeft: 'auto' }}>
          {data && `Calcul ${fmtTime(data.generatedAt)}`}{data?.failed?.length ? ` · ${data.failed.length} échecs` : ''}
        </span>
        {perm === 'default' && <button className="btn primary" onClick={() => Notification.requestPermission().then(setPerm)}>🔔 Activer les alertes</button>}
        {perm === 'granted' && <span className="chip">🔔 alertes ON</span>}
      </div>

      {picks.length > 0 && (
        <div className="card">
          <div className="card-title">🎯 TOP 5 SETUPS · les plus proches d'une cassure</div>
          <div className="muted small">Score = 50% compression (Quiet %) + 30% proximité du plafond + 20% volume 24h/7J. Tout token en signal (BREAKOUT, COILED ou alerte launchpad) est ajouté en plus.</div>
          <div className="sq-picks">
            {picks.map((r) => (
              <div key={r.symbol} className={`sq-pick ${r.reason}`} onClick={() => setSel(r.symbol)}>
                <div className="sq-pick-head">
                  <b>#{r.rank} {r.symbol.replace('USDT', '')}</b>
                  <span className={`sq-st ${r.status}${bear && r.status === 'BREAKOUT' ? ' off' : ''}`}>{r.status}</span>
                  {r.reason === 'signal' && <span className="chip gold">signal</span>}
                  <span className="chip">score <b>{r.score}</b></span>
                </div>
                <SqueezeChart row={r} livePrice={prices[r.symbol]} compact />
                <div className="muted small">Dist. {fmtPct(r.distPct * 100)} · Quiet {r.quietPct == null ? '—' : r.quietPct.toFixed(0)} · Vol {r.volRatio == null ? '—' : `${r.volRatio.toFixed(2)}×`}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {selRow && (
        <div className="card">
          <div className="card-head">
            <div className="card-title">{selRow.symbol.replace('USDT', '')} · 4H · box 14J</div>
            <button className="btn" onClick={() => setSel(null)}>✕</button>
          </div>
          <SqueezeChart row={selRow} livePrice={prices[selRow.symbol]} />
        </div>
      )}

      <div className="card">
        {err && <div className="error-line">⚠ {err}</div>}
        {!data ? (
          <div className="muted">{key ? 'Calcul des box…' : 'Scan du Top 50…'}</div>
        ) : (
          <div className="table-wrap">
            <table className="sq-table">
              <thead><tr><th>Rank</th><th>Token</th><th>État</th><th>Prix</th><th>Plafond 14J</th><th>Plancher</th><th>Dist.</th><th>Rng14</th><th>Quiet %</th><th>Vol 24h/7J</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.symbol} className={sel === r.symbol ? 'on' : ''} onClick={() => setSel(sel === r.symbol ? null : r.symbol)}>
                    <td className="muted">#{r.rank}</td>
                    <td><b>{r.symbol.replace('USDT', '')}</b></td>
                    <td><span className={`sq-st ${r.status}${bear && r.status === 'BREAKOUT' ? ' off' : ''}`}>{r.status}</span></td>
                    <td>{fmtPrice(r.price)}</td>
                    <td>{fmtPrice(r.high)}</td>
                    <td>{fmtPrice(r.low)}</td>
                    <td className={r.distPct > 0 ? 'pos' : ''}>{fmtPct(r.distPct * 100)}</td>
                    <td>{(r.rng14 * 100).toFixed(1)}%</td>
                    <td className={r.quietPct == null ? '' : r.quietPct <= 10 ? 'pos' : r.quietPct <= 25 ? 'gold' : ''}>{r.quietPct == null ? '—' : r.quietPct.toFixed(0)}</td>
                    <td className={r.volRatio > 1.5 ? 'pos' : ''}>{r.volRatio == null ? '—' : `${r.volRatio.toFixed(2)}×`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <footer className="footer">Box = plus haut / plus bas 4H des 14 derniers jours (bougie en cours exclue) · Quiet % = percentile vs 120 jours · Ceci n'est pas un conseil financier.</footer>
    </div>
  );
}
