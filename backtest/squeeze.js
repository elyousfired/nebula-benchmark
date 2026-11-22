#!/usr/bin/env node
// Squeeze Radar backtest.
//   node backtest/squeeze.js [--universe 150] [--days 365]
// Downloads 4H + 1H Bybit spot candles (cached in backtest/cache/*_4h.json /
// *_1h.json for 12 h), finds every BREAKOUT the live page would have shown,
// and measures what happened next. Writes backtest/results/squeeze-*.{txt,csv}.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bybitGet, fetchTickers, pool } from '../src/lib/bybit.js';
import { parseKlines, HOUR, DAY } from '../src/core/bars.js';
import { selectUniverse } from '../src/core/universe.js';
import { findSignals, closeAt } from './squeezeSim.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, 'cache');
const OUT = path.join(HERE, 'results');
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : def; };
const UNIVERSE = arg('universe', 150);
const DAYS = arg('days', 365);
const WARMUP = 140; // 14d box + 120d history + margin
const IV = { '240': 4 * HOUR, '60': HOUR, D: DAY };

async function range(symbol, interval, fromMs) {
  const file = path.join(CACHE, `${symbol}_${interval === '240' ? '4h' : interval === '60' ? '1h' : 'D'}.json`);
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c.from <= fromMs && Date.now() - c.fetchedAt < 12 * HOUR) return parseKlines(c.rows);
  } catch { /* no cache */ }
  const rows = [];
  let end = Date.now();
  while (end > fromMs) {
    const r = await bybitGet('kline', { category: 'spot', symbol, interval, limit: '1000', end: String(end) });
    const list = r.list || [];
    if (!list.length) break;
    rows.push(...list);
    const oldest = Number(list[list.length - 1][0]);
    if (list.length < 1000) break;
    end = oldest - IV[interval];
  }
  fs.writeFileSync(file, JSON.stringify({ from: fromMs, fetchedAt: Date.now(), rows }));
  return parseKlines(rows);
}

const pct = (x, d = 1) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

