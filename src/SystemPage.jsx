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
const LCOL = ['var(--red)', 'var(--gold)', 'var(--green)'];
const LBL = ['ROUGE · on ne trade pas', 'JAUNE · on trade les cassures', 'VERT · on trade les cassures'];
const pc = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const fp = (p) => (p == null ? '—' : p >= 1000 ? Math.round(p).toLocaleString('fr-FR') : p >= 1 ? p.toFixed(3) : p.toPrecision(4));
const dd = (t) => new Date(t).toISOString().slice(0, 10);
const hm = (t) => new Date(t).toISOString().slice(5, 16).replace('T', ' ');
const base = (s) => s.replace('USDT', '');
const bybit = (s) => `https://www.bybit.com/trade/spot/${base(s)}/USDT`;

/** Light A for every daily candle: 2 = close > EMA50 and > last top before the low. */
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

/** 4H candles of the last ~20 days with the 14-day box, the ceiling and the -5 % stop. */
function BoxChart({ b, row }) {
  if (!b) return <div className="sys-chart sys-wait">chargement du graphique…</div>;
  const n = b.t.length; const W = 560; const H = 210; const P = 6; const R = 58;
  const stop = row.high * 0.95;
  let lo = Math.min(...b.l, stop); let hi = Math.max(...b.h, row.high);
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const y = (p) => P + (H - 2 * P) * (1 - (p - lo) / (hi - lo));
  const cw = (W - R) / n; const x = (i) => i * cw + cw / 2;
  const i0 = Math.max(0, b.t.findIndex((t) => t >= row.boxFrom));
  const lab = (p, txt, col) => (
    <g><line x1={0} x2={W - R} y1={y(p)} y2={y(p)} stroke={col} strokeDasharray="4 3" strokeWidth="1" />
      <rect x={W - R + 2} y={y(p) - 8} width={R - 4} height={16} rx="3" fill={col} opacity="0.18" />
      <text x={W - R / 2} y={y(p) + 4} textAnchor="middle" fontSize="10" fill={col}>{txt}</text></g>
  );
  return (
    <svg className="sys-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <rect x={i0 * cw} y={y(row.high)} width={(n - i0) * cw} height={y(row.low) - y(row.high)} fill="var(--cyan)" opacity="0.07" />
      {b.t.map((_, i) => {
        const up = b.c[i] >= b.o[i]; const col = up ? 'var(--green)' : 'var(--red)';
        return <g key={i}><line x1={x(i)} x2={x(i)} y1={y(b.h[i])} y2={y(b.l[i])} stroke={col} strokeWidth="1" opacity="0.8" />
          <rect x={x(i) - cw * 0.35} width={cw * 0.7} y={y(Math.max(b.o[i], b.c[i]))} height={Math.max(1, Math.abs(y(b.o[i]) - y(b.c[i])))} fill={col} /></g>;
      })}
      {lab(row.high, 'plafond', 'var(--cyan)')}
      {lab(stop, 'stop −5%', 'var(--red)')}
      {lab(b.c[n - 1], fp(b.c[n - 1]), 'var(--text)')}
    </svg>
  );
}

