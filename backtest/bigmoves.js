#!/usr/bin/env node
// What comes before a big rise? Daily candles, ~2.7 years, today's universe.
//   node backtest/bigmoves.js [--up 0.5] [--horizon 21] [--universe 400] [--symbol TAUSDT]
// Every day of every token is one sample: features use only candles closed that
// day; the label is "the high reached +up within the next `horizon` days".
// For each feature we compare the hit rate per group with the base rate (lift),
// and also how often the same group FELL -30% (to spot pure volatility).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTickers, pool } from '../src/lib/bybit.js';
import { DAY } from '../src/core/bars.js';
import { selectUniverse } from '../src/core/universe.js';
import { range } from './data.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const UP = Number(arg('up', 0.5));
const H = Number(arg('horizon', 21));
const DOWN = -0.3;
const UNIVERSE = Number(arg('universe', 400));
const FOCUS = arg('symbol', 'TAUSDT');

/** Features of daily series b at index i (only data up to i). */
export function features(b, i) {
  if (i < 200) return null;
  const c = b.c[i];
  let hi56 = 0; let lo56 = Infinity; let hi120 = 0; let lo120 = Infinity; let hiAll = 0; let iAll = 0;
  for (let k = i - 55; k <= i; k++) { hi56 = Math.max(hi56, b.h[k]); lo56 = Math.min(lo56, b.l[k]); }
  for (let k = i - 119; k <= i; k++) { hi120 = Math.max(hi120, b.h[k]); lo120 = Math.min(lo120, b.l[k]); }
  for (let k = 0; k <= i; k++) if (b.h[k] >= hiAll) { hiAll = b.h[k]; iAll = k; }
  let prevHi56 = 0; for (let k = i - 56; k < i; k++) prevHi56 = Math.max(prevHi56, b.h[k]);
  const lowOf = (a, z) => { let m = Infinity; for (let k = a; k <= z; k++) m = Math.min(m, b.l[k]); return m; };
  const L1 = lowOf(i - 83, i - 56); const L2 = lowOf(i - 55, i - 28); const L3 = lowOf(i - 27, i);
  let sma = 0; for (let k = i - 199; k <= i; k++) sma += b.c[k]; sma /= 200;
  let below = 0; for (let k = i - 90; k < i - 14; k++) { let s = 0; for (let m = k - 199; m <= k; m++) s += b.c[m]; if (b.c[k] < s / 200) below++; }
  let q14 = 0; let q56 = 0; for (let k = i - 13; k <= i; k++) q14 += b.q[k]; for (let k = i - 69; k <= i - 14; k++) q56 += b.q[k];
  let ss = 0; for (let k = i - 29; k <= i; k++) { const r = Math.log(b.c[k] / b.c[k - 1]); ss += r * r; }
  return {
    width56: hi56 / lo56 - 1, // 8-week box width
    pos120: (c - lo120) / Math.max(1e-12, hi120 - lo120), // position in the 4-month range (0 = low, 1 = high)
    ddATH: c / hiAll - 1, // drawdown from the all-time (available) high
    daysSinceATH: i - iAll,
    higherLows: L1 < L2 && L2 < L3 ? 1 : 0, // 3 rising 4-week lows
    breakout56: c > prevHi56 ? 1 : 0, // close above the previous 8-week high
    aboveSma200: c > sma ? 1 : 0,
    reclaim200: c > sma && below >= 45 ? 1 : 0, // back above SMA200 after months below
    volTrend: q56 > 0 ? (q14 / 14) / (q56 / 56) : null, // 2-week vs prior 8-week turnover
    ret30: c / b.c[i - 30] - 1,
    ret7: c / b.c[i - 7] - 1,
    volat30: Math.sqrt(ss / 30),
  };
}

