#!/usr/bin/env node
// Strategies on the Top 50 (30D score), measured in R, chosen in-sample and
// checked out-of-sample.
//   node backtest/top50strat.js [--days 365] [--universe 300] [--step 4] [--oos 120]
// Every `step` hours the Top 50 is rebuilt with the site's code. Each family of
// entries is combined with each exit; one open trade per symbol and per
// strategy. The first (days - oos) days pick the best combos; the last `oos`
// days are never used for choosing and show whether they hold up.

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
import { idxAt } from './squeezeSim.js';
import { atrAt, simulateR, rStats } from './rr.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const DAYS = arg('days', 365);
const UNIVERSE = arg('universe', 300);
const STEP = arg('step', 4);
const OOS = arg('oos', 120);
const slice = (b, lo, hi) => ({ t: b.t.slice(lo, hi), o: b.o.slice(lo, hi), h: b.h.slice(lo, hi), l: b.l.slice(lo, hi), c: b.c.slice(lo, hi), v: b.v.slice(lo, hi), q: b.q.slice(lo, hi) });

// Entry families (x = Top 50 member at the snapshot, e = extra features).
export const FAMILIES = {
  'Tout le Top 50 (témoin)': () => true,
  'Pullback en tendance (PULLBACK, pente EMA>0, rang<=25)': (x) => x.phase === 'PULLBACK' && x.slopeEma20 > 0 && x.rank <= 25,
  'Retour sur EMA20 (|écart|<=1.5%, 7J>=10%)': (x) => x.distEma20 != null && Math.abs(x.distEma20) <= 1.5 && x.perf.w1 >= 10,
  'Expansion rang<=10': (x) => x.phase === 'EXPANSION' && x.rank <= 10,
  'Squeeze breakout (quiet<=10, close>plafond)': (x, e) => e.quiet != null && e.quiet <= 10 && e.close > e.ceil,
  'Nouvel entrant Top 50': (x, e) => e.newEntry,
  'Accumulation calme (ACCUM., volat basse)': (x, e) => x.phase === 'ACCUMULATION' && e.volatPct <= 0.4,
  'Cassure plus haut 30J (prix>=haut 30J)': (x) => x.pullbackFromHigh != null && x.pullbackFromHigh >= -0.5,
};

// Exits: stop = entry - k * ATR(4H); target = entry + m * R (null = none); max hold.
export const EXITS = {
  'SL 1.5ATR · TP 2R · 3J': { k: 1.5, m: 2, maxH: 72 },
  'SL 1.5ATR · TP 3R · 7J': { k: 1.5, m: 3, maxH: 168 },
  'SL 2ATR · TP 2R · 3J': { k: 2, m: 2, maxH: 72 },
  'SL 1ATR · TP 3R · 3J': { k: 1, m: 3, maxH: 72 },
  'SL 2ATR · sans TP · 7J': { k: 2, m: null, maxH: 168 },
};

