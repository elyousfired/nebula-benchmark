import { useEffect, useMemo, useState } from 'react';
import { fetchKlines } from '../lib/bybit.js';
import { parseKlines } from '../core/bars.js';

const DAY = 86_400_000;
const W = 960; const H = 340; const P = { l: 44, r: 90, t: 14, b: 22 };
export const SIM_COLORS = ['#facc15', '#22d3ee', '#a855f7', '#fb923c', '#00ff88', '#f472b6'];
/** Color of the i-th token: the 6 base colors, then distinct hues (golden angle). */
export const simColor = (i) => (i < SIM_COLORS.length ? SIM_COLORS[i] : `hsl(${Math.round((i * 137.5) % 360)}, 75%, 62%)`);

/**
 * BTC's average rally shape: each past up wave resampled on 0..1 time and
 * scaled to 0..1 of its own move, then averaged. Returns f(x) for x in [0, 1].
 */
export function avgRallyShape(btc, upWaves, steps = 50) {
  const curves = upWaves.map((w) => {
    const i0 = btc.t.findIndex((t) => t >= w.t0); let i1 = btc.t.findIndex((t) => t >= w.t1);
    if (i0 < 0) return null; if (i1 < 0) i1 = btc.t.length - 1;
    const p0 = btc.c[i0]; const move = btc.c[i1] / p0 - 1;
    if (!move) return null;
    return Array.from({ length: steps + 1 }, (_, k) => { const i = Math.round(i0 + (k / steps) * (i1 - i0)); return (btc.c[i] / p0 - 1) / move; });
  }).filter(Boolean);
  const avg = Array.from({ length: steps + 1 }, (_, k) => curves.reduce((a, c) => a + c[k], 0) / curves.length);
  return (x) => { const f = Math.min(steps, Math.max(0, x * steps)); const k = Math.floor(f); const r = f - k; return k >= steps ? avg[steps] : avg[k] * (1 - r) + avg[k + 1] * r; };
}

/**
 * History (base 100 at the first wave) + projection: BTC rises `btcMove` over
 * `days` days along its average rally shape; each token moves upAmp × BTC's move.
 */
export function SimChart({ waves, tokens, btcMove, days }) {
  const [bars, setBars] = useState(null);
  const syms = tokens.map((t) => t.symbol).join(',');
  useEffect(() => {
    let alive = true;
    const list = ['BTCUSDT', ...tokens.map((t) => t.symbol)];
    Promise.all(list.map((s) => fetchKlines(s, 'D', 400).then(parseKlines).catch(() => null)))
      .then((r) => alive && setBars(Object.fromEntries(list.map((s, i) => [s, r[i]]))));
    return () => { alive = false; };
  }, [syms]); // eslint-disable-line react-hooks/exhaustive-deps

  const model = useMemo(() => {
    if (!bars?.BTCUSDT) return null;
    const btc = bars.BTCUSDT;
    const shape = avgRallyShape(btc, waves.filter((w) => w.kind === 'up' && !w.open));
    const t0 = waves[0].t0;
    const now = btc.t[btc.t.length - 1];
    const hist = (b) => { if (!b) return null; const i0 = b.t.findIndex((t) => t >= t0); if (i0 < 0) return null; const base = b.c[i0]; return b.t.slice(i0).map((t, k) => [t, (b.c[i0 + k] / base) * 100]); };
    const proj = (h, amp) => { if (!h) return null; const [tl, vl] = h[h.length - 1]; return Array.from({ length: 41 }, (_, k) => { const x = k / 40; return [tl + x * days * DAY, vl * (1 + amp * btcMove * shape(x))]; }); };
    const lines = [{ s: 'BTCUSDT', name: 'BTC', amp: 1, color: '#ffffffcc' }, ...tokens.map((t, i) => ({ s: t.symbol, name: t.symbol.replace('USDT', ''), amp: t.upAmp ?? 1, color: simColor(i) }))]
      .map((l) => { const h = hist(bars[l.s]); return { ...l, h, p: proj(h, l.amp) }; }).filter((l) => l.h);
    return { lines, t0, now, tEnd: now + days * DAY };
  }, [bars, waves, tokens, btcMove, days]);

  if (!model) return <div className="muted small">Chargement des prix…</div>;
  const { lines, t0, now, tEnd } = model;
  const vals = lines.flatMap((l) => [...l.h, ...l.p].map((p) => Math.log(p[1])));
  let lo = Math.min(...vals); let hi = Math.max(...vals); const pad = (hi - lo) * 0.05; lo -= pad; hi += pad;
  const x = (t) => P.l + ((t - t0) / (tEnd - t0)) * (W - P.l - P.r);
  const y = (v) => P.t + ((hi - Math.log(v)) / (hi - lo)) * (H - P.t - P.b);
  const path = (s) => s.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const ticks = [50, 100, 200, 400, 800, 1600].filter((v) => Math.log(v) > lo && Math.log(v) < hi);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="sq-chart" aria-label="Historique et simulation de la prochaine hausse du BTC">
      {waves.map((w) => <rect key={w.name} x={x(w.t0)} y={P.t} width={Math.max(1, x(Math.min(w.t1, now)) - x(w.t0))} height={H - P.t - P.b} className={w.kind === 'up' ? 'wv-up' : 'wv-dn'} />)}
      <rect x={x(now)} y={P.t} width={x(tEnd) - x(now)} height={H - P.t - P.b} className="sim-zone" />
      <text x={x(now) + 6} y={P.t + 14} className="sq-lbl">Simulation : BTC {btcMove >= 0 ? '+' : ''}{Math.round(btcMove * 100)} % en {days} j</text>
      {waves.map((w) => <text key={`l${w.name}`} x={x(w.t0) + 4} y={H - P.b - 6} className="sq-lbl">{w.name}</text>)}
      {ticks.map((v) => <g key={v}><line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} className="sim-grid" /><text x={4} y={y(v) + 4} className="sq-lbl">{v}</text></g>)}
      {lines.map((l) => (
        <g key={l.s}>
          <polyline points={path(l.h)} fill="none" stroke={l.color} strokeWidth={l.s === 'BTCUSDT' ? 1.5 : 2} />
          <polyline points={path(l.p)} fill="none" stroke={l.color} strokeWidth="2" strokeDasharray="5 4" />
          <text x={x(tEnd) + 4} y={y(l.p[l.p.length - 1][1]) + 4} fill={l.color} className="sim-end">{l.name} {(l.p[l.p.length - 1][1] / l.p[0][1] - 1) >= 0 ? '+' : ''}{Math.round((l.p[l.p.length - 1][1] / l.p[0][1] - 1) * 100)}%</text>
        </g>
      ))}
    </svg>
  );
}
