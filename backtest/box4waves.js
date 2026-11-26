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
    trades.push({ t: sg.t, light: light(sg.t), usd: BET * ((exitFixed(b1h, k, sg.entry) * (1 - COST)) / (sg.entry * (1 + COST)) - 1) });
  }
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
