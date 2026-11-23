import { useEffect, useState } from 'react';
import { fetchKlines } from '../lib/bybit.js';
import { parseKlines } from '../core/bars.js';
import { avgRallyShape, simColor } from './SimChart.jsx';

const HOUR = 3_600_000; const DAY = 24 * HOUR;
const W = 900; const H = 340; const P = { l: 44, r: 10, t: 18, b: 22 };
const REFRESH = 60_000;

/**
 * Zoom on the last 24h, live: solid = real price (1H candles + live price),
 * dashed = the simulation, anchored at today's 00:00 UTC (base 100 there for
 * every line), drawn up to 24h ahead. The real line keeps moving over it.
 */
export function ZoomChart({ waves, tokens, btcMove, days, prices }) {
  const [d, setD] = useState(null);
  const [tick, setTick] = useState(0);
  const [hover, setHover] = useState(null); // highlighted token (legend hover)
  const syms = ['BTCUSDT', ...tokens.map((t) => t.symbol)];
  const key = syms.join(',');

  useEffect(() => {
    let alive = true;
    const load = () => Promise.all([
      fetchKlines('BTCUSDT', 'D', 400).then(parseKlines),
      ...syms.map((s) => fetchKlines(s, '60', 60).then(parseKlines).catch(() => null)),
    ]).then(([daily, ...h]) => alive && setD({ daily, h: Object.fromEntries(syms.map((s, i) => [s, h[i]])) }));
    load();
    const a = setInterval(load, REFRESH);
    const b = setInterval(() => setTick((x) => x + 1), 20_000); // follow the live price
    return () => { alive = false; clearInterval(a); clearInterval(b); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!d) return <div className="muted small">Chargement des dernières 24 h…</div>;
  void tick;
  const now = Date.now();
  const tA = Math.floor((now - DAY) / HOUR) * HOUR; // simulation anchor: rolling, 24h ago (on the hour)
  const x0 = tA; const x1 = now + 6 * HOUR; // the rolling last 24h + 6h of simulation ahead
  const shape = avgRallyShape(d.daily, waves.filter((w) => w.kind === 'up' && !w.open));
  const lines = [{ s: 'BTCUSDT', name: 'BTC', amp: 1 }, ...tokens.map((t) => ({ s: t.symbol, name: t.symbol.replace('USDT', ''), amp: t.upAmp ?? 1 }))]
    .map((l, i) => {
      const b = d.h[l.s];
      if (!b || !b.t.length) return null;
      const iA = b.t.findIndex((t) => t >= tA); // 1H candle opening at 00:00 -> its open = price at the anchor
      const base = iA >= 0 ? b.o[iA] : b.c[b.c.length - 1];
      const real = [];
      for (let k = 0; k < b.t.length; k++) if (b.t[k] + HOUR >= x0) real.push([Math.min(now, b.t[k] + HOUR), (b.c[k] / base) * 100]);
      const live = prices[l.s];
      if (live > 0) real.push([now, (live / base) * 100]);
      const sim = Array.from({ length: 49 }, (_, k) => { const t = tA + (k / 48) * (x1 - tA); return [t, 100 * (1 + l.amp * btcMove * shape((t - tA) / (days * DAY)))]; });
      const simNow = 100 * (1 + l.amp * btcMove * shape((now - tA) / (days * DAY)));
      return { ...l, color: i === 0 ? '#ffffffcc' : simColor(i - 1), real, sim, realNow: real.length ? real[real.length - 1][1] : null, simNow };
    }).filter(Boolean);

  // Only the real data and the simulation up to x1 set the vertical scale (tight zoom).
  // Scale on the real prices and the simulated value now; dashed lines going further are clipped.
  const vals = lines.flatMap((l) => l.real.map((p) => p[1]));
  let lo = Math.min(...vals); let hi = Math.max(...vals); const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
  const x = (t) => P.l + ((t - x0) / (x1 - x0)) * (W - P.l - P.r);
  const y = (v) => P.t + ((hi - v) / (hi - lo)) * (H - P.t - P.b);
  const path = (s) => s.filter(([t]) => t >= x0 && t <= x1).map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const hours = []; for (let t = Math.ceil(x0 / (3 * HOUR)) * 3 * HOUR; t <= x1; t += 3 * HOUR) hours.push(t);
  const fmt = (v) => (v == null ? '—' : `${v >= 100 ? '+' : ''}${(v - 100).toFixed(1)}%`);
  const step = (hi - lo) > 20 ? 5 : (hi - lo) > 8 ? 2 : 1;
  const grid = []; for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) grid.push(v);
  const table = [...lines].sort((a, b) => (b.realNow ?? 0) - (a.realNow ?? 0));
  const dim = (s) => (hover && hover !== s ? 0.12 : 1);
  // Last HH of each token: highest 1H high of the last 24h, and the live distance to it.
  const hh = lines.map((l) => {
    const b = d.h[l.s];
    let hi = -Infinity; let at = null;
    for (let k = 0; k < b.t.length; k++) if (b.t[k] + HOUR > now - DAY && b.h[k] > hi) { hi = b.h[k]; at = b.t[k]; }
    const price = prices[l.s] > 0 ? prices[l.s] : b.c[b.c.length - 1];
    return { ...l, hi, at, price, dist: price / hi - 1 };
  }).filter((x) => Number.isFinite(x.hi)).sort((a, b) => b.dist - a.dist);
  const barVals = lines.flatMap((l) => [l.realNow ?? 100, l.simNow, 100]);
  const barLo = Math.min(...barVals); const barHi = Math.max(...barVals) + 0.5;

  const fp = (p) => (p >= 1000 ? p.toFixed(0) : p >= 1 ? p.toFixed(3) : p.toPrecision(4));
  return (
    <>
    <div className="zm-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="sq-chart" aria-label="Zoom sur les dernières 24 heures, réel contre simulation">
        <defs><clipPath id="zm-clip"><rect x={P.l} y={P.t} width={W - P.l - P.r} height={H - P.t - P.b} /></clipPath></defs>
        <rect x={x(now)} y={P.t} width={x(x1) - x(now)} height={H - P.t - P.b} className="sim-zone" />
        {grid.map((v) => <g key={v}><line x1={P.l} x2={x(x1)} y1={y(v)} y2={y(v)} className="sim-grid" /><text x={4} y={y(v) + 4} className="sq-lbl">{v === 100 ? '100' : `${v > 100 ? '+' : ''}${v - 100}%`}</text></g>)}
        <line x1={x(tA)} x2={x(tA)} y1={P.t} y2={H - P.b} className="sq-ceil" />
        <text x={x(tA) + 4} y={P.t + 12} className="sq-lbl">il y a 24 h · départ simulation (base 100)</text>
        <line x1={x(now)} x2={x(now)} y1={P.t} y2={H - P.b} className="zm-now" />
        <text x={x(now) + 4} y={P.t + 12} className="sq-lbl">maintenant</text>
        {hours.map((t) => <text key={t} x={x(t)} y={H - 6} textAnchor="middle" className="sq-lbl">{new Date(t).toISOString().slice(11, 16)}</text>)}
        {lines.map((l) => {
          const btc = l.s === 'BTCUSDT';
          const on = hover === l.s;
          // Dashed simulation only for the hovered token (or when few tokens), real lines thin; BTC = reference.
          const showSim = on || lines.length <= 6;
          return (
            <g key={l.s} opacity={hover ? dim(l.s) : btc ? 1 : 0.55} clipPath="url(#zm-clip)">
              {showSim && <polyline points={path(l.sim)} fill="none" stroke={l.color} strokeWidth="2" strokeDasharray="6 4" />}
              <polyline points={path(l.real)} fill="none" stroke={btc ? '#ffffff' : l.color} strokeWidth={on ? 3 : btc ? 2.6 : 1.2} />
              {l.realNow != null && <circle cx={x(now)} cy={y(l.realNow)} r={on ? 5 : btc ? 4 : 2.5} fill={btc ? '#ffffff' : l.color} />}
              {on && <text x={x(now) - 6} y={y(l.realNow ?? 100) - 8} textAnchor="end" fill={l.color} className="zm-lbl">{l.name} {fmt(l.realNow)} · sim {fmt(l.simNow)}</text>}
            </g>
          );
        })}
      </svg>
      <div className="zm-legend">
        <div className="zm-row zm-head"><span>Token</span><span>Réel</span><span>Réel ▮ contre sim │</span><span>Écart</span></div>
        {table.map((l) => {
          const gap = l.realNow != null ? l.realNow - l.simNow : null;
          // Mini bar on a shared scale: filled = real, tick = simulation.
          const sc = (v) => `${Math.max(0, Math.min(100, ((v - barLo) / (barHi - barLo)) * 100))}%`;
          return (
            <div key={l.s} className={`zm-row ${hover === l.s ? 'on' : ''}`} onMouseEnter={() => setHover(l.s)} onMouseLeave={() => setHover(null)}>
              <span><i style={{ background: l.s === 'BTCUSDT' ? '#fff' : l.color }} />{l.name}</span>
              <b className={l.realNow >= 100 ? 'pos' : 'neg'}>{fmt(l.realNow)}</b>
              <span className="zm-bar">
                <span className="zm-zero" style={{ left: sc(100) }} />
                <span className={`zm-fill ${l.realNow >= 100 ? 'up' : 'dn'}`} style={{ left: l.realNow >= 100 ? sc(100) : sc(l.realNow ?? 100), width: `calc(${sc(Math.max(l.realNow ?? 100, 100))} - ${sc(Math.min(l.realNow ?? 100, 100))})` }} />
                <span className="zm-sim" style={{ left: sc(l.simNow) }} title={`sim ${fmt(l.simNow)}`} />
              </span>
              <span className={gap == null ? 'muted' : gap >= 0 ? 'pos' : 'neg'}>{gap == null ? '—' : `${gap >= 0 ? '+' : ''}${gap.toFixed(1)}`}</span>
            </div>
          );
        })}
      </div>
    </div>
    <div className="card-title" style={{ marginTop: 8 }}>📍 DERNIER HH (plus haut des 24 dernières heures) · du plus proche au plus loin</div>
    <div className="table-wrap">
      <table className="sq-table">
        <thead><tr><th>#</th><th>Token</th><th>HH 24 h</th><th>Heure du HH (UTC)</th><th>Prix live</th><th>Distance au HH</th></tr></thead>
        <tbody>
          {hh.map((x, i) => (
            <tr key={x.s} className={hover === x.s ? 'on' : ''} onMouseEnter={() => setHover(x.s)} onMouseLeave={() => setHover(null)}>
              <td className="muted">{i + 1}</td>
              <td><b>{x.name}</b></td>
              <td>{fp(x.hi)}</td>
              <td className="muted">{new Date(x.at).toISOString().slice(11, 16)}</td>
              <td>{fp(x.price)}</td>
              <td className={x.dist >= 0 ? 'pos' : x.dist > -0.03 ? 'gold' : 'neg'}><b>{x.dist >= 0 ? `au-dessus +${(x.dist * 100).toFixed(1)}%` : `${(x.dist * 100).toFixed(1)}%`}</b></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
  );
}
