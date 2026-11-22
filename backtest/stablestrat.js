#!/usr/bin/env node
// Strategies on the "stable" tokens of the /stable page: tokens that were in the
// slow Top 50 (50% perf 30J + 50% perf 7J) on >= MIN of the last 30 daily closes.
// Daily candles (~2.7 years), entry at the daily close, results in R, chosen on
// the first part (IS) and checked on the last OOS days.
//   node backtest/stablestrat.js [--min 20] [--oos 240]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTickers, pool } from '../src/lib/bybit.js';
import { DAY } from '../src/core/bars.js';
import { selectUniverse } from '../src/core/universe.js';
import { slowTop } from '../src/core/stable.js';
import { range } from './data.js';
import { rStats } from './rr.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const MIN = arg('min', 20);
const OOS = arg('oos', 240);
const FEE = 0.001;

/** Daily long: stop / target on later daily bars (same bar both -> stop), time exit, optional exit signal. */
function sim(b, i, { stop, target, maxD, exitIf }) {
  const e = b.c[i];
  const risk = (e - stop) / e;
  const done = (px, out, j) => { const ret = (px * (1 - FEE)) / (e * (1 + FEE)) - 1; return { R: ret / risk, ret, out, exitT: b.t[j], days: j - i }; };
  for (let j = i + 1; j < b.t.length - 1; j++) {
    if (b.l[j] <= stop) return done(stop, 'SL', j);
    if (target != null && b.h[j] >= target) return done(target, 'TP', j);
    if (exitIf && exitIf(j)) return done(b.c[j], 'OUT', j);
    if (j - i >= maxD) return done(b.c[j], 'TIME', j);
  }
  return null;
}

const ENTRIES = {
  'Témoin : tout token stable, chaque jour': () => true,
  'Devient stable (passe le seuil aujourd\'hui)': (x) => x.newStable,
  'Stable + dans le Top 50 lent aujourd\'hui (rang ≤ 10)': (x) => x.rank != null && x.rank <= 10,
  'Stable + pullback (7J < −10 %, au-dessus SMA50)': (x) => x.w1 < -0.10 && x.aboveSma50,
  'Stable + cassure du plus haut 20 j': (x) => x.breakout20,
  'Stable + cassure 20 j + boîte 20 j étroite (< 40 %)': (x) => x.breakout20 && x.width20 < 0.4,
  'Stable + rebond sur SMA20 (touche puis clôture au-dessus)': (x) => x.sma20Bounce,
};
const EXITS = {
  'SL 2ATR · TP 2R · 10 j': { k: 2, m: 2, maxD: 10 },
  'SL 2ATR · TP 3R · 20 j': { k: 2, m: 3, maxD: 20 },
  'SL 1.5ATR · TP 3R · 10 j': { k: 1.5, m: 3, maxD: 10 },
  'SL 2ATR · sans TP · sort si plus stable · 30 j': { k: 2, m: null, maxD: 30, outWhenUnstable: true },
  'SL 3ATR · sans TP · 30 j': { k: 3, m: null, maxD: 30 },
};

