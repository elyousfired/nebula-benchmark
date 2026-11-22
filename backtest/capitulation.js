#!/usr/bin/env node
// Backtest: buy near the 30-day low after a big drop, with / without rising volume.
//   node backtest/capitulation.js [--universe 150] [--days 365]
// Uses the shared 1H cache (backtest/data.js). Writes backtest/results/capitulation-summary.txt.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTickers, pool } from '../src/lib/bybit.js';
import { HOUR, DAY } from '../src/core/bars.js';
import { selectUniverse } from '../src/core/universe.js';
import { range } from './data.js';
import { closeAt, regimeAt } from './squeezeSim.js';
import { capitulationSignals } from './capitulationSim.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const UNIVERSE = arg('universe', 150);
const DAYS = arg('days', 365);

const pct = (x, d = 1) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const median = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const mean = (a) => { const s = a.filter((x) => x != null); return s.length ? s.reduce((p, x) => p + x, 0) / s.length : null; };
const share = (a, fn) => `${a.length ? Math.round((a.filter(fn).length / a.length) * 100) : 0}%`;

const VARIANTS = [
  { name: 'A  proche du bas 30J + chute >= 25%', nearLow: 0.05, drop: 0.25, minVol: 0 },
  { name: 'B  A + volume 24h/7J >= 1.3', nearLow: 0.05, drop: 0.25, minVol: 1.3 },
  { name: 'C  A + volume 24h/7J >= 2', nearLow: 0.05, drop: 0.25, minVol: 2 },
  { name: 'D  chute >= 40% + volume >= 1.3', nearLow: 0.05, drop: 0.40, minVol: 1.3 },
];

async function main() {
  const now = Date.now();
  const testFrom = now - DAYS * DAY;
  const universe = selectUniverse(await fetchTickers(), { limit: UNIVERSE }).map((t) => t.symbol);
  console.log(`Univers ${universe.length} paires · ${DAYS} jours · chargement (cache)…`);
  const data = {};
  await pool(universe, async (s) => { data[s] = await range(s, '60', testFrom - 32 * DAY); }, { concurrency: 5 });
  const btcDaily = await range('BTCUSDT', 'D', testFrom - 120 * DAY);
  const from = testFrom; // 30-day lookback comes from the extra 32 days loaded

  const benchCache = new Map();
  const bench = (t, h) => {
    const key = `${t}:${h}`;
    if (benchCache.has(key)) return benchCache.get(key);
    const rs = [];
    for (const s of universe) {
      const b = data[s];
      if (!b || b.t[b.t.length - 1] + HOUR < t + h * HOUR) continue;
      const a = closeAt(b, t); const z = closeAt(b, t + h * HOUR);
      if (a && z) rs.push(z / a - 1);
    }
    const m = rs.length >= 20 ? median(rs) : null;
    benchCache.set(key, m);
    return m;
  };

  const head = `  ${'variante'.padEnd(38)} ${'N'.padStart(5)} ${'méd 24h'.padStart(7)} ${'méd 3J'.padStart(7)} ${'méd 7J'.padStart(7)} ${'7J>0'.padStart(5)} ${'vs marché 7J'.padStart(12)} ${'max 7J'.padStart(7)} ${'min 7J'.padStart(7)} ${'+10%/48h'.padStart(9)} ${'TP'.padStart(4)}`;
  const lines = [
    `CAPITULATION — backtest ${new Date(testFrom).toISOString().slice(0, 10)} → ${new Date(now).toISOString().slice(0, 10)} · ${universe.length} paires`,
    'Signal au close 1H: prix <= bas 30J +5% ET prix <= haut 30J -X% (+ règle volume selon la variante). 1 signal / token / 3 jours.',
    '"vs marché 7J" = perf 7J du signal moins la médiane 7J de tout l\'univers au même moment. "+10%/48h" = sortie +10% sinon close 48h, net de frais.',
    '',
    head,
  ];
  const detail = [];
  for (const v of VARIANTS) {
    const sigs = [];
    for (const s of universe) if (data[s]) for (const g of capitulationSignals(data[s], { from, ...v })) sigs.push({ symbol: s, ...g });
    for (const g of sigs) { const b = bench(g.t, 168); g.ex7d = g.r7d != null && b != null ? g.r7d - b : null; g.regime = regimeAt(btcDaily, g.t); }
    sigs.sort((a, b) => a.t - b.t);
    const row = (a, label) => `  ${label.padEnd(38)} ${String(a.length).padStart(5)} ${pct(median(a.map((x) => x.r24h))).padStart(7)} ${pct(median(a.map((x) => x.r3d))).padStart(7)} ${pct(median(a.map((x) => x.r7d))).padStart(7)} ${share(a.filter((x) => x.r7d != null), (x) => x.r7d > 0).padStart(5)} ${pct(median(a.map((x) => x.ex7d))).padStart(12)} ${pct(median(a.map((x) => x.max7d))).padStart(7)} ${pct(median(a.map((x) => x.min7d))).padStart(7)} ${pct(mean(a.map((x) => x.tp?.ret)), 2).padStart(9)} ${share(a.filter((x) => x.tp), (x) => x.tp.outcome === 'TP').padStart(4)}`;
    lines.push(row(sigs, v.name));
    detail.push('', `  ${v.name}`);
    for (let q = 0; q < 4; q++) detail.push(row(sigs.slice(Math.floor((sigs.length * q) / 4), Math.floor((sigs.length * (q + 1)) / 4)), `    trimestre ${q + 1} (${sigs[Math.floor((sigs.length * q) / 4)] ? new Date(sigs[Math.floor((sigs.length * q) / 4)].t).toISOString().slice(0, 7) : '—'})`));
    for (const r of ['bull', 'chop', 'bear']) detail.push(row(sigs.filter((x) => x.regime === r), `    BTC ${r}`));
  }
  lines.push('', 'Détail par trimestre et régime BTC:', head, ...detail, '',
    'Limites: univers = paires listées aujourd\'hui (délistés absents → biais favorable, fort ici car on achète des tokens qui chutent);',
    'entrée au close exact, pas de slippage; signaux souvent groupés les mêmes jours (pas indépendants).');
  const txt = lines.join('\n');
  console.log(`\n${txt}`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'capitulation-summary.txt'), `${txt}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
