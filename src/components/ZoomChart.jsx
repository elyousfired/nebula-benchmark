import { useEffect, useState } from 'react';
import { fetchKlines } from '../lib/bybit.js';
import { parseKlines } from '../core/bars.js';
import { avgRallyShape, simColor } from './SimChart.jsx';

const HOUR = 3_600_000; const DAY = 24 * HOUR;
const W = 960; const H = 300; const P = { l: 44, r: 150, t: 14, b: 22 };
const REFRESH = 60_000;

/**
 * Zoom on the last 24h, live: solid = real price (1H candles + live price),
 * dashed = the simulation, anchored at today's 00:00 UTC (base 100 there for
 * every line), drawn up to 24h ahead. The real line keeps moving over it.
 */
export function ZoomChart({ waves, tokens, btcMove, days, prices }) {
  const [d, setD] = useState(null);
  const [tick, setTick] = useState(0);
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
  const tA = Math.floor(now / DAY) * DAY; // simulation anchor: today 00:00 UTC
  const x0 = now - DAY; const x1 = now + DAY;
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

  const vals = lines.flatMap((l) => [...l.real, ...l.sim.filter(([t]) => t <= x1)].map((p) => p[1]));
  let lo = Math.min(...vals); let hi = Math.max(...vals); const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
  const x = (t) => P.l + ((t - x0) / (x1 - x0)) * (W - P.l - P.r);
  const y = (v) => P.t + ((hi - v) / (hi - lo)) * (H - P.t - P.b);
  const path = (s) => s.filter(([t]) => t >= x0 && t <= x1).map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const hours = []; for (let t = Math.ceil(x0 / (6 * HOUR)) * 6 * HOUR; t <= x1; t += 6 * HOUR) hours.push(t);
  const fmt = (v) => `${v >= 100 ? '+' : ''}${(v - 100).toFixed(1)}%`;
  // Right-side labels, pushed apart so they never overlap.
  const labels = lines.map((l) => ({ l, yy: y(l.realNow ?? l.simNow) })).sort((a, b) => a.yy - b.yy);
  for (let k = 1; k < labels.length; k++) labels[k].yy = Math.max(labels[k].yy, labels[k - 1].yy + 13);

  return (
    <svg viewBox={`0 0 ${W} ${Math.max(H, (labels[labels.length - 1]?.yy ?? 0) + 10)}`} className="sq-chart" aria-label="Zoom sur les dernières 24 heures, réel contre simulation">
      <rect x={x(now)} y={P.t} width={x(x1) - x(now)} height={H - P.t - P.b} className="sim-zone" />
      <line x1={x(tA)} x2={x(tA)} y1={P.t} y2={H - P.b} className="sq-ceil" />
      <text x={x(tA) + 4} y={P.t + 12} className="sq-lbl">00:00 UTC · départ simulation (base 100)</text>
      <line x1={x(now)} x2={x(now)} y1={P.t} y2={H - P.b} className="zm-now" />
      <text x={x(now) + 4} y={H - P.b - 6} className="sq-lbl">maintenant</text>
      {hours.map((t) => <text key={t} x={x(t)} y={H - 6} textAnchor="middle" className="sq-lbl">{new Date(t).toISOString().slice(11, 16)}</text>)}
      <line x1={P.l} x2={x(x1)} y1={y(100)} y2={y(100)} className="sim-grid" />
      <text x={4} y={y(100) + 4} className="sq-lbl">100</text>
      {lines.map((l) => (
        <g key={l.s}>
          <polyline points={path(l.sim)} fill="none" stroke={l.color} strokeWidth="1.5" strokeDasharray="4 4" opacity="0.8" />
          <polyline points={path(l.real)} fill="none" stroke={l.color} strokeWidth={l.s === 'BTCUSDT' ? 2 : 1.8} />
          {l.realNow != null && <circle cx={x(now)} cy={y(l.realNow)} r="3" fill={l.color} />}
        </g>
      ))}
      {labels.map(({ l, yy }) => (
        <text key={l.s} x={x(x1) + 6} y={yy + 4} fill={l.color} className="zm-lbl">
          {l.name} {l.realNow != null ? fmt(l.realNow) : '—'} <tspan className="muted">(sim {fmt(l.simNow)})</tspan>
        </text>
      ))}
    </svg>
  );
}