async function main() {
  const now = Date.now();
  const universe = selectUniverse(await fetchTickers(), { limit: 500 }).map((t) => t.symbol);
  const data = {};
  await pool(universe, async (s) => { const b = await range(s, 'D', now - 1000 * DAY); if (b.t.length > 120) data[s] = b; }, { concurrency: 5 });
  const syms = Object.keys(data);
  const idx = {}; // symbol -> Map(dayT -> index)
  for (const s of syms) idx[s] = new Map(data[s].t.map((t, i) => [t, i]));
  const days = [...new Set(syms.flatMap((s) => data[s].t))].sort((a, b) => a - b).filter((t) => t + DAY <= now);

  // Slow Top 50 at every daily close.
  const tops = new Map();
  for (const d of days) {
    const rows = [];
    for (const s of syms) { const i = idx[s].get(d); if (i == null || i < 30) continue; const b = data[s]; rows.push({ symbol: s, d30: (b.c[i] / b.c[i - 30] - 1) * 100, w1: (b.c[i] / b.c[i - 7] - 1) * 100 }); }
    if (rows.length >= 100) tops.set(d, new Map(slowTop(rows, 50).map((r) => [r.symbol, r.rank])));
  }
  const topDays = days.filter((d) => tops.has(d));
  const count = (s, k) => { let n = 0; for (let z = k - 29; z <= k; z++) if (z >= 0 && tops.get(topDays[z]).has(s)) n++; return n; };

  const split = now - OOS * DAY;
  const keys = [];
  for (const en of Object.keys(ENTRIES)) for (const ex of Object.keys(EXITS)) keys.push([en, ex]);
  const trades = Object.fromEntries(keys.map(([a, b]) => [`${a} || ${b}`, []]));
  const busy = Object.fromEntries(Object.keys(trades).map((k) => [k, {}]));
  let stableDays = 0;
  for (let k = 29; k < topDays.length; k++) {
    const d = topDays[k];
    for (const s of syms) {
      const n = count(s, k);
      if (n < MIN) continue;
      const b = data[s]; const i = idx[s].get(d);
      if (i == null || i < 60) continue;
      stableDays++;
      let atr = 0; for (let z = i - 13; z <= i; z++) atr += Math.max(b.h[z] - b.l[z], Math.abs(b.h[z] - b.c[z - 1]), Math.abs(b.l[z] - b.c[z - 1])); atr /= 14;
      let hi20 = 0; let lo20 = Infinity; for (let z = i - 20; z < i; z++) { hi20 = Math.max(hi20, b.h[z]); lo20 = Math.min(lo20, b.l[z]); }
      let s20 = 0; let s50 = 0; for (let z = i - 19; z <= i; z++) s20 += b.c[z]; for (let z = i - 49; z <= i; z++) s50 += b.c[z]; s20 /= 20; s50 /= 50;
      const x = {
        rank: tops.get(d).get(s) ?? null, newStable: count(s, k - 1) < MIN, w1: b.c[i] / b.c[i - 7] - 1,
        aboveSma50: b.c[i] > s50, breakout20: b.c[i] > hi20, width20: hi20 / lo20 - 1, sma20Bounce: b.l[i] <= s20 && b.c[i] > s20,
      };
      for (const [en, ex] of keys) {
        const key = `${en} || ${ex}`;
        if (!ENTRIES[en](x) || (busy[key][s] || 0) > d) continue;
        const X = EXITS[ex];
        const stop = b.c[i] - X.k * atr;
        const exitIf = X.outWhenUnstable ? (j) => { const kk = topDays.indexOf(b.t[j]); return kk > 0 && count(s, kk) < MIN; } : null;
        const r = sim(b, i, { stop, target: X.m == null ? null : b.c[i] + X.m * (b.c[i] - stop), maxD: X.maxD, exitIf });
        if (!r) continue;
        trades[key].push({ ...r, t: d, symbol: s });
        busy[key][s] = r.exitT;
      }
    }
  }

  const f2 = (v, dd = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(dd));
  const rows = Object.entries(trades).map(([k, a]) => {
    const is = a.filter((t) => t.t < split); const oos = a.filter((t) => t.t >= split);
    const q = [0, 1, 2, 3].map((z) => { const g = [...a].sort((p, r) => p.t - r.t).slice(Math.floor((a.length * z) / 4), Math.floor((a.length * (z + 1)) / 4)); return g.length ? g.reduce((p, t) => p + t.R, 0) / g.length : null; });
    return { k, is: rStats(is), oos: rStats(oos), q };
  }).filter((r) => r.is.n >= 30).sort((a, b) => b.is.expR - a.is.expR);
  const L = [
    `STRATÉGIES SUR LES TOKENS STABLES (≥ ${MIN}/30 j dans le Top 50 lent) — ${new Date(topDays[29]).toISOString().slice(0, 10)} → ${new Date(topDays[topDays.length - 1]).toISOString().slice(0, 10)} · ${syms.length} tokens · ${stableDays} jours-tokens stables`,
    `IS = avant le ${new Date(split).toISOString().slice(0, 10)} (choix) · OOS = ${OOS} derniers jours (contrôle). Entrée au close journalier, frais 0,1 %/côté, même bougie stop+objectif → stop.`,
    '',
    ...rows.map((r) => `  ${r.k.padEnd(100)} | IS n ${String(r.is.n).padStart(4)} E ${f2(r.is.expR).padStart(6)}R PF ${f2(r.is.pf).padStart(5)} win ${String(Math.round(r.is.win * 100)).padStart(3)}% | OOS n ${String(r.oos.n).padStart(4)} E ${f2(r.oos.expR).padStart(6)}R PF ${f2(r.oos.pf).padStart(5)} DD ${f2(r.oos.maxDD, 1).padStart(6)} | trimestres ${r.q.map((v) => f2(v)).join(' / ')}`),
    '',
    'Limites: univers = paires listées aujourd\'hui (délistés absents); positions simultanées non plafonnées; 35 combinaisons testées → seul l\'OOS compte.',
  ];
  const txt = L.join('\n');
  console.log(txt);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'stablestrat-summary.txt'), `${txt}\n`);
  fs.writeFileSync(path.join(OUT, 'stablestrat-trades.json'), JSON.stringify(trades));
}

main().catch((e) => { console.error(e); process.exit(1); });