async function main() {
  const now = Date.now();
  const start = Math.ceil((now - DAYS * DAY) / (STEP * HOUR)) * STEP * HOUR;
  const split = now - OOS * DAY;
  const universe = selectUniverse(await fetchTickers(), { limit: UNIVERSE }).map((t) => t.symbol);
  console.log(`Univers ${universe.length} · ${DAYS} j (dont ${OOS} j hors échantillon) · photo /${STEP}h · chargement…`);
  const data = {};
  let n = 0;
  await pool(universe, async (s) => {
    const [b1, b4] = await Promise.all([range(s, '60', start - 45 * DAY), range(s, '240', start - 140 * DAY)]);
    data[s] = { b1, b4, rng: rngSeries(b4) };
    if (++n % 50 === 0) console.log(`  chargé ${n}/${universe.length}`);
  }, { concurrency: 5 });
  const missing = universe.filter((s) => !data[s]);
  if (missing.length) console.log(`  ${missing.length} paires non chargées (ignorées): ${missing.join(', ')}`);

  const keys = [];
  for (const f of Object.keys(FAMILIES)) for (const x of Object.keys(EXITS)) keys.push(`${f} || ${x}`);
  const trades = Object.fromEntries(keys.map((k) => [k, []]));
  const busyUntil = Object.fromEntries(keys.map((k) => [k, {}]));
  let prevTop = new Set();
  let snaps = 0;
  for (let t = start; t + DAY <= now - HOUR; t += STEP * HOUR) {
    const metrics = [];
    const ctx = {};
    for (const s of universe) {
      if (!data[s]) continue; // failed download
      const { b1, b4, rng } = data[s];
      const k = idxAt(b1.t, t - HOUR);
      if (k < 720 || b1.t[k] + HOUR !== t) continue;
      const m = computeTokenMetrics({ symbol: s, bars15: slice(b1, k - 99, k + 1), bars60: slice(b1, Math.max(0, k - 999), k + 1), ticker: null, now: t });
      if (!m) continue;
      metrics.push(m);
      const j = idxAt(b4.t, t);
      let ss = 0;
      for (let i = k - 71; i <= k; i++) { const r = Math.log(b1.c[i] / b1.c[i - 1]); ss += r * r; }
      const box = j >= 0 ? boxAt(b4, j) : null;
      ctx[s] = { k, close: b1.c[k], atr: j >= 0 ? atrAt(b4, j) : null, quiet: j >= 0 ? quietPctAt(rng, j) : null, ceil: box ? box.high : Infinity, volat: Math.sqrt(ss / 72) };
    }
    if (metrics.length < 150) continue;
    snaps++;
    const top = topList(scoreUniverse(metrics), 'month', 50, 'score');
    const vs = top.map((x) => ctx[x.symbol].volat).sort((a, b) => a - b);
    for (const x of top) {
      const e = ctx[x.symbol];
      e.newEntry = prevTop.size > 0 && !prevTop.has(x.symbol);
      e.volatPct = vs.indexOf(e.volat) / Math.max(1, vs.length - 1);
      if (!(e.atr > 0)) continue;
      for (const [fname, fn] of Object.entries(FAMILIES)) {
        if (!fn(x, e)) continue;
        for (const [xname, ex] of Object.entries(EXITS)) {
          const key = `${fname} || ${xname}`;
          if ((busyUntil[key][x.symbol] || 0) > t) continue;
          const stop = e.close - ex.k * e.atr;
          const target = ex.m == null ? null : e.close + ex.m * (e.close - stop);
          const r = simulateR(data[x.symbol].b1, e.k, { entry: e.close, stop, target, maxH: ex.maxH });
          if (!r) continue;
          trades[key].push({ ...r, t, symbol: x.symbol });
          busyUntil[key][x.symbol] = r.exitT;
        }
      }
    }
    prevTop = new Set(top.map((x) => x.symbol));
  }

  const rows = keys.map((key) => {
    const all = trades[key];
    return { key, is: rStats(all.filter((x) => x.t < split)), oos: rStats(all.filter((x) => x.t >= split)), all: rStats(all) };
  });
  const f2 = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d));
  const p0 = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  const line = (r) => `  ${r.key.padEnd(82)} | IS n ${String(r.is.n).padStart(4)} E ${f2(r.is.expR).padStart(6)}R PF ${f2(r.is.pf).padStart(5)} win ${p0(r.is.win).padStart(4)} | OOS n ${String(r.oos.n).padStart(4)} E ${f2(r.oos.expR).padStart(6)}R PF ${f2(r.oos.pf).padStart(5)} win ${p0(r.oos.win).padStart(4)} DD ${f2(r.oos.maxDD, 1).padStart(6)}R`;
  const eligible = rows.filter((r) => r.is.n >= 100).sort((a, b) => b.is.expR - a.is.expR);
  const lines = [
    `TOP 50 — STRATÉGIES EN R · ${new Date(start).toISOString().slice(0, 10)} → ${new Date(now).toISOString().slice(0, 10)} · univers ${universe.length} · ${snaps} photos /${STEP}h`,
    `IS (choix) = jusqu'au ${new Date(split).toISOString().slice(0, 10)} · OOS (contrôle, jamais utilisé pour choisir) = ${OOS} derniers jours.`,
    'R = distance entrée → stop. E = espérance par trade en R (net de frais 0,1%/côté). PF = gains / pertes. DD = pire recul cumulé en R (OOS).',
    'Stop = entrée − k × ATR14 (4H); objectif = entrée + m × R; sortie au temps sinon. Même bougie stop+objectif → stop.',
    '',
    'Classement sur IS (min 100 trades), avec le résultat OOS à côté:',
    ...eligible.map(line),
    '',
    `Top 5 IS → OOS: ${eligible.slice(0, 5).map((r) => `${f2(r.is.expR)}R → ${f2(r.oos.expR)}R`).join(' · ')}`,
    '',
    'Limites: univers = paires listées aujourd\'hui (délistés absents); 1H au lieu de 15m pour les perfs courtes; trades simultanés non plafonnés;',
    `${keys.length} combinaisons testées → le meilleur IS est optimiste par construction; seul l'OOS compte.`,
  ];
  const txt = lines.join('\n');
  console.log(`\n${txt}`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'top50strat-summary.txt'), `${txt}\n`);
  fs.writeFileSync(path.join(OUT, 'top50strat-trades.json'), JSON.stringify(trades));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
