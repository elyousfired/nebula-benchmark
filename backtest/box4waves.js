// Quiet-box breakout on every alt of the /btc universe, $10 per signal, in each of the 4 waves,
// split by the BTC light A at signal time (🔴 vs 🟡/🟢). Exit: stop -5 %, trailing 5 % once +5 %,
// max 14 days. Cost 0.15 %/side. Run: node backtest/box4waves.js
import { HOUR, DAY } from '../src/core/bars.js';
import { range } from './data.js';
import { findSignals, idxAt } from './squeezeSim.js';

const COST = 0.0015; const BET = 10;
const WAVES = [['Hausse 1', '2026-03-02', '2026-05-26'], ['Baisse 1', '2026-05-26', '2026-07-01'], ['Hausse 2', '2026-07-01', '2026-09-21'], ['Baisse 2', '2026-09-21', null]];
const START = Date.parse(WAVES[0][1]);
const f = await (await fetch('https://nebula-benchmark.vercel.app/api/followers')).json();
const syms = f.tokens.map((t) => t.symbol);
const btcD = await range('BTCUSDT', 'D', START - 300 * DAY);
const ema = []; btcD.c.forEach((c, i) => ema.push(i ? ema[i - 1] + (2 / 51) * (c - ema[i - 1]) : c));
const topA = (i) => { let lo = -1; for (let k = Math.max(0, i - 60); k < i; k++) if (lo < 0 || btcD.l[k] < btcD.l[lo]) lo = k; let h = 0; for (let k = Math.max(0, lo - 20); k < lo; k++) h = Math.max(h, btcD.h[k]); return h || Infinity; };
const light = (t) => { const i = idxAt(btcD.t, t - DAY); return i < 60 ? null : (btcD.c[i] > ema[i]) + (btcD.c[i] > topA(i)); };

