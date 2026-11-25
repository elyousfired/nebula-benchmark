import { useEffect, useMemo, useState } from 'react';
import { Header } from './components/Panels.jsx';
import { fetchKlines, fetchTickers } from './lib/bybit.js';
import { parseKlines } from './core/bars.js';
import { selectUniverse } from './core/universe.js';

// Our system on one page: BTC light (🔴 nothing, 🟡/🟢 trade) + quiet-box breakouts on the alts,
// $10 per signal, stop -5 %, trailing 5 % once +5 %, max 14 days. Paper results from the agent.
const DAY = 86_400_000;
const AGENT = 'https://raw.githubusercontent.com/elyousfired/nebula-top50-agent/main/data';
const WRAP = /^(BTC|ETH|WBTC|WETH|STETH|WSTETH|METH|BBSOL|CBBTC|WBETH|CMETH|JITOSOL|MSOL|BNSOL|SOLVBTC|LBTC|USDE|USDD|FDUSD|PYUSD|RLUSD|USD1|XAUT|PAXG)USDT$/;
const LIGHT = ['🔴', '🟡', '🟢'];
const LBL = ['Rouge : on ne trade pas', 'Jaune : on trade les cassures', 'Vert : on trade les cassures'];
const pc = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const fp = (p) => (p == null ? '—' : p >= 1000 ? Math.round(p).toLocaleString('fr-FR') : p >= 1 ? p.toFixed(3) : p.toPrecision(4));
const dd = (t) => new Date(t).toISOString().slice(0, 10);
const base = (s) => s.replace('USDT', '');

/** Light A for every closed daily candle: 2 = close > EMA50 and > last top before the low. */
function lightSeries(b) {
  const out = []; let ema = b.c[0];
  for (let i = 0; i < b.t.length; i++) {
    if (i) ema += (2 / 51) * (b.c[i] - ema);
    let lo = -1; for (let k = Math.max(0, i - 60); k < i; k++) if (lo < 0 || b.l[k] < b.l[lo]) lo = k;
    let top = 0; for (let k = Math.max(0, lo - 20); k < lo; k++) top = Math.max(top, b.h[k]);
    out.push({ t: b.t[i], n: i < 60 ? null : (b.c[i] > ema) + (top > 0 && b.c[i] > top), ema, top: top || null, close: b.c[i] });
  }
  return out;
}

