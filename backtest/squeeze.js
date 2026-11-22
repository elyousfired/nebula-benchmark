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
import { findSignals, closeAt, EXIT_VARIANTS, scoreSnapshots } from './squeezeSim.js';

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
  // Hold 7 days, no stop / no target.
  const full = sigs.filter((s) => s.max7d != null);
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
  const share = (a, fn) => `${Math.round((a.filter(fn).length / a.length) * 100)}%`;
  const mx = full.map((s) => s.max7d); const mn = full.map((s) => s.min7d); const r7 = full.map((s) => s.r7d);
  lines.push(
    '',
    `HOLD 7 JOURS (sans stop, sans TP) — ${full.length} signaux avec 7J de recul`,
    'Jour par jour (PnL au close, depuis l\'entrée):',
    `  ${'jour'.padEnd(6)} ${'médiane'.padStart(8)} ${'moyenne'.padStart(8)} ${'> 0'.padStart(5)}`,
    ...[0, 1, 2, 3, 4, 5, 6].map((d) => {
      const a = full.map((s) => s.days[d]).filter((x) => x != null);
      return `  J${d + 1}${' '.repeat(4)} ${pct(median(a)).padStart(8)} ${pct(mean(a)).padStart(8)} ${share(a, (x) => x > 0).padStart(5)}`;
    }),
    '',
    `Plus haut atteint en 7J : médiane ${pct(median(mx))} · 25% des signaux ≥ ${pct(q(mx, 0.75))} · 10% ≥ ${pct(q(mx, 0.9))}`,
    `  a touché +5% : ${share(full, (s) => s.max7d >= 0.05)} · +10% : ${share(full, (s) => s.max7d >= 0.10)} · +20% : ${share(full, (s) => s.max7d >= 0.20)} · plus haut médian atteint après ${median(full.map((s) => s.maxAtH))} h`,
    `Plus bas atteint en 7J : médiane ${pct(median(mn))} · a touché -5% : ${share(full, (s) => s.min7d <= -0.05)} · -10% : ${share(full, (s) => s.min7d <= -0.10)} · -20% : ${share(full, (s) => s.min7d <= -0.20)}`,
    `PnL final J7 : médiane ${pct(median(r7))} · moyenne ${pct(mean(r7))} · gagnants ${share(full, (s) => s.r7d > 0)}`,
    '',
    'Top 10 (plus haut en 7J):',
    ...[...full].sort((a, b) => b.max7d - a.max7d).slice(0, 10).map((s) => `  ${new Date(s.t).toISOString().slice(0, 16)} ${s.symbol.padEnd(14)} max ${pct(s.max7d).padStart(8)}  min ${pct(s.min7d).padStart(7)}  J7 ${pct(s.r7d).padStart(8)}`),
    'Pires 10 (PnL J7):',
    ...[...full].sort((a, b) => a.r7d - b.r7d).slice(0, 10).map((s) => `  ${new Date(s.t).toISOString().slice(0, 16)} ${s.symbol.padEnd(14)} max ${pct(s.max7d).padStart(8)}  min ${pct(s.min7d).padStart(7)}  J7 ${pct(s.r7d).padStart(8)}`),
  );
  // Exits: +target within N hours, else close at N hours. No stop.
  for (const [target, hours] of EXIT_VARIANTS) {
    const key = `${target}/${hours}`;
    const tp = sigs.filter((s) => s.exits[key]);
    const ex = (s) => s.exits[key];
    const rets = tp.map((s) => ex(s).ret);
    let eq = 1; let peak = 1; let dd = 0;
    for (const s of [...tp].sort((a, b) => ex(a).t - ex(b).t)) { eq *= 1 + 0.1 * ex(s).ret; peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1); }
    const lost = tp.filter((s) => ex(s).outcome === 'TIME' && ex(s).ret < 0).map((s) => ex(s).ret);
    const quarters = [0, 1, 2, 3].map((qi) => {
      const a = tp.slice(Math.floor((tp.length * qi) / 4), Math.floor((tp.length * (qi + 1)) / 4));
      return `  T${qi + 1} ${new Date(a[0].t).toISOString().slice(0, 7)}  n ${String(a.length).padStart(3)}  TP ${share(a, (s) => ex(s).outcome === 'TP').padStart(4)}  moy ${pct(mean(a.map((s) => ex(s).ret)), 2).padStart(7)}  méd ${pct(median(a.map((s) => ex(s).ret)), 2).padStart(7)}`;
    });
    const byReg = ['bull', 'chop', 'bear'].map((r) => {
      const a = tp.filter((s) => s.regime === r);
      return a.length ? `  BTC ${r.padEnd(5)} n ${String(a.length).padStart(3)}  TP ${share(a, (s) => ex(s).outcome === 'TP').padStart(4)}  moy ${pct(mean(a.map((s) => ex(s).ret)), 2).padStart(7)}` : '';
    }).filter(Boolean);
    lines.push(
      '',
      `SORTIE +${target * 100}% MAX EN ${hours}h (sinon close à ${hours}h, sans stop) — ${tp.length} signaux`,
      `  TP touché : ${share(tp, (s) => ex(s).outcome === 'TP')} · moyenne ${pct(mean(rets), 2)} · médiane ${pct(median(rets), 2)} · gagnants ${share(tp, (s) => ex(s).ret > 0)}`,
      `  sorties à ${hours}h perdantes : ${lost.length} · perte moyenne ${pct(mean(lost), 1)} · pire ${pct(Math.min(...lost), 1)}`,
      `  équité 10% du capital par trade : ${pct(eq - 1, 0)} · max drawdown ${pct(dd, 1)}`,
      ...quarters,
      ...byReg,
    );
  }
  // Setup score (Top 5 of the page): daily snapshots, then forward returns.
  const snaps = [];
  for (const s of universe) if (data[s]) snaps.push(...scoreSnapshots({ symbol: s, ...data[s], from: testFrom }));
  const byDay = new Map();
  for (const x of snaps) { if (!byDay.has(x.t)) byDay.set(x.t, []); byDay.get(x.t).push(x); }
  for (const day of byDay.values()) {
    const m2 = median(day.map((x) => x.r2d).filter((v) => v != null));
    for (const x of day) x.ex2d = x.r2d != null && m2 != null ? x.r2d - m2 : null;
  }
  const top5 = []; const bottom5 = [];
  for (const day of byDay.values()) {
    if (day.length < 30) continue;
    const s = [...day].sort((a, b) => b.score - a.score);
    top5.push(...s.slice(0, 5)); bottom5.push(...s.slice(-5));
  }
  const row = (a, label) => {
    const v = (k) => a.map((x) => x[k]).filter((y) => y != null);
    const tp = a.filter((x) => x.tp10);
    return `  ${label.padEnd(16)} ${String(a.length).padStart(6)} ${pct(median(v('r1d'))).padStart(7)} ${pct(median(v('r2d'))).padStart(7)} ${pct(median(v('r7d'))).padStart(7)} ${pct(median(v('ex2d'))).padStart(9)} ${pct(median(v('max2d'))).padStart(9)} ${share(a, (x) => x.max2d >= 0.10).padStart(7)} ${pct(mean(tp.map((x) => x.tp10.ret)), 2).padStart(9)}`;
  };
  lines.push(
    '',
    `SCORE TOP 5 (photo chaque jour à 00:00 UTC, ${byDay.size} jours, ${snaps.length} photos)`,
    `  ${'groupe'.padEnd(16)} ${'N'.padStart(6)} ${'méd 1J'.padStart(7)} ${'méd 2J'.padStart(7)} ${'méd 7J'.padStart(7)} ${'vs marché'.padStart(9)} ${'max 2J'.padStart(9)} ${'≥+10%'.padStart(7)} ${'+10%/48h'.padStart(9)}`,
    row(top5, 'Top 5 du jour'),
    row(bottom5, 'Pires 5 du jour'),
    row(snaps, 'Tout le monde'),
    ...[[80, 101], [60, 80], [40, 60], [20, 40], [0, 20]].map(([lo, hi]) => row(snaps.filter((x) => x.score >= lo && x.score < hi), `score ${lo}-${Math.min(hi, 100)}`)),
    '  "max 2J" = plus haut atteint en 48h · "≥+10%" = a touché +10% en 48h · "+10%/48h" = sortie +10% sinon close 48h (net de frais).',
  );
  const txt = lines.join('\n');
  console.log(`\n${txt}`);
  fs.writeFileSync(path.join(OUT, 'squeeze-summary.txt'), `${txt}\n`);
  const csv = ['time,symbol,entry,high,low,rng14,quiet,volRatio,regime,r24h,r3d,r7d,bench7d,plan_outcome,plan_ret,plan_hours,max7d,min7d,max_at_h,j1,j2,j3,j4,j5,j6,j7'];
  for (const s of sigs) {
    csv.push([new Date(s.t).toISOString(), s.symbol, s.entry, s.high, s.low, s.rng14.toFixed(4), s.quiet.toFixed(1), s.volRatio?.toFixed(2) ?? '', s.regime ?? '',
      s.r24h?.toFixed(4) ?? '', s.r3d?.toFixed(4) ?? '', s.r7d?.toFixed(4) ?? '', s.bench7d?.toFixed(4) ?? '', s.plan?.outcome ?? '', s.plan?.ret.toFixed(4) ?? '', s.plan?.hours ?? '',
      s.max7d?.toFixed(4) ?? '', s.min7d?.toFixed(4) ?? '', s.maxAtH ?? '', ...s.days.map((x) => x?.toFixed(4) ?? '')].join(','));
  }
  fs.writeFileSync(path.join(OUT, 'squeeze-trades.csv'), `${csv.join('\n')}\n`);
  console.log(`\n${sigs.length} signaux → backtest/results/squeeze-trades.csv`);
}

main().catch((e) => { console.error(e); process.exit(1); });
