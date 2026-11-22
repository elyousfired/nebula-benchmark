#!/usr/bin/env node
// Momentum inside the Top 50: do strong tokens keep rising the next 24-48h?
//   node backtest/momentum.js [--universe 150] [--days 365]
// Every day at 00:00 UTC the Top 50 (30D score) is rebuilt with the site's own
// code (computeTokenMetrics + scoreUniverse + topList) from candles closed at
// that moment, then each group is compared with the universe on the same day.
// Approximation: 1H candles stand in for 15m (m15/h1/h4/d1 perfs), universe =
// today's top turnover pairs (not the 500 the site scans).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTickers, pool } from '../src/lib/bybit.js';
import { HOUR, DAY } from '../src/core/bars.js';
import { selectUniverse } from '../src/core/universe.js';
import { computeTokenMetrics } from '../src/core/metrics.js';
import { scoreUniverse, topList } from '../src/core/scoring.js';
import { range } from './data.js';
import { idxAt, closeAt, exitTargetOrTime } from './squeezeSim.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const UNIVERSE = arg('universe', 150);
const DAYS = arg('days', 365);

const pct = (x, d = 1) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const median = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const mean = (a) => { const s = a.filter((x) => x != null); return s.length ? s.reduce((p, x) => p + x, 0) / s.length : null; };

/** Bars with t in [from, to) (index range copy). */
function slice(b, lo, hi) {
  return { t: b.t.slice(lo, hi), o: b.o.slice(lo, hi), h: b.h.slice(lo, hi), l: b.l.slice(lo, hi), c: b.c.slice(lo, hi), v: b.v.slice(lo, hi), q: b.q.slice(lo, hi) };
}

