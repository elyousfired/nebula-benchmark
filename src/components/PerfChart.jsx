import { useEffect, useMemo, useRef, useState } from 'react';
import { colorOf, fmtPts } from '../lib/format.js';

const PAD = { l: 52, r: 70, t: 14, b: 26 };

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(900);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceTicks(min, max, count = 6) {
  const span = max - min || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

const HOUR = 3_600_000;
const STEPS = [1, 2, 3, 4, 6, 12, 24, 48, 72, 96, 168].map((h) => h * HOUR);

/** Round-time x ticks (every 3h, 1 day, 4 days…), at most ~7. */
function timeTicks(min, max) {
  const step = STEPS.find((s) => (max - min) / s <= 7) || STEPS[STEPS.length - 1];
  const out = [];
  for (let x = Math.ceil(min / step) * step; x <= max; x += step) out.push(x);
  return out;
}

function fmtX(ts, horizon) {
  const d = new Date(ts);
  if (horizon === 'day') return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) + (horizon === 'week' || horizon === 'd3' ? ` ${String(d.getHours()).padStart(2, '0')}h` : '');
}

/**
 * Multi-line performance chart (pts = % since the horizon start), drawn in SVG.
 * Lines are matched on timestamps; hover shows the values at that time.
 */
export function PerfChart({ curves, order, bench, ema, hlines = [], horizon, height = 460, highlight, onHighlight, showBench }) {
  const [wrapRef, width] = useWidth();
  const [hoverX, setHoverX] = useState(null);

  const geo = useMemo(() => {
    let xMin = Infinity; let xMax = -Infinity; let yMin = 0; let yMax = 0;
    for (const sym of order) {
      for (const p of curves[sym] || []) {
        if (p.x < xMin) xMin = p.x;
        if (p.x > xMax) xMax = p.x;
        if (p.v < yMin) yMin = p.v;
        if (p.v > yMax) yMax = p.v;
      }
    }
    for (const h of hlines) { if (h.v < yMin) yMin = h.v; if (h.v > yMax) yMax = h.v; }
    if (!Number.isFinite(xMin)) { xMin = 0; xMax = 1; }
    const padY = (yMax - yMin) * 0.06 || 1;
    yMin -= padY; yMax += padY;
    const iw = width - PAD.l - PAD.r;
    const ih = height - PAD.t - PAD.b;
    const sx = (x) => PAD.l + ((x - xMin) / (xMax - xMin || 1)) * iw;
    const sy = (v) => PAD.t + (1 - (v - yMin) / (yMax - yMin || 1)) * ih;
    const lookup = {};
    for (const sym of order) lookup[sym] = new Map((curves[sym] || []).map((p) => [p.x, p.v]));
    const xs = [...new Set(order.flatMap((s) => (curves[s] || []).map((p) => p.x)))].sort((a, b) => a - b);
    return { xMin, xMax, yMin, yMax, sx, sy, iw, ih, lookup, xs };
  }, [curves, order, hlines, width, height]);

  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${geo.sx(p.x).toFixed(1)},${geo.sy(p.v).toFixed(1)}`).join('');

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < PAD.l || px > width - PAD.r || !geo.xs.length) { setHoverX(null); return; }
    const x = geo.xMin + ((px - PAD.l) / geo.iw) * (geo.xMax - geo.xMin);
    let best = geo.xs[0];
    for (const v of geo.xs) if (Math.abs(v - x) < Math.abs(best - x)) best = v;
    setHoverX(best);
  };

  const hoverRows = useMemo(() => {
    if (hoverX == null) return [];
    return order
      .map((s) => ({ s, v: geo.lookup[s]?.get(hoverX) }))
      .filter((r) => r.v != null)
      .sort((a, b) => b.v - a.v);
  }, [hoverX, order, geo]);

  const benchAtHover = hoverX != null ? bench.find((p) => p.x === hoverX)?.v : null;
  const yTicks = niceTicks(geo.yMin, geo.yMax);
  const xTicks = timeTicks(geo.xMin, geo.xMax);

  // End labels: highlighted token or the 6 best finishers.
  const endLabels = (highlight ? [highlight] : order.slice(0, 6)).filter((s) => curves[s]?.length);

  return (
    <div ref={wrapRef} className="chart-wrap">
      <svg width={width} height={height} onMouseMove={onMove} onMouseLeave={() => setHoverX(null)} role="img" aria-label="Courbes de performance">
        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line x1={PAD.l} x2={width - PAD.r} y1={geo.sy(v)} y2={geo.sy(v)} className={v === 0 ? 'grid zero' : 'grid'} />
            <text x={PAD.l - 6} y={geo.sy(v) + 4} className="axis" textAnchor="end">{v > 0 ? `+${v}` : v}</text>
          </g>
        ))}
        {xTicks.map((x) => (
          <text key={`x${x}`} x={geo.sx(x)} y={height - 8} className="axis" textAnchor="middle">{fmtX(x, horizon)}</text>
        ))}

        {hlines.map((h) => (
          <g key={h.label}>
            <line x1={PAD.l} x2={width - PAD.r} y1={geo.sy(h.v)} y2={geo.sy(h.v)} stroke={h.color} strokeDasharray={h.dash || '6 4'} strokeWidth="1.2" opacity="0.9" />
            <text x={width - PAD.r + 4} y={geo.sy(h.v) + 4} fill={h.color} className="hlabel">{h.short || h.label}</text>
          </g>
        ))}

        {order.map((sym) => {
          const pts = curves[sym];
          if (!pts?.length) return null;
          const dim = highlight && highlight !== sym;
          return (
            <path
              key={sym}
              d={path(pts)}
              fill="none"
              stroke={colorOf(sym)}
              strokeWidth={highlight === sym ? 2.6 : 1.3}
              opacity={dim ? 0.12 : 0.85}
              onClick={() => onHighlight?.(highlight === sym ? null : sym)}
              style={{ cursor: 'pointer' }}
            />
          );
        })}

        {showBench && bench.length > 1 && <path d={path(bench)} fill="none" stroke="#ffffff" strokeWidth="2.4" strokeDasharray="2 3" />}
        {showBench && ema.length > 1 && <path d={path(ema)} fill="none" stroke="#f59e0b" strokeWidth="2" />}

        {endLabels.map((sym) => {
          const pts = curves[sym];
          const p = pts[pts.length - 1];
          return (
            <text key={`l${sym}`} x={geo.sx(p.x) + 4} y={geo.sy(p.v) + 4} fill={colorOf(sym)} className="endlabel">
              {sym.replace('USDT', '')}
            </text>
          );
        })}

        {hoverX != null && <line x1={geo.sx(hoverX)} x2={geo.sx(hoverX)} y1={PAD.t} y2={height - PAD.b} className="crosshair" />}
      </svg>

      {hoverX != null && hoverRows.length > 0 && (
        <div className="tooltip" style={{ left: Math.min(geo.sx(hoverX) + 12, width - 210) }}>
          <div className="tt-head">{new Date(hoverX).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
          {benchAtHover != null && <div className="tt-row"><span>Benchmark</span><b>{fmtPts(benchAtHover)}</b></div>}
          {hoverRows.slice(0, 10).map((r) => (
            <div key={r.s} className="tt-row">
              <span style={{ color: colorOf(r.s) }}>{r.s.replace('USDT', '')}</span>
              <b className={r.v >= 0 ? 'pos' : 'neg'}>{fmtPts(r.v)}</b>
            </div>
          ))}
          {hoverRows.length > 10 && <div className="tt-more">+{hoverRows.length - 10} autres</div>}
        </div>
      )}
    </div>
  );
}
