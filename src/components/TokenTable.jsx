import { useMemo, useState } from 'react';
import { colorOf, fmtPct, fmtPrice, fmtUsd, pctClass, PHASES } from '../lib/format.js';

const COLS = [
  { key: 'rank', label: '#', get: (t) => t.rank },
  { key: 'base', label: 'Token', get: (t) => t.base, text: true },
  { key: 'price', label: 'Prix', get: (t) => t.price },
  { key: 'm15', label: '15m', get: (t) => t.perf.m15, pct: true },
  { key: 'h1', label: '1h', get: (t) => t.perf.h1, pct: true },
  { key: 'h4', label: '4h', get: (t) => t.perf.h4, pct: true },
  { key: 'd1', label: '24h', get: (t) => t.perf.d1, pct: true },
  { key: 'w1', label: '7j', get: (t) => t.perf.w1, pct: true },
  { key: 'd30', label: '30j', get: (t) => t.perf.d30, pct: true },
  { key: 'score', label: 'Score', get: (t, h) => t.scores[h] },
  { key: 'conf', label: 'Confl.', get: (t, h) => t.confluence[h] },
  { key: 'phase', label: 'Phase 4H', get: (t) => t.phase, text: true },
  { key: 'dist', label: 'EMA20 4H', get: (t) => t.distEma20, pct: true },
  { key: 'pull', label: 'vs ATH 30j', get: (t) => t.pullbackFromHigh, pct: true },
  { key: 'peak', label: 'Pic 30j', get: (t) => t.maxPointsMonth, pct: true },
  { key: 'vol', label: 'Vol 24h', get: (t) => t.turnover24h },
  { key: 'volmc', label: 'Vol/MC', get: (t) => t.volMcap },
  { key: 'buy', label: 'Achat est.', get: (t) => t.buyPctEst },
];

export function TokenTable({ list, horizon, highlight, onHighlight, caps }) {
  const [sort, setSort] = useState({ key: 'rank', dir: 1 });
  const [q, setQ] = useState('');

  const rows = useMemo(() => {
    const withCaps = list.map((t) => {
      const mc = caps[t.base]?.marketCap;
      return { ...t, volMcap: mc > 0 ? (t.turnover24h / mc) * 100 : null };
    });
    const col = COLS.find((c) => c.key === sort.key);
    const filtered = q ? withCaps.filter((t) => t.base.includes(q.toUpperCase())) : withCaps;
    return [...filtered].sort((a, b) => {
      const va = col.get(a, horizon);
      const vb = col.get(b, horizon);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (col.text) return String(va).localeCompare(String(vb)) * sort.dir;
      return (va - vb) * sort.dir;
    });
  }, [list, caps, sort, q, horizon]);

  const clickSort = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: key === 'rank' || key === 'base' ? 1 : -1 }));

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">📋 CLASSEMENT ({list.length})</div>
        <input className="search" placeholder="Rechercher un token…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {COLS.map((c) => (
                <th key={c.key} onClick={() => clickSort(c.key)} className={sort.key === c.key ? 'sorted' : ''}>
                  {c.label}{sort.key === c.key ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const ph = PHASES[t.phase];
              return (
                <tr key={t.symbol} className={highlight === t.symbol ? 'hl' : ''} onClick={() => onHighlight(highlight === t.symbol ? null : t.symbol)}>
                  <td className="muted">{t.rank}</td>
                  <td>
                    <span className="dot" style={{ background: colorOf(t.symbol) }} />
                    <b>{t.base}</b>
                    {t.stale && <span className="tag LOSS" title="Bougies en retard">STALE</span>}
                  </td>
                  <td>{fmtPrice(t.price)}</td>
                  {['m15', 'h1', 'h4', 'd1', 'w1', 'd30'].map((k) => <td key={k} className={pctClass(t.perf[k])}>{fmtPct(t.perf[k])}</td>)}
                  <td><b className="score">{t.scores[horizon] == null ? '—' : t.scores[horizon].toFixed(1)}</b></td>
                  <td className="muted">{Math.round(t.confluence[horizon] * 100)}%</td>
                  <td><span className="phase" style={{ color: ph.color, borderColor: ph.color }} title={ph.desc}>{ph.label}</span></td>
                  <td className={pctClass(t.distEma20)}>{fmtPct(t.distEma20, 1)}</td>
                  <td className={pctClass(t.pullbackFromHigh)}>{fmtPct(t.pullbackFromHigh, 1)}</td>
                  <td className={pctClass(t.maxPointsMonth)}>{fmtPct(t.maxPointsMonth, 1)}</td>
                  <td>{fmtUsd(t.turnover24h)}</td>
                  <td>{t.volMcap == null ? '—' : `${t.volMcap.toFixed(1)}%`}</td>
                  <td className={t.buyPctEst >= 50 ? 'pos' : 'neg'}>{t.buyPctEst == null ? '—' : `${t.buyPctEst.toFixed(0)}%`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="muted small">
        Score 0–100 = rang percentile pondéré des performances × (0.5 + 0.5 × confluence). « Achat est. » est estimé à partir de la forme des bougies 15m.
      </div>
    </div>
  );
}
