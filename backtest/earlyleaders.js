// "Pick at the start of the rally": at each BTC rally start, rank tokens by their return over
// the first N days, buy the top 10 (equal weight) at the next open, hold to the end, vs BTC.
// Starts: (1) the manual waves Hausse 1 / Hausse 2 (held to the wave end); (2) every 🟢 entry
// of the BTC light "A" since 2021 (held until the light turns 🔴). Cost 0.15 %/side.
// Run: node backtest/earlyleaders.js
import { bybitGet } from '../src/lib/bybit.js';
import { selectUniverse } from '../src/core/universe.js';
import { range } from './data.js';

const DAY = 86400000; const COST = 0.0015; const N = 10; const TOP = 10;
const FROM = Date.parse('2021-01-01');
const pc = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);
const med = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

const btc = await range('BTCUSDT', 'D', FROM);
const bi = new Map(btc.t.map((t, i) => [t, i]));
const tickers = (await bybitGet('tickers', { category: 'spot' })).list;
const uni = selectUniverse(tickers, { limit: 500 }).map((t) => t.symbol).filter((s) => s !== 'BTCUSDT');
const all = [];
for (const s of uni) { try { const b = await range(s, 'D', FROM); if (b.t.length) all.push({ s, m: new Map(b.t.map((t, i) => [t, { o: b.o[i], c: b.c[i] }])) }); } catch { /* skip */ } }

// Light A on BTC (same as /btc): entries (🟢 while out) and exits (🔴 while in), by signal day.
const ema = []; btc.c.forEach((c, i) => ema.push(i ? ema[i - 1] + (2 / 51) * (c - ema[i - 1]) : c));
function top(i) { let lo = -1; for (let k = Math.max(0, i - 60); k < i; k++) if (lo < 0 || btc.l[k] < btc.l[lo]) lo = k; let h = 0; for (let k = Math.max(0, lo - 20); k < lo; k++) h = Math.max(h, btc.h[k]); return h || Infinity; }
const episodes = []; let inPos = false; let cur = null;
for (let i = 60; i < btc.t.length - 1; i++) {
  const n = (btc.c[i] > ema[i]) + (btc.c[i] > top(i));
  if (!inPos && n === 2) { inPos = true; cur = { start: btc.t[i + 1] }; }
  else if (inPos && n === 0) { inPos = false; cur.end = btc.t[i + 1]; episodes.push(cur); }
}
if (inPos) episodes.push({ ...cur, end: btc.t[btc.t.length - 1], open: true });

/** start = day whose OPEN is the rally start; rank on open(start) -> close(start+N-1); buy open(start+N); sell open(end). */
function test(start, end) {
  const rankEnd = start + (N - 1) * DAY; const buy = start + N * DAY;
  if (!bi.has(buy) || buy >= end) return null;
  const sc = [];
  for (const x of all) {
    const a = x.m.get(start); const z = x.m.get(rankEnd); const p0 = x.m.get(buy); const p1 = x.m.get(end) || x.m.get(end - DAY);
    if (!a || !z || !p0 || !p1) continue;
    sc.push({ s: x.s, early: z.c / a.o - 1, fwd: ((p1.o ?? p1.c) * (1 - COST)) / (p0.o * (1 + COST)) - 1 });
  }
  if (sc.length < 30) return null;
  sc.sort((p, q) => q.early - p.early);
  const top10 = sc.slice(0, TOP);
  const b0 = btc.o[bi.get(buy)]; const b1 = bi.has(end) ? btc.o[bi.get(end)] : btc.c[btc.c.length - 1];
  return { n: sc.length, btcEarly: btc.c[bi.get(rankEnd)] / btc.o[bi.get(start)] - 1, btc: (b1 * (1 - COST)) / (b0 * (1 + COST)) - 1, top: mean(top10.map((x) => x.fwd)), topMed: med(top10.map((x) => x.fwd)), beat: top10.filter((x) => x.fwd > (b1 / b0 - 1)).length, allMed: med(sc.map((x) => x.fwd)), names: top10.map((x) => x.s.replace('USDT', '')).join(' ') };
}
const line = (label, r) => (r ? `${label.padEnd(26)} n=${String(r.n).padStart(3)} | BTC 10J ${pc(r.btcEarly).padStart(7)} | suite: BTC ${pc(r.btc).padStart(7)} · top10 moy ${pc(r.top).padStart(7)} méd ${pc(r.topMed).padStart(7)} · ${r.beat}/10 > BTC · tous méd ${pc(r.allMed).padStart(7)}` : `${label}: pas assez de données`);

console.log('Vagues manuelles (classement sur les 10 premiers jours, tenu jusqu\'à la fin de la vague)');
for (const [name, s, e] of [['Hausse 1', '2026-03-02', '2026-05-26'], ['Hausse 2', '2026-07-01', '2026-09-21']]) {
  const r = test(Date.parse(s), Date.parse(e)); console.log(line(name, r)); if (r) console.log(`   top10: ${r.names}`);
}
console.log('\nEntrées 🟢 du feu A depuis 2021 (tenu jusqu\'au 🔴)');
const res = [];
for (const ep of episodes) {
  const r = test(ep.start, ep.end);
  const lab = `${new Date(ep.start).toISOString().slice(0, 10)} → ${new Date(ep.end).toISOString().slice(0, 10)}${ep.open ? '*' : ''}`;
  console.log(line(lab, r)); if (r) res.push(r);
}
if (res.length) {
  const won = res.filter((r) => r.top > r.btc).length;
  const cumB = res.reduce((a, r) => a * (1 + r.btc), 1) - 1; const cumT = res.reduce((a, r) => a * (1 + r.top), 1) - 1;
  console.log(`\n→ ${res.length} épisodes · top10 bat BTC dans ${won}/${res.length} · cumulé BTC ${pc(cumB)} · cumulé top10 ${pc(cumT)} · médiane des écarts ${pc(med(res.map((r) => r.top - r.btc)))}`);
}