async function main() {
  const now = Date.now();
  const testFrom = now - DAYS * DAY;
  const universe = selectUniverse(await fetchTickers(), { limit: UNIVERSE }).map((t) => t.symbol);
  console.log(`Univers ${universe.length} paires · ${DAYS} jours · chargement (cache)…`);
  const data = {};
  await pool(universe, async (s) => { data[s] = await range(s, '60', testFrom - 8 * DAY); }, { concurrency: 5 });

  const rows = [];
  const start = Math.ceil((testFrom + 42 * DAY) / DAY) * DAY; // 41 days of 1H history for 30D perf + EMAs
  for (let t = start; t + 2 * DAY <= now; t += DAY) {
    const metrics = [];
    const ctx = {};
    for (const s of universe) {
      const b = data[s];
      if (!b) continue;
      const k = idxAt(b.t, t - HOUR); // last 1H closed at t
      if (k < 200 || b.t[k] + HOUR !== t) continue;
      const bars60 = slice(b, Math.max(0, k - 999), k + 1);
      const bars15 = slice(b, Math.max(0, k - 99), k + 1);
      const m = computeTokenMetrics({ symbol: s, bars15, bars60, ticker: null, now: t });
      if (!m) continue;
      metrics.push(m);
      const entry = b.c[k];
      let max24 = -Infinity;
      for (let i = k + 1; i < b.t.length && b.t[i] < t + DAY; i++) max24 = Math.max(max24, b.h[i] / entry - 1);
      ctx[s] = { r1d: closeAt(b, t + DAY) / entry - 1, r2d: closeAt(b, t + 2 * DAY) / entry - 1, max24, tp: exitTargetOrTime(b, k, entry, { target: 0.10, hours: 48 }) };
    }
    if (metrics.length < 80) continue;
    const scored = scoreUniverse(metrics);
    const top = topList(scored, 'month', 50, 'score');
    const m1 = median(Object.values(ctx).map((c) => c.r1d));
    const inTop = new Set(top.map((x) => x.symbol));
    for (const x of scored) {
      const c = ctx[x.symbol];
      const r = top.find((y) => y.symbol === x.symbol);
      rows.push({ t, symbol: x.symbol, top: inTop.has(x.symbol), rank: r?.rank ?? null, phase: x.phase, w1: x.perf.w1, ...c, ex1d: c.r1d - m1 });
    }
  }

  const T = rows.filter((r) => r.top);
  const line = (a, label) => `  ${label.padEnd(28)} ${String(a.length).padStart(6)} ${pct(median(a.map((r) => r.r1d))).padStart(7)} ${pct(mean(a.map((r) => r.r1d)), 2).padStart(8)} ${pct(median(a.map((r) => r.ex1d))).padStart(9)} ${`${Math.round((a.filter((r) => r.r1d > 0.05).length / Math.max(1, a.length)) * 100)}%`.padStart(6)} ${pct(median(a.map((r) => r.max24))).padStart(8)} ${pct(median(a.map((r) => r.r2d))).padStart(7)} ${pct(mean(a.map((r) => r.tp?.ret)), 2).padStart(9)}`;
  const days = new Set(rows.map((r) => r.t)).size;
  const head = `  ${'groupe'.padEnd(28)} ${'N'.padStart(6)} ${'méd 24h'.padStart(7)} ${'moy 24h'.padStart(8)} ${'vs marché'.padStart(9)} ${'>+5%'.padStart(6)} ${'max 24h'.padStart(8)} ${'méd 48h'.padStart(7)} ${'+10%/48h'.padStart(9)}`;
  const w1q = (lo, hi) => T.filter((r) => r.w1 != null && r.w1 >= lo && r.w1 < hi);
  const halves = [T.filter((r) => r.t < start + (now - start) / 2), T.filter((r) => r.t >= start + (now - start) / 2)];
  const strong = (r) => r.rank <= 10 && r.w1 >= 10 && r.phase === 'EXPANSION';
  const lines = [
    `MOMENTUM TOP 50 — ${new Date(start).toISOString().slice(0, 10)} → ${new Date(now).toISOString().slice(0, 10)} · ${days} jours · univers ${universe.length}`,
    'Photo chaque jour à 00:00 UTC, Top 50 score 30D reconstruit avec le code du site. Entrée au close 1H de 00:00.',
    '"vs marché" = 24h du token moins la médiane 24h de tout l\'univers le même jour. "+10%/48h" = sortie +10% sinon close 48h, net de frais.',
    '',
    head,
    line(rows, 'Univers entier'),
    line(rows.filter((r) => !r.top), 'Hors Top 50'),
    line(T, 'Top 50'),
    '',
    '  Par rang:',
    line(T.filter((r) => r.rank <= 10), 'rang 1-10'),
    line(T.filter((r) => r.rank > 10 && r.rank <= 25), 'rang 11-25'),
    line(T.filter((r) => r.rank > 25), 'rang 26-50'),
    '',
    '  Par phase (Top 50):',
    ...['EXPANSION', 'PULLBACK', 'ACCUMULATION', 'CORRECTION', 'CLIMAX'].map((p) => line(T.filter((r) => r.phase === p), p)),
    '',
    '  Par perf 7J (Top 50):',
    line(w1q(20, Infinity), '7J >= +20%'),
    line(w1q(10, 20), '7J +10% à +20%'),
    line(w1q(0, 10), '7J 0 à +10%'),
    line(w1q(-Infinity, 0), '7J < 0'),
    '',
    '  Combinaison (d\'après le 22/11):',
    line(T.filter(strong), 'rang<=10 + 7J>=10% + EXPANSION'),
    line(T.filter((r) => r.w1 >= 10 && r.phase === 'EXPANSION'), '7J>=10% + EXPANSION'),
    line(halves[0].filter((r) => r.w1 >= 10 && r.phase === 'EXPANSION'), '  … 1re moitié'),
    line(halves[1].filter((r) => r.w1 >= 10 && r.phase === 'EXPANSION'), '  … 2e moitié'),
    '',
    'Limites: univers = paires listées aujourd\'hui (délistés absents → biais favorable); 1H au lieu de 15m pour les perfs courtes;',
    'univers de 150 paires au lieu de 500 (les percentiles du score changent); pas de slippage.',
  ];
  const txt = lines.join('\n');
  console.log(`\n${txt}`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'momentum-summary.txt'), `${txt}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