export default function SystemPage({ scan, onBack }) {
  const [mk, setMk] = useState(null);
  const [rows, setRows] = useState(null);
  const [paper, setPaper] = useState(null);
  const [charts, setCharts] = useState({});
  const [err, setErr] = useState(null);
  const [calc, setCalc] = useState('');

  useEffect(() => {
    let alive = true;
    const load = () => Promise.all([fetchKlines('BTCUSDT', 'D', 400).then(parseKlines), fetchKlines('ETHUSDT', 'D', 400).then(parseKlines)])
      .then(([btc, eth]) => alive && setMk({ btc, eth })).catch((e) => setErr(e.message));
    load(); const id = setInterval(load, 300_000); return () => { alive = false; clearInterval(id); };
  }, []);
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

  const top3 = box?.near.slice(0, 3) || [];
  const key3 = top3.map((x) => x.symbol).join(',');
  useEffect(() => {
    top3.forEach((x) => fetchKlines(x.symbol, '240', 120).then(parseKlines).then((b) => setCharts((c) => ({ ...c, [x.symbol]: b }))).catch(() => {}));
  }, [key3]); // eslint-disable-line react-hooks/exhaustive-deps

  const st = paper?.st; const closed = paper?.closed || [];
  const ce = Number(String(calc).replace(',', '.'));
  const lc = L ? LCOL[L.cur.n] : 'var(--muted)';

  return (
    <div className="app sys">
      <style>{CSS}</style>
      <Header scan={scan} onRescan={scan.rescan} />
      <nav className="controls">
        <a className="btn" href="/" onClick={onBack}>← Benchmark</a>
        <span className="sys-crumb">NOTRE SYSTÈME · feu BTC + cassures de box</span>
      </nav>
      {err && <div className="error-line">⚠ {err}</div>}

      <section className="sys-hero" style={{ '--lc': lc }}>
        <div className="sys-orb">{L ? LIGHT[L.cur.n] : '…'}</div>
        <div className="sys-hero-main">
          <div className="sys-kicker">FEU BTC · clôture du jour</div>
          <div className="sys-hero-title">{L ? LBL[L.cur.n] : 'Calcul…'}</div>
          {L && <div className="sys-muted">depuis {L.days} jour(s) · le {dd(L.since)}{L.prev != null ? ` · avant ${LIGHT[L.prev]}` : ''}</div>}
        </div>
        {L && (
          <div className="sys-conds">
            <Cond ok={L.live > L.cur.ema} name="EMA50 jour" lvl={L.cur.ema} gap={L.toEma} />
            <Cond ok={L.cur.top && L.live > L.cur.top} name="Sommet avant le creux" lvl={L.cur.top} gap={L.toTop} />
          </div>
        )}
      </section>

      <section className="sys-tiles">
        <Tile k="BTC" v={L ? fp(L.live) : '…'} s="prix live" />
        <Tile k="Tokens calmes" v={box ? `${box.quiet}/${box.n}` : '…'} s="quiet ≤ 10" />
        <Tile k="ETH/BTC" v={L?.ethBtc ? L.ethBtc.toFixed(5) : '…'} s={L?.ethBtc ? (L.ethBtc > L.ethEma ? '▲ au-dessus EMA50' : '▼ sous EMA50') : ''} c={L?.ethBtc ? (L.ethBtc > L.ethEma ? 'pos' : 'neg') : ''} />
        <Tile k="Papier agent" v={st ? `${st.closedUsd >= 0 ? '+' : ''}${(st.closedUsd ?? 0).toFixed(2)} $` : '…'} s={st ? `${st.open.length} ouverts · ${st.closedN ?? 0} clôturés · PF ${st.pf == null ? '—' : st.pf.toFixed(2)}` : ''} c={st ? (st.closedUsd >= 0 ? 'pos' : 'neg') : ''} />
      </section>

      <h2 className="sys-h">🎯 Les 3 plus proches de casser leur box {L && L.cur.n === 0 && <span className="sys-tag neg">feu 🔴 · à surveiller seulement</span>}</h2>
      {!box ? <div className="sys-card sys-wait">Analyse des 200 alts… (~20 s)</div> : (
        <section className="sys-three">
          {top3.map((x, i) => (
            <div key={x.symbol} className={`sys-card sys-tok ${x.distPct > -0.01 ? 'hot' : ''}`}>
              <div className="sys-tok-head">
                <span className="sys-rank">#{i + 1}</span>
                <a className="sys-sym" href={bybit(x.symbol)} target="_blank" rel="noreferrer">{base(x.symbol)}</a>
                <span className="sys-price">{fp(x.price)}</span>
                <span className={`sys-dist ${x.distPct > -0.01 ? 'gold' : ''}`}>{pc(x.distPct, 2)}</span>
              </div>
              <BoxChart b={charts[x.symbol]} row={x} />
              <div className="sys-tok-foot">
                <span>plafond <b>{fp(x.high)}</b></span><span>quiet <b>{x.quietPct == null ? '—' : Math.round(x.quietPct)}</b></span>
                <span>stop <b className="neg">{fp(x.high * 0.95)}</b></span>
                <a href="/btc">/btc</a>
              </div>
              {x.distPct > -0.01 && <div className="sys-hotline">⚠ à moins de 1 % du plafond</div>}
            </div>
          ))}
        </section>
      )}

      <section className="sys-grid">
        <div className="sys-card">
          <h3 className="sys-h3">🚀 Cassures des dernières 24 h</h3>
          {!box ? <div className="sys-muted">…</div> : !box.brk.length ? <div className="sys-muted">Aucune cassure.</div> : (
            <table className="sys-table"><thead><tr><th>Token</th><th>Heure UTC</th><th>Niveau</th><th>Depuis</th><th>Signal</th></tr></thead>
              <tbody>{box.brk.map((x) => (
                <tr key={x.symbol}><td><a href={bybit(x.symbol)} target="_blank" rel="noreferrer"><b>{base(x.symbol)}</b></a></td><td className="sys-muted">{x.breakout?.t ? hm(x.breakout.t) : '—'}</td>
                  <td>{fp(x.breakout?.level)}</td><td className={x.price >= x.breakout?.close ? 'pos' : 'neg'}>{pc(x.breakout?.close ? x.price / x.breakout.close - 1 : null)}</td>
                  <td>{L && L.cur.n >= 1 ? <span className="sys-tag pos">achat 10 $</span> : <span className="sys-tag neg">feu 🔴</span>}</td></tr>
              ))}</tbody></table>
          )}
        </div>

        <div className="sys-card">
          <h3 className="sys-h3">📒 Papier de l'agent <span className="sys-muted">10 $ / signal · 🟡🟢</span></h3>
          {!st ? <div className="sys-muted">Pas encore de données.</div> : (
            <>
              {st.open.length > 0 && <table className="sys-table"><thead><tr><th>Ouvert</th><th>Token</th><th>Entrée</th><th>Stop</th><th>Max</th></tr></thead>
                <tbody>{st.open.map((p) => <tr key={p.s + p.t}><td className="sys-muted">{hm(p.t)}</td><td><b>{base(p.s)}</b></td><td>{fp(p.entry)}</td><td>{fp(p.stop)}</td><td>{pc(p.peak / p.entry - 1)}</td></tr>)}</tbody></table>}
              <div className="sys-sub">10 derniers clôturés · gagnants {st.win == null ? '—' : `${Math.round(st.win * 100)}%`}</div>
              {!closed.length ? <div className="sys-muted">Aucun pour l'instant (feu 🔴 depuis le début du papier).</div> : (
                <table className="sys-table"><thead><tr><th>Token</th><th>Entrée</th><th>Sortie</th><th>Raison</th><th>$</th></tr></thead>
                  <tbody>{[...closed].sort((a, b) => b.exitT - a.exitT).slice(0, 10).map((c) => <tr key={c.s + c.t}><td><b>{base(c.s)}</b></td><td className="sys-muted">{dd(c.t)}</td><td className="sys-muted">{dd(c.exitT)}</td><td>{c.why}</td><td className={c.usd >= 0 ? 'pos' : 'neg'}><b>{c.usd >= 0 ? '+' : ''}{c.usd.toFixed(2)}</b></td></tr>)}</tbody></table>
              )}
            </>
          )}
        </div>

        <div className="sys-card">
          <h3 className="sys-h3">🧮 Calculateur de trade</h3>
          <input className="sys-input" value={calc} onChange={(e) => setCalc(e.target.value)} placeholder="Prix d'entrée, ex. 1.234" />
          {ce > 0 && (
            <div className="sys-calc">
              <div><span>Stop</span><b className="neg">{fp(ce * 0.95)}</b></div>
              <div><span>Trailing dès</span><b className="pos">{fp(ce * 1.05)}</b></div>
              <div><span>Sortie max</span><b>{dd(Date.now() + 14 * DAY)}</b></div>
              <div><span>Perte max / 10 $</span><b>≈ 0,53 $</b></div>
            </div>
          )}
        </div>

        <div className="sys-card">
          <h3 className="sys-h3">📜 Les règles</h3>
          <ol className="sys-rules">
            <li><b>Feu BTC</b> (clôture jour) : 🔴 aucune entrée · 🟡 ou 🟢 on prend les cassures.</li>
            <li><b>Signal</b> : token calme (box 14 j parmi les plus étroites de ses 120 j, quiet ≤ 10) et une bougie 1H clôture au-dessus du plafond.</li>
            <li><b>Trade</b> : 10 $ · stop −5 % · dès +5 % trailing 5 % · 14 jours max.</li>
          </ol>
          <div className="sys-muted">Backtest 4 vagues (337 alts) : 672 trades 🟡/🟢, +111 $, PF 1,77 · trades en 🔴 ≈ 0 $. Pas un conseil financier.</div>
        </div>
      </section>
    </div>
  );
}

