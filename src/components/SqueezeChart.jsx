import { useEffect, useState } from 'react';
import { fetchKlines } from '../lib/bybit.js';
import { parseKlines } from '../core/bars.js';
import { fmtPrice } from '../lib/format.js';

const R = 70, T = 10, B = 10;

/** 4H candles (~30 days) with the 14-day box. `compact` = small card version. */
export function SqueezeChart({ row, livePrice, compact = false }) {
  const W = compact ? 420 : 900;
  const H = compact ? 200 : 300;
  const [bars, setBars] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true;
    setBars(null); setErr(null);
    fetchKlines(row.symbol, '240', 180).then((k) => alive && setBars(parseKlines(k))).catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [row.symbol]);
  if (err) return <div className="muted small">Erreur : {err}</div>;
  if (!bars) return <div className="muted small">Chargement…</div>;

  const n = bars.t.length;
  const price = livePrice || row.price;
  const plan = row.plan;
  let lo = Math.min(row.low, price, plan ? plan.stop : Infinity, ...bars.l), hi = Math.max(row.high, price, plan ? plan.target : 0, ...bars.h);
  const p = (hi - lo) * 0.05; lo -= p; hi += p;
  const x = (i) => ((i + 0.5) / n) * (W - R);
  const y = (v) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const cw = Math.max(1, ((W - R) / n) * 0.65);
  const bi = bars.t.findIndex((t) => t >= row.boxFrom);
  const bx = bi < 0 ? 0 : x(bi) - cw;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="sq-chart">
      <rect x={bx} y={y(row.high)} width={W - R - bx} height={y(row.low) - y(row.high)} className="sq-box" />
      <line x1={bx} x2={W - R} y1={y(row.high)} y2={y(row.high)} className="sq-ceil" />
      {bars.t.map((t, i) => {
        const top = y(Math.max(bars.o[i], bars.c[i])), bot = y(Math.min(bars.o[i], bars.c[i]));
        return (
          <g key={t} className={bars.c[i] >= bars.o[i] ? 'sq-up' : 'sq-dn'}>
            <line x1={x(i)} x2={x(i)} y1={y(bars.h[i])} y2={y(bars.l[i])} />
            <rect x={x(i) - cw / 2} y={top} width={cw} height={Math.max(1, bot - top)} />
          </g>
        );
      })}
      <line x1={0} x2={W - R} y1={y(price)} y2={y(price)} className="sq-price" />
      {plan && (
        <>
          <line x1={0} x2={W - R} y1={y(plan.stop)} y2={y(plan.stop)} className="sq-sl" />
          <line x1={0} x2={W - R} y1={y(plan.target)} y2={y(plan.target)} className="sq-tp" />
          <text x={W - R + 4} y={y(plan.stop) + 4} className="sq-lbl sl">SL {fmtPrice(plan.stop)}</text>
          <text x={W - R + 4} y={y(plan.target) + 4} className="sq-lbl tp">TP {fmtPrice(plan.target)}</text>
        </>
      )}
      <text x={W - R + 4} y={y(row.high) + 4} className="sq-lbl ceil">{fmtPrice(row.high)}</text>
      <text x={W - R + 4} y={y(row.low) + 4} className="sq-lbl">{fmtPrice(row.low)}</text>
      <text x={W - R + 4} y={y(price) + 4} className="sq-lbl px">{fmtPrice(price)}</text>
    </svg>
  );
}