export default function SystemPage({ scan, onBack }) {
  const [mk, setMk] = useState(null);
  const [rows, setRows] = useState(null);
  const [paper, setPaper] = useState(null);
  const [err, setErr] = useState(null);
  const [calc, setCalc] = useState('');

  // BTC + ETH daily (light, ETH/BTC), every 5 min.
  useEffect(() => {
    let alive = true;
    const load = () => Promise.all([fetchKlines('BTCUSDT', 'D', 400).then(parseKlines), fetchKlines('ETHUSDT', 'D', 400).then(parseKlines)])
      .then(([btc, eth]) => alive && setMk({ btc, eth })).catch((e) => setErr(e.message));
    load(); const id = setInterval(load, 300_000); return () => { alive = false; clearInterval(id); };
  }, []);
  // Quiet-box status of the 200 most traded alts (same API as /squeeze), every 15 min.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const alts = selectUniverse(await fetchTickers(), { limit: 230 }).map((t) => t.symbol).filter((s) => !WRAP.test(s)).slice(0, 200);
        const parts = [];
        for (let i = 0; i < alts.length; i += 50) parts.push(alts.slice(i, i + 50));
        const res = await Promise.all(parts.map((p) => fetch(`/api/squeeze?symbols=${p.join(',')}`).then((r) => r.json()).catch(() => ({ rows: [] }))));
        if (alive) setRows(res.flatMap((r) => r.rows || []));
      } catch (e) { setErr(e.message); }
    };
    load(); const id = setInterval(load, 900_000); return () => { alive = false; clearInterval(id); };
  }, []);
  // Paper results of the agent (public repo).
  useEffect(() => {
    const now = new Date(); const m0 = now.toISOString().slice(0, 7); const m1 = new Date(now.getTime() - 31 * DAY).toISOString().slice(0, 7);
    Promise.all([
      fetch(`${AGENT}/boxpaper.json`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ...[m1, m0].map((m) => fetch(`${AGENT}/boxpaper/${m}.jsonl`, { cache: 'no-store' }).then((r) => (r.ok ? r.text() : '')).catch(() => '')),
    ]).then(([st, ...txt]) => setPaper({ st, closed: txt.join('\n').split('\n').filter(Boolean).map((l) => JSON.parse(l)) }));
  }, []);

  const L = useMemo(() => {
    if (!mk) return null;
    const s = lightSeries(mk.btc).filter((x) => x.n != null);
    const now = Date.now(); const closed = s.filter((x) => x.t + DAY <= now);
    const cur = closed[closed.length - 1];
    let k = closed.length - 1; while (k > 0 && closed[k - 1].n === cur.n) k--;
    const live = scan.btc?.price > 0 ? scan.btc.price : mk.btc.c[mk.btc.c.length - 1];
    // ETH/BTC vs its EMA50
    const em = new Map(mk.eth.t.map((t, i) => [t, mk.eth.c[i]])); let e = null; let r = null;
    mk.btc.t.forEach((t, i) => { const p = em.get(t); if (!p) return; r = p / mk.btc.c[i]; e = e == null ? r : e + (2 / 51) * (r - e); });
    return { cur, since: closed[k].t, days: closed.length - k, prev: k > 0 ? closed[k - 1].n : null, live, toEma: cur.ema / live - 1, toTop: cur.top ? cur.top / live - 1 : null, ethBtc: r, ethEma: e };
  }, [mk, scan.btc?.price]);

  const box = useMemo(() => {
    if (!rows) return null;
    const quiet = rows.filter((x) => x.quietPct != null && x.quietPct <= 10);
    const near = quiet.filter((x) => x.status !== 'BREAKOUT' && x.distPct != null && x.distPct < 0).sort((a, b) => b.distPct - a.distPct);
    const brk = rows.filter((x) => x.status === 'BREAKOUT').sort((a, b) => (b.breakout?.t ?? 0) - (a.breakout?.t ?? 0));
    return { n: rows.length, quiet: quiet.length, near, brk };
  }, [rows]);

  const st = paper?.st; const closed = paper?.closed || [];
  const ce = Number(String(calc).replace(',', '.'));
  const link = (s) => <><a href={`https://www.bybit.com/trade/spot/${base(s)}/USDT`} target="_blank" rel="noreferrer">{base(s)}</a> <a className="muted small" href="/btc">/btc</a></>;
  const nearRow = (x, i) => (
    <tr key={x.symbol} className={x.distPct > -0.01 ? 'on' : ''}>
      <td className="muted">{i + 1}</td><td><b>{link(x.symbol)}</b>{x.distPct > -0.01 && <span className="gold"> ⚠ très proche</span>}</td>
      <td>{fp(x.price)}</td><td>{fp(x.high)}</td><td className={x.distPct > -0.01 ? 'gold' : ''}><b>{pc(x.distPct, 2)}</b></td>
      <td>{x.quietPct == null ? '—' : Math.round(x.quietPct)}</td><td>{fp(x.high * 0.95)}</td>
    </tr>
  );

  return (
    <div className="app">
      <Header scan={scan} onRescan={scan.rescan} />
      <nav className="controls">
        <a className="btn" href="/" onClick={onBack}>← Benchmark</a>
        <span className="card-title">⚙ NOTRE SYSTÈME · feu BTC + cassures de box</span>
      </nav>
      {err && <div className="error-line">⚠ {err}</div>}

      {/* 1 + 6 : light */}
      <div className="card">
        {!L ? <div className="muted">Calcul du feu…</div> : (
          <>
            <div style={{ fontSize: 22 }}><b>{LIGHT[L.cur.n]} {LBL[L.cur.n]}</b></div>
            <div className="small" style={{ marginTop: 6 }}>
              BTC {fp(L.live)} · EMA50 jour {fp(L.cur.ema)} {L.live > L.cur.ema ? '✅' : `❌ (encore ${pc(L.toEma)})`} · dernier sommet avant le creux {fp(L.cur.top)} {L.cur.top && L.live > L.cur.top ? '✅' : `❌ (encore ${pc(L.toTop)})`}
            </div>
            <div className="small muted" style={{ marginTop: 4 }}>
              {LIGHT[L.cur.n]} depuis {L.days} jour(s) (le {dd(L.since)}){L.prev != null ? `, avant : ${LIGHT[L.prev]}` : ''} · calculé sur la clôture du jour (00:00 UTC). 🟡 = une condition, 🟢 = les deux.
            </div>
          </>
        )}
      </div>

      {/* 7 + 8 : quiet count, ETH/BTC */}
      <div className="card small">
        <b>Tokens calmes (quiet ≤ 10) :</b> {box ? `${box.quiet} sur ${box.n}` : '…'} <span className="muted">(beaucoup de tokens calmes = beaucoup de cassures possibles)</span>
        {' · '}<b>ETH/BTC :</b> {L?.ethBtc ? `${L.ethBtc.toFixed(5)} ${L.ethBtc > L.ethEma ? '✅ au-dessus' : '❌ en dessous'} de son EMA50 (${L.ethEma.toFixed(5)})` : '…'} <span className="muted">(au-dessus = l'argent va vers les alts)</span>
      </div>

      {/* 2 + 11 + 12 : 3 nearest */}
      <div className="card">
        <div className="card-title">🎯 LES 3 PLUS PROCHES DE CASSER LEUR BOX {L && L.cur.n === 0 && <span className="neg"> · feu 🔴 : à surveiller seulement</span>}</div>
        {!box ? <div className="muted small">Analyse des 200 alts… (~20 s)</div> : (
          <div className="table-wrap"><table className="sq-table">
            <thead><tr><th>#</th><th>Token</th><th>Prix</th><th>Plafond de la box</th><th>Distance</th><th>Quiet</th><th>Stop si entrée au plafond (−5 %)</th></tr></thead>
            <tbody>{box.near.slice(0, 3).map(nearRow)}</tbody>
          </table></div>
        )}
      </div>

      {/* 3 : breakouts */}
      <div className="card">
        <div className="card-title">🚀 CASSURES DES DERNIÈRES 24 H</div>
        {!box ? <div className="muted small">…</div> : !box.brk.length ? <div className="muted small">Aucune.</div> : (
          <div className="table-wrap"><table className="sq-table">
            <thead><tr><th>Token</th><th>Heure (UTC)</th><th>Niveau cassé</th><th>Prix</th><th>Depuis la cassure</th><th>Signal du système</th></tr></thead>
            <tbody>{box.brk.map((x) => (
              <tr key={x.symbol}><td><b>{link(x.symbol)}</b></td><td className="muted">{x.breakout?.t ? new Date(x.breakout.t).toISOString().slice(5, 16).replace('T', ' ') : '—'}</td>
                <td>{fp(x.breakout?.level)}</td><td>{fp(x.price)}</td><td className={x.price >= x.breakout?.close ? 'pos' : 'neg'}>{pc(x.breakout?.close ? x.price / x.breakout.close - 1 : null)}</td>
                <td>{L && L.cur.n >= 1 ? '✅ achat 10 $' : '⛔ feu 🔴'}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </div>

      {/* 4 + 10 : paper */}
      <div className="card">
        <div className="card-title">📒 PAPIER DE L'AGENT (10 $ par signal, feu 🟡/🟢)</div>
        {!st ? <div className="muted small">Pas encore de données.</div> : (
          <>
            <div className="small">Ouverts : <b>{st.open.length}</b>{st.open.length ? ` (${st.open.map((p) => base(p.s)).join(', ')})` : ''} · clôturés : <b>{st.closedN ?? 0}</b> · résultat <b className={st.closedUsd >= 0 ? 'pos' : 'neg'}>{st.closedUsd >= 0 ? '+' : ''}{(st.closedUsd ?? 0).toFixed(2)} $</b> · gagnants {st.win == null ? '—' : `${Math.round(st.win * 100)}%`} · PF {st.pf == null ? '—' : st.pf.toFixed(2)}</div>
            {st.open.length > 0 && <div className="table-wrap"><table className="sq-table">
              <thead><tr><th>Ouvert</th><th>Token</th><th>Entrée</th><th>Stop actuel</th><th>Plus haut</th></tr></thead>
              <tbody>{st.open.map((p) => <tr key={p.s + p.t}><td className="muted">{new Date(p.t).toISOString().slice(5, 16).replace('T', ' ')}</td><td><b>{link(p.s)}</b></td><td>{fp(p.entry)}</td><td>{fp(p.stop)}</td><td>{pc(p.peak / p.entry - 1)}</td></tr>)}</tbody>
            </table></div>}
            <div className="card-title" style={{ marginTop: 8 }}>10 derniers trades clôturés</div>
            {!closed.length ? <div className="muted small">Aucun pour l'instant (feu 🔴 depuis le début du papier).</div> : (
              <div className="table-wrap"><table className="sq-table">
                <thead><tr><th>Token</th><th>Entrée</th><th>Sortie</th><th>Raison</th><th>Résultat</th></tr></thead>
                <tbody>{[...closed].sort((a, b) => b.exitT - a.exitT).slice(0, 10).map((c) => <tr key={c.s + c.t}><td><b>{link(c.s)}</b></td><td className="muted">{dd(c.t)}</td><td className="muted">{dd(c.exitT)}</td><td>{c.why}</td><td className={c.usd >= 0 ? 'pos' : 'neg'}><b>{c.usd >= 0 ? '+' : ''}{c.usd.toFixed(2)} $</b></td></tr>)}</tbody>
              </table></div>
            )}
          </>
        )}
      </div>

      {/* 9 : calculator */}
      <div className="card small">
        <div className="card-title">🧮 CALCULATEUR DE TRADE</div>
        Prix d'entrée : <input value={calc} onChange={(e) => setCalc(e.target.value)} placeholder="ex. 1.234" style={{ width: 120 }} />
        {ce > 0 && <span> → stop <b className="neg">{fp(ce * 0.95)}</b> · le trailing démarre à <b className="pos">{fp(ce * 1.05)}</b> (puis stop = plus haut − 5 %) · sortie au plus tard le <b>{dd(Date.now() + 14 * DAY)}</b> · 10 $ → perte max ≈ 0,53 $</span>}
      </div>

      {/* 5 : rules */}
      <div className="card small">
        <div className="card-title">📜 LES RÈGLES</div>
        <div>1. <b>Feu BTC</b> (clôture jour) : 🔴 aucune entrée · 🟡 ou 🟢 on prend les cassures.</div>
        <div>2. <b>Signal</b> : token calme (quiet ≤ 10 : box de 14 jours parmi les plus étroites de ses 120 jours) et une bougie 1H clôture au-dessus du plafond de la box.</div>
        <div>3. <b>Trade</b> : 10 $ par signal · stop −5 % · dès +5 %, trailing 5 % sous le plus haut · sortie au plus tard après 14 jours.</div>
        <div className="muted">Backtest des 4 vagues (337 alts) : 672 trades en 🟡/🟢, +111 $, PF 1,77 · les trades en 🔴 ont rapporté ≈ 0 $. Papier en cours dans l'agent. Pas un conseil financier.</div>
      </div>
    </div>
  );
}
