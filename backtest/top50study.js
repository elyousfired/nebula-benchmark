#!/usr/bin/env node
// What did the Top 50 tokens that rose look like BEFORE they rose?
//   node backtest/top50study.js [--days 90] [--universe 300] [--step 4] [--win 0.10]
// Every `step` hours the Top 50 (30D score) is rebuilt with the site's code from
// candles closed at that moment. Each member gets features known at that time;
// the outcome is its next-24h return. For every feature, members are split in
// quintiles and we compare how often each quintile rose >= `win` in 24h.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTickers, pool } from '../src/lib/bybit.js';
import { HOUR, DAY } from '../src/core/bars.js';
import { selectUniverse } from '../src/core/universe.js';
import { computeTokenMetrics } from '../src/core/metrics.js';
import { scoreUniverse, topList } from '../src/core/scoring.js';
import { rngSeries, boxAt, quietPctAt } from '../src/core/squeeze.js';
import { range } from './data.js';
import { idxAt, closeAt } from './squeezeSim.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const DAYS = arg('days', 90);
const UNIVERSE = arg('universe', 300);
const STEP = arg('step', 4);
const WIN = arg('win', 0.10);

const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const median = (a) => { const s = a.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const slice = (b, lo, hi) => ({ t: b.t.slice(lo, hi), o: b.o.slice(lo, hi), h: b.h.slice(lo, hi), l: b.l.slice(lo, hi), c: b.c.slice(lo, hi), v: b.v.slice(lo, hi), q: b.q.slice(lo, hi) });

const FEATURES = {
  rank: 'Rang dans le Top 50',
  rankChange24h: 'Gain de rang en 24h (+ = monte)',
  daysInTop7: 'Jours dans le Top 50 (7 derniers)',
  score: 'Score 30D',
  h1: 'Perf 1h', h4: 'Perf 4h', d1: 'Perf 24h', w1: 'Perf 7J', d30: 'Perf 30J',
  pullbackFromHigh: 'Écart au plus haut 30J', fromLow30: 'Écart au plus bas 30J',
  distEma20: 'Écart EMA20 4H', slopeEma20: 'Pente EMA20 4H',
  vol24_7d: 'Volume 24h / moy 7J', turnover: 'Turnover 24h ($)',
  buyPct: 'Achat estimé 24h (%)', volat3d: 'Volatilité 1H 3J',
  quiet: 'Quiet % (box 14J)', distCeil14: 'Écart au plafond 14J',
};

async function main() {
  const now = Date.now();
  const start = Math.ceil((now - DAYS * DAY) / (STEP * HOUR)) * STEP * HOUR;
  const universe = selectUniverse(await fetchTickers(), { limit: UNIVERSE }).map((t) => t.symbol);
  console.log(`Univers ${universe.length} paires · ${DAYS} jours · photo toutes les ${STEP}h · chargement…`);
  const data = {};
  let n = 0;
  await pool(universe, async (s) => {
    const [b1, b4] = await Promise.all([range(s, '60', start - 45 * DAY), range(s, '240', start - 140 * DAY)]);
    data[s] = { b1, b4, rng: rngSeries(b4) };
    if (++n % 50 === 0) console.log(`  ${n}/${universe.length}`);
  }, { concurrency: 5 });

  const samples = [];
  const rankHist = new Map(); // symbol -> [{t, rank}]
  for (let t = start; t + DAY <= now - HOUR; t += STEP * HOUR) {
    const metrics = [];
    const extra = {};
    for (const s of universe) {
      const { b1, b4, rng } = data[s];
      const k = idxAt(b1.t, t - HOUR);
      if (k < 720 || b1.t[k] + HOUR !== t) continue;
      const m = computeTokenMetrics({ symbol: s, bars15: slice(b1, k - 99, k + 1), bars60: slice(b1, Math.max(0, k - 999), k + 1), ticker: null, now: t });
      if (!m) continue;
      metrics.push(m);
      let q24 = 0; let q7 = 0; let ss = 0;
      for (let i = k - 167; i <= k; i++) { q7 += b1.q[i]; if (i > k - 24) q24 += b1.q[i]; }
      for (let i = k - 71; i <= k; i++) { const r = Math.log(b1.c[i] / b1.c[i - 1]); ss += r * r; }
      const j = idxAt(b4.t, t);
      const box = j >= 0 ? boxAt(b4, j) : null;
      const r24 = closeAt(b1, t + DAY);
      extra[s] = {
        vol24_7d: q7 > 0 ? q24 / (q7 / 7) : null, turnover: q24, volat3d: Math.sqrt(ss / 72),
        quiet: j >= 0 ? quietPctAt(rng, j) : null, distCeil14: box ? b1.c[k] / box.high - 1 : null,
        r24h: r24 ? r24 / b1.c[k] - 1 : null,
      };
    }
    if (metrics.length < 150) continue;
    const top = topList(scoreUniverse(metrics), 'month', 50, 'score');
    const mkt = median(Object.values(extra).map((e) => e.r24h));
    for (const x of top) {
      const e = extra[x.symbol];
      const hist = rankHist.get(x.symbol) || [];
      const prev = hist.filter((h) => h.t === t - DAY)[0];
      const daysInTop7 = new Set(hist.filter((h) => h.t >= t - 7 * DAY && h.t < t).map((h) => Math.floor(h.t / DAY))).size;
      samples.push({
        t, symbol: x.symbol, phase: x.phase, rank: x.rank, score: x.scores.month,
        rankChange24h: prev ? prev.rank - x.rank : 51 - x.rank, daysInTop7,
        h1: x.perf.h1, h4: x.perf.h4, d1: x.perf.d1, w1: x.perf.w1, d30: x.perf.d30,
        pullbackFromHigh: x.pullbackFromHigh, fromLow30: x.low30d ? (x.price / x.low30d - 1) * 100 : null,
        distEma20: x.distEma20, slopeEma20: x.slopeEma20, buyPct: x.buyPctEst, ...e, ex24h: e.r24h != null && mkt != null ? e.r24h - mkt : null,
      });
    }
    for (const x of top) { if (!rankHist.has(x.symbol)) rankHist.set(x.symbol, []); rankHist.get(x.symbol).push({ t, rank: x.rank }); }
  }

  const S = samples.filter((s) => s.r24h != null);
  const base = S.filter((s) => s.r24h >= WIN).length / S.length;
  const mid = start + (now - start) / 2;
  const rate = (a) => (a.length ? a.filter((s) => s.r24h >= WIN).length / a.length : null);
  const res = [];
  for (const [f, label] of Object.entries(FEATURES)) {
    const a = S.filter((s) => s[f] != null && Number.isFinite(s[f])).sort((x, y) => x[f] - y[f]);
    if (a.length < 500) continue;
    const qs = [0, 1, 2, 3, 4].map((q) => a.slice(Math.floor((a.length * q) / 5), Math.floor((a.length * (q + 1)) / 5)));
    const r = qs.map(rate);
    res.push({
      f, label, qs, r,
      cut: qs.map((q) => q[q.length - 1][f]),
      med: qs.map((q) => median(q.map((s) => s.ex24h))),
      h1: qs.map((q) => rate(q.filter((s) => s.t < mid))), h2: qs.map((q) => rate(q.filter((s) => s.t >= mid))),
      spread: Math.max(...r) / Math.max(1e-9, Math.min(...r)),
    });
  }
  res.sort((a, b) => b.spread - a.spread);

  const fmtCut = (x, f) => (['turnover'].includes(f) ? `${(x / 1e6).toFixed(2)}M` : Math.abs(x) < 1 && f !== 'rank' ? x.toFixed(3) : x.toFixed(1));
  const days = new Set(S.map((s) => Math.floor(s.t / DAY))).size;
  const lines = [
    `TOP 50 — ce qui distingue ceux qui montent · ${new Date(start).toISOString().slice(0, 10)} → ${new Date(now).toISOString().slice(0, 10)} (${days} j) · univers ${universe.length} · photo /${STEP}h`,
    `${S.length} observations Top 50 · "monte" = close +24h >= ${pct(WIN, 0)} · taux de base ${pct(base)} (${S.filter((s) => s.r24h >= WIN).length} cas)`,
    'Chaque variable: 5 groupes égaux (Q1 = plus petites valeurs … Q5 = plus grandes). Taux = part qui a monté >= seuil en 24h.',
    '"méd vs marché" = médiane du 24h du groupe moins la médiane du marché au même moment. "1re/2e moitié" = taux sur chaque moitié de la période (stabilité).',
    '',
  ];
  for (const x of res) {
    lines.push(`${x.label}  (écart max/min ×${x.spread.toFixed(1)})`);
    lines.push(`  ${'groupe'.padEnd(5)} ${'jusqu\'à'.padStart(10)} ${'taux'.padStart(7)} ${'méd vs marché'.padStart(14)} ${'1re moitié'.padStart(11)} ${'2e moitié'.padStart(10)}`);
    x.qs.forEach((q, i) => lines.push(`  Q${i + 1}    ${fmtCut(x.cut[i], x.f).padStart(10)} ${pct(x.r[i]).padStart(7)} ${pct(x.med[i], 2).padStart(14)} ${pct(x.h1[i]).padStart(11)} ${pct(x.h2[i]).padStart(10)}`));
    lines.push('');
  }
  lines.push('Phase:');
  for (const p of ['EXPANSION', 'PULLBACK', 'ACCUMULATION', 'CORRECTION', 'CLIMAX']) {
    const a = S.filter((s) => s.phase === p);
    if (a.length) lines.push(`  ${p.padEnd(13)} n ${String(a.length).padStart(5)}  taux ${pct(rate(a)).padStart(6)}  méd vs marché ${pct(median(a.map((s) => s.ex24h)), 2).padStart(7)}  1re ${pct(rate(a.filter((s) => s.t < mid))).padStart(6)}  2e ${pct(rate(a.filter((s) => s.t >= mid))).padStart(6)}`);
  }
  lines.push('', 'Limites: observations toutes les 4h qui se chevauchent (pas indépendantes); univers = paires listées aujourd\'hui; 1H au lieu de 15m pour 15m/1h/4h/24h.');
  const txt = lines.join('\n');
  console.log(`\n${txt}`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'top50study-summary.txt'), `${txt}\n`);
  fs.writeFileSync(path.join(OUT, 'top50study-samples.json'), JSON.stringify(S));
}

main().catch((e) => { console.error(e); process.exit(1); });
