import { useEffect, useState } from 'react';
import { fetchKlines } from '../lib/bybit.js';
import { parseKlines } from '../core/bars.js';

const W = 900; const H = 260; const P = { l: 40, r: 10, t: 10, b: 20 };

/** Token vs BTC (base 100 at the first wave), BTC waves shaded green / red. */
export function WaveChart({ symbol, waves }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true;
    setD(null); setErr(null);
    Promise.all([fetchKlines(symbol, 'D', 400), fetchKlines('BTCUSDT', 'D', 400)])
      .then(([a, b]) => alive && setD({ tok: parseKlines(a), btc: parseKlines(b) }))
      .catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [symbol]);
  if (err) return <div className="muted small">Erreur : {err}</div>;
  if (!d) return <div className="muted small">Chargement…</div>;

  const t0 = waves[0].t0; const tEnd = Date.now();
  const series = (b) => {
    const i0 = b.t.findIndex((t) => t >= t0);
    if (i0 < 0) return [];
    const base = b.c[i0];
    return b.t.slice(i0).map((t, k) => [t, (b.c[i0 + k] / base) * 100]);
  };
  const st = series(d.tok); const sb = series(d.btc);
  const all = [...st, ...sb].map((p) => p[1]);
  let lo = Math.min(...all); let hi = Math.max(...all);
  const pad = (hi - lo) * 0.05; lo -= pad; hi += pad;
  const x = (t) => P.l + ((t - t0) / (tEnd - t0)) * (W - P.l - P.r);
  const y = (v) => P.t + ((hi - v) / (hi - lo)) * (H - P.t - P.b);
  const line = (s) => s.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const ticks = [lo, 100, hi].map((v) => Math.round(v));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="sq-chart" aria-label={`${symbol} contre BTC, base 100`}>
      {waves.map((w) => <rect key={w.name} x={x(w.t0)} y={P.t} width={Math.max(1, x(w.t1) - x(w.t0))} height={H - P.t - P.b} className={w.kind === 'up' ? 'wv-up' : 'wv-dn'} />)}
      {waves.map((w) => <text key={`l${w.name}`} x={x(w.t0) + 4} y={P.t + 12} className="sq-lbl">{w.name}</text>)}
      <line x1={P.l} x2={W - P.r} y1={y(100)} y2={y(100)} className="sq-price" />
      {ticks.map((v) => <text key={v} x={2} y={y(v) + 4} className="sq-lbl">{v}</text>)}
      <polyline points={line(sb)} className="wv-btc" />
      <polyline points={line(st)} className="wv-tok" />
    </svg>
  );
}