function stats(sigs, label) {
  const f = (k) => sigs.map((s) => s[k]).filter((x) => x != null);
  const plan = sigs.map((s) => s.plan).filter(Boolean);
  const r7 = f('r7d');
  const ex7 = sigs.filter((s) => s.r7d != null && s.bench7d != null).map((s) => s.r7d - s.bench7d);
  const tp = plan.filter((p) => p.outcome === 'TP').length;
  const sl = plan.filter((p) => p.outcome === 'SL').length;
  return [
    label.padEnd(24),
    String(sigs.length).padStart(5),
    pct(median(f('r24h'))).padStart(8),
    pct(median(f('r3d'))).padStart(8),
    pct(median(r7)).padStart(8),
    `${r7.length ? Math.round((r7.filter((x) => x > 0).length / r7.length) * 100) : '—'}%`.padStart(6),
    pct(median(ex7)).padStart(9),
    `${plan.length ? Math.round((tp / plan.length) * 100) : '—'}/${plan.length ? Math.round((sl / plan.length) * 100) : '—'}`.padStart(8),
    pct(mean(plan.map((p) => p.ret))).padStart(8),
    pct(plan.reduce((s, p) => s + p.ret, 0), 0).padStart(9),
  ].join(' ');
}

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  const now = Date.now();
  const testFrom = now - DAYS * DAY;
  const dataFrom = testFrom - WARMUP * DAY;

  const universe = selectUniverse(await fetchTickers(), { limit: UNIVERSE }).map((t) => t.symbol);
  console.log(`Univers: ${universe.length} paires (top turnover aujourd'hui). Test sur ${DAYS} jours. Téléchargement…`);
  const btcDaily = await range('BTCUSDT', 'D', dataFrom - 60 * DAY);
  const data = {};
  let done = 0;
  await pool(universe, async (s) => {
    const [b4, b1h] = await Promise.all([range(s, '240', dataFrom), range(s, '60', testFrom - 8 * DAY)]);
    data[s] = { b4, b1h };
    if (++done % 25 === 0) console.log(`  ${done}/${universe.length}`);
  }, { concurrency: 5 });

  const sigs = [];
  for (const s of universe) {
    if (!data[s]) continue;
    sigs.push(...findSignals({ symbol: s, ...data[s], btcDaily, from: testFrom }));
  }
  // Benchmark: median 7d return of the whole universe from the same moment.
  for (const g of sigs) {
    const rs = [];
    for (const s of universe) {
      const b = data[s]?.b1h;
      if (!b) continue;
      const a = closeAt(b, g.t); const z = closeAt(b, g.t + 7 * DAY);
      if (a && z && b.t[b.t.length - 1] + HOUR >= g.t + 7 * DAY) rs.push(z / a - 1);
    }
    g.bench7d = rs.length >= 20 ? median(rs) : null;
  }
  sigs.sort((a, b) => a.t - b.t);

  const head = `${'Groupe'.padEnd(24)} ${'N'.padStart(5)} ${'méd 24h'.padStart(8)} ${'méd 3J'.padStart(8)} ${'méd 7J'.padStart(8)} ${'7J>0'.padStart(6)} ${'vs marché'.padStart(9)} ${'TP/SL %'.padStart(8)} ${'plan moy'.padStart(8)} ${'plan Σ'.padStart(9)}`;
  const by = (fn) => sigs.filter(fn);
  const lines = [
    `SQUEEZE RADAR — backtest ${new Date(testFrom).toISOString().slice(0, 10)} → ${new Date(now).toISOString().slice(0, 10)} · ${universe.length} paires · généré ${new Date(now).toISOString()}`,
    'Signal = clôture 1H au-dessus du plafond 14J (4H) avec quiet_pct <= 10. Entrée au close de cette bougie.',
    'Plan = stop au milieu du box, objectif = plafond + hauteur du box, sortie forcée à 14J. Frais 0,1 % par côté.',
    '"vs marché" = rendement 7J du signal moins la médiane 7J de tout l\'univers au même moment.',
    '',
    head,
    '-'.repeat(head.length),
    stats(sigs, 'TOUS'),
    stats(by((s) => s.regime === 'bull'), 'BTC bull'),
    stats(by((s) => s.regime === 'chop'), 'BTC chop'),
    stats(by((s) => s.regime === 'bear'), 'BTC bear'),
    stats(by((s) => s.regime !== 'bear'), 'BTC pas bear'),
    stats(by((s) => s.volRatio > 1.5), 'Vol 24h/7J > 1.5'),
    stats(by((s) => !(s.volRatio > 1.5)), 'Vol 24h/7J <= 1.5'),
    stats(by((s) => s.regime !== 'bear' && s.volRatio > 1.5), 'pas bear + vol > 1.5'),
    stats(by((s) => s.quiet <= 5), 'quiet <= 5'),
    '',
    'Limites: univers = paires listées aujourd\'hui (les délistés manquent → biais favorable);',
    'pas le vrai Top 50 score 30D de chaque jour; entrée au close exact (pas de slippage).',
  ];
  const txt = lines.join('\n');
  console.log(`\n${txt}`);
  fs.writeFileSync(path.join(OUT, 'squeeze-summary.txt'), `${txt}\n`);
  const csv = ['time,symbol,entry,high,low,rng14,quiet,volRatio,regime,r24h,r3d,r7d,bench7d,plan_outcome,plan_ret,plan_hours'];
  for (const s of sigs) {
    csv.push([new Date(s.t).toISOString(), s.symbol, s.entry, s.high, s.low, s.rng14.toFixed(4), s.quiet.toFixed(1), s.volRatio?.toFixed(2) ?? '', s.regime ?? '',
      s.r24h?.toFixed(4) ?? '', s.r3d?.toFixed(4) ?? '', s.r7d?.toFixed(4) ?? '', s.bench7d?.toFixed(4) ?? '', s.plan?.outcome ?? '', s.plan?.ret.toFixed(4) ?? '', s.plan?.hours ?? ''].join(','));
  }
  fs.writeFileSync(path.join(OUT, 'squeeze-trades.csv'), `${csv.join('\n')}\n`);
  console.log(`\n${sigs.length} signaux → backtest/results/squeeze-trades.csv`);
}

main().catch((e) => { console.error(e); process.exit(1); });
