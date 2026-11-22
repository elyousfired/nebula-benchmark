import { useEffect, useMemo, useState } from 'react';
import { fetchTickers } from './lib/bybit.js';
import { fmtPrice, fmtTime } from './lib/format.js';

// Results of the Top 50 agent (github.com/elyousfired/nebula-top50-agent), read
// straight from its public repo: the agent runs in GitHub Actions every 4h.
const REPO = 'elyousfired/nebula-top50-agent';
const RAW = `https://raw.githubusercontent.com/${REPO}/main/data`;
const RELOAD_EVERY = 10 * 60_000;
const PRICE_EVERY = 30_000;

const WINDOWS = [
  { key: 'd30', label: '30 jours' },
  { key: 'd7', label: '7 jours' },
  { key: 'd1', label: '24h' },
  { key: 'all', label: 'Depuis le début' },
];

const f2 = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d));
const sR = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}R`);
const pc = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const rCls = (x) => (x == null ? 'muted' : x > 0 ? 'pos' : x < 0 ? 'neg' : 'muted');
const split = (s) => { const [family, exit] = s.split(' || '); return { family, exit }; };
const ago = (t) => { const m = Math.round((Date.now() - t) / 60_000); return m < 60 ? `il y a ${m} min` : `il y a ${Math.round(m / 60)} h`; };

export default function AgentPage({ onBack }) {
  const [board, setBoard] = useState(null);
  const [state, setState] = useState(null);
  const [err, setErr] = useState(null);
  const [win, setWin] = useState('d30');
  const [prices, setPrices] = useState({});
  const [sel, setSel] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = () => Promise.all([
      fetch(`${RAW}/leaderboard.json`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`leaderboard HTTP ${r.status}`)))),
      fetch(`${RAW}/state.json`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`state HTTP ${r.status}`)))),
    ]).then(([b, s]) => { if (alive) { setBoard(b); setState(s); setErr(null); } }).catch((e) => alive && setErr(e.message));
    load();
    const id = setInterval(load, RELOAD_EVERY);
    return () => { alive = false; clearInterval(id); };
  }, []);

  useEffect(() => {
    const tick = () => fetchTickers().then((l) => setPrices(Object.fromEntries(l.map((t) => [t.symbol, Number(t.lastPrice)])))).catch(() => {});
    tick();
    const id = setInterval(tick, PRICE_EVERY);
    return () => clearInterval(id);
  }, []);

  const rows = useMemo(() => {
    if (!board) return [];
    const minN = win === 'd1' ? 1 : win === 'd7' ? 5 : 10;
    return [...board.board].sort((a, b) => {
      const ka = a[win].n >= minN ? a[win].expR : -Infinity;
      const kb = b[win].n >= minN ? b[win].expR : -Infinity;
      return kb - ka || (b[win].n || 0) - (a[win].n || 0);
    });
  }, [board, win]);

  // Open paper trades, with the live result in R.
  const open = useMemo(() => (state?.open || []).map((t) => {
    const px = prices[t.symbol] > 0 ? prices[t.symbol] : t.mark;
    return { ...t, px, liveR: px ? (px - t.entry) / (t.entry - t.stop) : t.markR };
  }), [state, prices]);
  const shown = sel ? open.filter((t) => t.strategy === sel) : open.filter((t) => t.strategy === board?.best);
  const shownKey = sel || board?.best;

  const lastSlot = state?.lastSlot;
  const late = lastSlot && Date.now() - lastSlot > 9 * 3600_000;
  const best = board && board.board.find((b) => b.strategy === board.best);

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="logo">◆</span>
          <div>
            <div className="title">NEBULA · AGENT TOP 50</div>
            <div className="subtitle">Suit le Top 50 toutes les 4h · trades papier de chaque stratégie · classement quotidien</div>
          </div>
        </div>
        <div className="header-right">
          <a className="btn" href="/" onClick={onBack}>← Benchmark</a>
          {lastSlot && <span className={`pill ${late ? 'stale' : 'live'}`}>● Dernière photo {new Date(lastSlot).toISOString().slice(5, 16).replace('T', ' ')} UTC ({ago(lastSlot)})</span>}
          {board && <span className="meta">Classement {new Date(board.at).toISOString().slice(0, 16).replace('T', ' ')} UTC</span>}
          <a className="btn" href={`https://github.com/${REPO}/blob/main/data/LATEST.md`} target="_blank" rel="noreferrer">Rapport complet ↗</a>
        </div>
        {err && <div className="error-line">⚠ {err}</div>}
      </header>

      {!board ? <div className="card empty">{err ? 'Données de l\'agent indisponibles.' : 'Chargement des résultats de l\'agent…'}</div> : (
        <>
          <div className="card sentiment">
            {best ? (
              <>
                <span className="pill live">🏆 Meilleure sur 30J</span>
                <b>{split(best.strategy).family}</b>
                <span className="chip">{split(best.strategy).exit}</span>
                <span className="chip">E <b className={rCls(best.d30.expR)}>{sR(best.d30.expR)}</b> / trade</span>
                <span className="chip">{best.d30.n} trades · total <b className={rCls(best.d30.totalR)}>{sR(best.d30.totalR, 1)}</b></span>
                <span className="chip">{pc(best.d30.win)} gagnants · PF {f2(best.d30.pf)}</span>
              </>
            ) : <span className="muted">Pas encore assez de trades clôturés pour désigner une meilleure stratégie.</span>}
            {state && <span className="muted small" style={{ marginLeft: 'auto' }}>Suivi depuis {new Date(state.firstSlot).toISOString().slice(0, 10)} · {state.open.length} trades ouverts</span>}
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <div className="card-title">CLASSEMENT DES STRATÉGIES</div>
                <div className="muted small">Espérance (E) et total en R sur les trades clôturés de la période. R = distance entrée → stop. Frais 0,1 %/côté, pas de slippage. Trades papier uniquement. Cliquez une ligne pour voir ses trades ouverts.</div>
              </div>
              <div className="seg">
                {WINDOWS.map((w) => <button key={w.key} className={win === w.key ? 'on' : ''} onClick={() => setWin(w.key)}>{w.label}</button>)}
              </div>
            </div>
            <div className="table-wrap">
              <table className="sq-table">
                <thead><tr><th>#</th><th>Entrée</th><th>Sortie</th><th>Trades</th><th>E / trade</th><th>Total</th><th>Gagnants</th><th>PF</th><th>Pire recul</th><th>Ouverts (R latent)</th></tr></thead>
                <tbody>
                  {rows.map((b, i) => {
                    const s = b[win];
                    const { family, exit } = split(b.strategy);
                    return (
                      <tr key={b.strategy} className={shownKey === b.strategy ? 'on' : ''} onClick={() => setSel(b.strategy)}>
                        <td className="muted">{i + 1}</td>
                        <td><b>{family}</b>{b.strategy === board.best && ' 🏆'}</td>
                        <td className="muted">{exit}</td>
                        <td>{s.n || 0}</td>
                        <td className={rCls(s.expR)}><b>{sR(s.expR)}</b></td>
                        <td className={rCls(s.totalR)}>{sR(s.totalR, 1)}</td>
                        <td>{pc(s.win)}</td>
                        <td>{f2(s.pf)}</td>
                        <td className="neg">{s.n ? f2(s.maxDD, 1) : '—'}</td>
                        <td>{b.open} <span className={rCls(b.openR)}>({sR(b.openR, 1)})</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-title">TRADES OUVERTS · {shownKey ? `${split(shownKey).family} · ${split(shownKey).exit}` : '—'}</div>
            <div className="muted small">Résultat en R au prix live (Bybit, toutes les 30 s). L'agent clôture au stop, à l'objectif ou à l'échéance lors de son passage suivant (toutes les 4h).</div>
            {shown.length === 0 ? <div className="muted">Aucun trade ouvert pour cette stratégie.</div> : (
              <div className="table-wrap">
                <table className="sq-table">
                  <thead><tr><th>Token</th><th>Entrée le</th><th>Entrée</th><th>Stop</th><th>Objectif</th><th>Prix</th><th>R live</th><th>Échéance</th></tr></thead>
                  <tbody>
                    {[...shown].sort((a, b) => b.entryT - a.entryT).map((t) => (
                      <tr key={`${t.strategy}|${t.symbol}`}>
                        <td><b>{t.symbol.replace('USDT', '')}</b></td>
                        <td className="muted">{new Date(t.entryT).toISOString().slice(5, 16).replace('T', ' ')}</td>
                        <td>{fmtPrice(t.entry)}</td>
                        <td className="neg">{fmtPrice(t.stop)}</td>
                        <td className="pos">{t.target == null ? 'aucun' : fmtPrice(t.target)}</td>
                        <td>{fmtPrice(t.px)}</td>
                        <td className={rCls(t.liveR)}><b>{sR(t.liveR)}</b></td>
                        <td className="muted">{new Date(t.expires).toISOString().slice(5, 16).replace('T', ' ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
      <footer className="footer">Agent : GitHub Actions toutes les 4h · données publiques sur github.com/{REPO} · mise à jour de la page toutes les 10 min ({fmtTime(Date.now())}) · Ceci n'est pas un conseil financier.</footer>
    </div>
  );
}