function exitFixed(b, k, entry) {
  let stop = entry * 0.95; let peak = entry; const end = b.t[k] + 14 * DAY; let i = k + 1;
  for (; i < b.t.length && b.t[i] < end; i++) {
    if (b.l[i] <= stop) return stop;
    peak = Math.max(peak, b.h[i]); if (peak >= entry * 1.05) stop = Math.max(stop, peak * 0.95);
  }
  return i >= b.t.length ? b.c[b.t.length - 1] : b.c[i - 1];
}
// --quiet 20 : box counted as quiet up to that percentile (default 10)
const qi = process.argv.indexOf('--quiet'); const QMAX = qi > 0 ? Number(process.argv[qi + 1]) : 10;
const trades = [];
for (const s of syms) {
  let b4; let b1h;
  try { b4 = await range(s, '240', START - 130 * DAY); b1h = await range(s, '60', START - 20 * DAY); } catch { continue; }
  for (const sg of findSignals({ symbol: s, b4, b1h, btcDaily: btcD, from: START, quietMax: QMAX })) {
    const k = idxAt(b1h.t, sg.t - HOUR);
    const j4 = idxAt(b4.t, sg.t - HOUR); let m30 = 0; let c30 = 0; for (let j = Math.max(0, j4 - 180); j < j4; j++) { m30 += b4.c[j]; c30++; }
    trades.push({
      t: sg.t, light: light(sg.t), usd: BET * ((exitFixed(b1h, k, sg.entry) * (1 - COST)) / (sg.entry * (1 + COST)) - 1),
      q: sg.quiet, vol: sg.volRatio, width: sg.rng14, above: sg.entry / sg.high - 1,
      wick: (b1h.c[k] - b1h.l[k]) / (b1h.h[k] - b1h.l[k] || 1), trend: c30 ? sg.entry / (m30 / c30) - 1 : null,
    });
  }
}
if (process.argv.includes('--features')) {
  const go = trades.filter((x) => x.light >= 1);
  const sum = (a) => { const g = a.filter((x) => x.usd > 0).reduce((p, x) => p + x.usd, 0); const l = -a.filter((x) => x.usd <= 0).reduce((p, x) => p + x.usd, 0); return `${String(a.length).padStart(4)} tr · ${(g - l) >= 0 ? '+' : ''}${(g - l).toFixed(1).padStart(6)} $ · ${a.length ? Math.round((100 * a.filter((x) => x.usd > 0).length) / a.length) : 0}% gagn · PF ${l ? (g / l).toFixed(2) : '—'} · ${a.length ? ((g - l) / a.length).toFixed(2) : 0} $/trade`; };
  const split = (name, f, cuts) => {
    console.log(`\n${name}`);
    const v = go.filter((x) => f(x) != null && Number.isFinite(f(x)));
    for (let i = 0; i <= cuts.length; i++) {
      const lo = i ? cuts[i - 1] : -Infinity; const hi = i < cuts.length ? cuts[i] : Infinity;
      const lab = i === 0 ? `< ${cuts[0]}` : i === cuts.length ? `≥ ${cuts[i - 1]}` : `${lo} – ${hi}`;
      console.log(`  ${lab.padEnd(14)} ${sum(v.filter((x) => f(x) >= lo && f(x) < hi))}`);
    }
  };
  console.log(`\nquiet ≤ ${QMAX} · feu 🟡/🟢 seulement · ${sum(go)}`);
  split('quiet de la box', (x) => x.q, [5, 10, 15]);
  split('feu (1 = 🟡, 2 = 🟢)', (x) => x.light, [2]);
  split('volume 24h / moyenne 7j (volRatio)', (x) => x.vol, [1, 1.5, 2.5]);
  split('largeur de la box 14j', (x) => x.width, [0.1, 0.15, 0.25]);
  split('entrée au-dessus du plafond', (x) => x.above, [0.005, 0.015, 0.03]);
  split('position de la clôture dans la bougie 1H (0 bas, 1 haut)', (x) => x.wick, [0.5, 0.75]);
  split('prix vs moyenne 30 j', (x) => x.trend, [-0.05, 0, 0.05]);
  console.log('\nCOMBINAISONS (🟡/🟢)');
  const W = (x) => x.width < 0.15; const A = (x) => x.above < 0.03;
  for (const [n, f] of [['largeur < 15 %', W], ['largeur < 15 % + entrée < 3 % au-dessus', (x) => W(x) && A(x)]]) {
    const g = go.filter(f);
    console.log(`  ${n.padEnd(40)} ${sum(g)}`);
    for (const [wn, a, z] of WAVES) { const ta = Date.parse(a); const tb = z ? Date.parse(z) : Date.now(); console.log(`      ${wn.padEnd(10)} ${sum(g.filter((x) => x.t >= ta && x.t < tb))}`); }
  }
  process.exit(0);
}
console.log(`quiet ≤ ${QMAX}`);
const sum = (a) => { const g = a.filter((x) => x.usd > 0).reduce((p, x) => p + x.usd, 0); const l = -a.filter((x) => x.usd <= 0).reduce((p, x) => p + x.usd, 0); return `${String(a.length).padStart(4)} trades · ${(g - l) >= 0 ? '+' : ''}${(g - l).toFixed(2)} $ · ${a.length ? Math.round((100 * a.filter((x) => x.usd > 0).length) / a.length) : 0}% gagnants · PF ${l ? (g / l).toFixed(2) : '—'}`; };
console.log(`${syms.length} tokens · 10 $ par signal`);
let tot = []; let totGo = [];
for (const [name, a, z] of WAVES) {
  const ta = Date.parse(a); const tb = z ? Date.parse(z) : Date.now();
  const w = trades.filter((x) => x.t >= ta && x.t < tb); tot = tot.concat(w); totGo = totGo.concat(w.filter((x) => x.light >= 1));
  console.log(`\n${name}\n  tous       ${sum(w)}\n  🟡/🟢       ${sum(w.filter((x) => x.light >= 1))}\n  🔴          ${sum(w.filter((x) => x.light === 0))}`);
}
console.log(`\nLes 4 vagues\n  tous       ${sum(tot)}\n  🟡/🟢 seul ${sum(totGo)}`);