const pc = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`);

async function main() {
  const now = Date.now();
  const universe = selectUniverse(await fetchTickers(), { limit: UNIVERSE }).map((t) => t.symbol);
  if (!universe.includes(FOCUS)) universe.push(FOCUS);
  console.log(`Univers ${universe.length} · bougies journalières ~2,7 ans · chargement…`);
  const data = {};
  await pool(universe, async (s) => { data[s] = await range(s, 'D', now - 1000 * DAY); }, { concurrency: 5 });

  const S = [];
  for (const s of universe) {
    const b = data[s];
    if (!b || b.t.length < 260) continue;
    const n = b.t.length - 1; // last bar = today (open): excluded
    for (let i = 200; i < n - H; i++) {
      const f = features(b, i);
      if (!f) continue;
      let mx = -Infinity; let mn = Infinity;
      for (let k = i + 1; k <= i + H; k++) { mx = Math.max(mx, b.h[k]); mn = Math.min(mn, b.l[k]); }
      S.push({ s, t: b.t[i], ...f, up: mx / b.c[i] - 1 >= UP ? 1 : 0, down: mn / b.c[i] - 1 <= DOWN ? 1 : 0 });
    }
  }
  const base = S.filter((x) => x.up).length / S.length;
  const baseDn = S.filter((x) => x.down).length / S.length;
  const mid = S.map((x) => x.t).sort((a, b) => a - b)[S.length >> 1];
  const L = [];
  L.push(`GRANDES HAUSSES (+${UP * 100}% en ${H} j) — ${S.length} jours-tokens, ${new Set(S.map((x) => x.s)).size} tokens`);
  L.push(`Taux de base : ${pc(base, 2)} des jours sont suivis d'une hausse de +${UP * 100}% en ${H} j · ${pc(baseDn, 2)} d'une baisse de ${DOWN * 100}%.`);
  L.push('Lift = taux du groupe / taux de base. Utile si "hausse" monte nettement PLUS que "baisse" (sinon c\'est juste de la volatilité). 1re/2e moitié = stabilité dans le temps.', '');
  const group = (label, rows) => {
    const u = rows.filter((x) => x.up).length / rows.length; const d = rows.filter((x) => x.down).length / rows.length;
    const h1 = rows.filter((x) => x.t < mid); const h2 = rows.filter((x) => x.t >= mid);
    const r = (a) => (a.length ? a.filter((x) => x.up).length / a.length : null);
    return `  ${label.padEnd(44)} n ${String(rows.length).padStart(6)}  hausse ${pc(u).padStart(6)} (×${(u / base).toFixed(2)})  baisse ${pc(d).padStart(6)} (×${(d / baseDn).toFixed(2)})  1re ${pc(r(h1)).padStart(6)} 2e ${pc(r(h2)).padStart(6)}`;
  };
  const quint = (f, label) => {
    const a = S.filter((x) => x[f] != null && Number.isFinite(x[f])).sort((x, y) => x[f] - y[f]);
    L.push(`${label}`);
    for (let q = 0; q < 5; q++) { const g = a.slice(Math.floor((a.length * q) / 5), Math.floor((a.length * (q + 1)) / 5)); L.push(group(`Q${q + 1} (jusqu'à ${g[g.length - 1][f].toFixed(3)})`, g)); }
    L.push('');
  };
  const bin = (f, label) => { L.push(label); L.push(group('oui', S.filter((x) => x[f] === 1))); L.push(group('non', S.filter((x) => x[f] === 0))); L.push(''); };
  quint('width56', 'Largeur de la boîte 8 semaines (haut/bas − 1)');
  quint('pos120', 'Position dans la plage 4 mois (0 = bas, 1 = haut)');
  quint('ddATH', 'Écart au plus haut historique');
  quint('daysSinceATH', 'Jours depuis le plus haut historique');
  quint('volTrend', 'Volume 2 semaines / 8 semaines d\'avant');
  quint('ret30', 'Perf 30 jours');
  quint('volat30', 'Volatilité journalière 30 jours');
  bin('higherLows', '3 creux de 4 semaines montants (higher lows)');
  bin('breakout56', 'Clôture au-dessus du plus haut des 8 semaines précédentes');
  bin('reclaim200', 'Repasse au-dessus de la SMA200 après des mois en dessous');
  bin('aboveSma200', 'Au-dessus de la SMA200');
  L.push('Combinaisons (forme "TA" : longue base, creux montants, cassure) :');
  const combos = [
    ['cassure 8 sem. + higher lows', (x) => x.breakout56 && x.higherLows],
    ['cassure 8 sem. + reclaim SMA200', (x) => x.breakout56 && x.reclaim200],
    ['cassure 8 sem. + boîte étroite (<60%)', (x) => x.breakout56 && x.width56 < 0.6],
    ['cassure + higher lows + ATH −60% ou pire', (x) => x.breakout56 && x.higherLows && x.ddATH <= -0.6],
    ['cassure + higher lows + volume ×1.5', (x) => x.breakout56 && x.higherLows && x.volTrend >= 1.5],
    ['cassure + reclaim + volume ×1.5', (x) => x.breakout56 && x.reclaim200 && x.volTrend >= 1.5],
  ];
  for (const [label, fn] of combos) L.push(group(label, S.filter(fn)));
  L.push('');

  // The focus token: its big rises and its state just before.
  const fb = data[FOCUS];
  if (fb) {
    L.push(`${FOCUS} — jours où une hausse de +${UP * 100}% en ${H} j a commencé (premier jour de chaque série) et état ce jour-là :`);
    let lastHit = -999;
    const n = fb.t.length - 1;
    for (let i = 200; i < n - H; i++) {
      let mx = -Infinity; for (let k = i + 1; k <= i + H; k++) mx = Math.max(mx, fb.h[k]);
      if (mx / fb.c[i] - 1 < UP) continue;
      if (i - lastHit > 10) {
        const f = features(fb, i);
        L.push(`  ${new Date(fb.t[i]).toISOString().slice(0, 10)}  close ${fb.c[i]}  max ${H}j +${((mx / fb.c[i] - 1) * 100).toFixed(0)}%  | boîte8s ${pc(f.width56, 0)} · pos4m ${f.pos120.toFixed(2)} · ATH ${pc(f.ddATH, 0)} (${f.daysSinceATH} j) · higherLows ${f.higherLows} · cassure8s ${f.breakout56} · reclaim200 ${f.reclaim200} · vol ×${f.volTrend?.toFixed(2)} · 30j ${pc(f.ret30, 0)}`);
      }
      lastHit = i;
    }
    const f = features(fb, n - 1);
    L.push(`  aujourd'hui-1 ${new Date(fb.t[n - 1]).toISOString().slice(0, 10)} | boîte8s ${pc(f.width56, 0)} · pos4m ${f.pos120.toFixed(2)} · ATH ${pc(f.ddATH, 0)} · higherLows ${f.higherLows} · cassure8s ${f.breakout56} · reclaim200 ${f.reclaim200} · vol ×${f.volTrend?.toFixed(2)} · 30j ${pc(f.ret30, 0)}`);
  }
  L.push('', 'Limites: univers = paires listées aujourd\'hui (délistés absents); jours successifs du même token très corrélés (n effectif bien plus petit).');
  const txt = L.join('\n');
  console.log(`\n${txt}`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'bigmoves-summary.txt'), `${txt}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