function Cond({ ok, name, lvl, gap }) {
  return (
    <div className={`sys-cond ${ok ? 'ok' : 'no'}`}>
      <div className="sys-cond-k">{ok ? '✓' : '✗'} {name}</div>
      <div className="sys-cond-v">{fp(lvl)}</div>
      <div className="sys-cond-s">{ok ? 'au-dessus' : `encore ${pc(gap)}`}</div>
    </div>
  );
}
function Tile({ k, v, s, c = '' }) {
  return <div className="sys-tile"><div className="sys-tile-k">{k}</div><div className={`sys-tile-v ${c}`}>{v}</div><div className="sys-tile-s">{s}</div></div>;
}

const CSS = `
.sys{--r:14px}
.sys-crumb{font-family:var(--mono);font-size:12px;letter-spacing:.12em;color:var(--muted)}
.sys-card{background:linear-gradient(180deg,var(--card2),var(--card));border:1px solid var(--line);border-radius:var(--r);padding:16px;min-width:0}
.sys-wait{color:var(--muted);font-size:13px;display:flex;align-items:center;justify-content:center;min-height:80px}
.sys-muted{color:var(--muted);font-size:12px}
.sys-hero{display:flex;gap:22px;align-items:center;flex-wrap:wrap;padding:22px;border-radius:18px;margin:14px 0;border:1px solid color-mix(in srgb,var(--lc) 35%,var(--line));
 background:radial-gradient(120% 140% at 0% 0%,color-mix(in srgb,var(--lc) 16%,transparent),transparent 60%),var(--card)}
.sys-orb{width:78px;height:78px;border-radius:50%;display:grid;place-items:center;font-size:42px;background:color-mix(in srgb,var(--lc) 12%,var(--card2));
 box-shadow:0 0 0 1px color-mix(in srgb,var(--lc) 40%,transparent),0 0 40px color-mix(in srgb,var(--lc) 35%,transparent)}
.sys-hero-main{flex:1;min-width:220px}
.sys-kicker{font-family:var(--mono);font-size:11px;letter-spacing:.16em;color:var(--muted)}
.sys-hero-title{font-size:24px;font-weight:800;color:var(--lc);margin:4px 0}
.sys-conds{display:flex;gap:10px;flex-wrap:wrap}
.sys-cond{min-width:150px;padding:10px 12px;border-radius:10px;background:var(--card2);border:1px solid var(--line)}
.sys-cond.ok{border-color:color-mix(in srgb,var(--green) 40%,var(--line))}.sys-cond.no{border-color:color-mix(in srgb,var(--red) 35%,var(--line))}
.sys-cond-k{font-size:11px;color:var(--muted)}.sys-cond.ok .sys-cond-k{color:var(--green)}.sys-cond.no .sys-cond-k{color:var(--red)}
.sys-cond-v{font-family:var(--mono);font-size:18px;font-weight:700;margin-top:2px}.sys-cond-s{font-size:11px;color:var(--muted)}
.sys-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:18px}
.sys-tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.sys-tile-k{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.sys-tile-v{font-family:var(--mono);font-size:22px;font-weight:700;margin:4px 0 2px}.sys-tile-s{font-size:11px;color:var(--muted)}
.sys-h{font-size:15px;font-weight:700;margin:6px 0 10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.sys-h3{font-size:14px;font-weight:700;margin:0 0 10px}
.sys-tag{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--card2);border:1px solid var(--line)}
.sys-three{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin-bottom:18px}
.sys-tok.hot{border-color:color-mix(in srgb,var(--gold) 55%,var(--line));box-shadow:0 0 24px color-mix(in srgb,var(--gold) 12%,transparent)}
.sys-tok-head{display:flex;align-items:baseline;gap:10px;margin-bottom:8px}
.sys-rank{font-family:var(--mono);color:var(--muted);font-size:12px}
.sys-sym{font-size:18px;font-weight:800;color:var(--text);text-decoration:none}.sys-sym:hover{color:var(--cyan)}
.sys-price{font-family:var(--mono);color:var(--muted);font-size:13px}
.sys-dist{margin-left:auto;font-family:var(--mono);font-weight:700;font-size:15px;color:var(--cyan)}
.sys-chart{width:100%;height:190px;display:block;background:var(--bg);border-radius:10px;border:1px solid var(--line)}
.sys-tok-foot{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:8px}.sys-tok-foot b{color:var(--text);font-family:var(--mono)}
.sys-tok-foot a{margin-left:auto}
.sys-hotline{margin-top:8px;font-size:12px;color:var(--gold);font-weight:600}
.sys-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px;margin-bottom:30px}
.sys-table{width:100%;border-collapse:collapse;font-size:12px}
.sys-table th{text-align:left;font-weight:500;color:var(--muted);font-size:11px;padding:6px 6px;border-bottom:1px solid var(--line)}
.sys-table td{padding:7px 6px;border-bottom:1px solid color-mix(in srgb,var(--line) 60%,transparent);font-family:var(--mono)}
.sys-table a{color:var(--text);text-decoration:none}
.sys-sub{font-size:12px;color:var(--muted);margin:10px 0 6px}
.sys-input{width:100%;box-sizing:border-box;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-family:var(--mono);font-size:14px}
.sys-input:focus{outline:none;border-color:var(--cyan)}
.sys-calc{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
.sys-calc div{background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:8px 10px}
.sys-calc span{display:block;font-size:11px;color:var(--muted)}.sys-calc b{font-family:var(--mono);font-size:16px}
.sys-rules{margin:0 0 10px;padding-left:18px;font-size:13px;line-height:1.6}
@media (max-width:520px){.sys-hero{padding:16px}.sys-orb{width:60px;height:60px;font-size:32px}.sys-grid,.sys-three{grid-template-columns:1fr}}
`;
