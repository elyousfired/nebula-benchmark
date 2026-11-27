// $1000 portfolio over our 4 waves (2026-03-02 → now), BTC light A on the daily close (fill next open).
//   A. BTC with the light: 100 % BTC in 🟡/🟢, cash in 🔴
//   B. Box only: quiet-box breakouts on the /btc list, only in 🟡/🟢, $S per signal, max K open, rest in cash
//   C. Mix: half BTC with the light + box trades from the other half
// Box exit: stop -5 %, trailing 5 % once +5 %, 14 days max. Cost 0.15 %/side everywhere.
// Box positions are counted at cost until they close (drawdown is approximate). Run: node backtest/pf1000.js
import { HOUR, DAY } from '../src/core/bars.js';
import { range } from './data.js';
import { findSignals, idxAt } from './squeezeSim.js';

const COST = 0.0015;
const WAVES = [['Hausse 1', '2026-03-02', '2026-05-26'], ['Baisse 1', '2026-05-26', '2026-07-01'], ['Hausse 2', '2026-07-01', '2026-09-21'], ['Baisse 2', '2026-09-21', null]]
  .map(([n, a, b]) => ({ n, a: Date.parse(a), b: b ? Date.parse(b) : Date.now() }));
const START = WAVES[0].a;
const f = await (await fetch('https://nebula-benchmark.vercel.app/api/followers')).json();
const syms = f.tokens.map((t) => t.symbol);
const btc = await range('BTCUSDT', 'D', START - 300 * DAY);
const ema = []; btc.c.forEach((c, i) => ema.push(i ? ema[i - 1] + (2 / 51) * (c - ema[i - 1]) : c));
const topA = (i) => { let lo = -1; for (let k = Math.max(0, i - 60); k < i; k++) if (lo < 0 || btc.l[k] < btc.l[lo]) lo = k; let h = 0; for (let k = Math.max(0, lo - 20); k < lo; k++) h = Math.max(h, btc.h[k]); return h || Infinity; };
const lightDay = (i) => (btc.c[i] > ema[i]) + (btc.c[i] > topA(i)); // light from the close of day i
const lightAt = (t) => { const i = idxAt(btc.t, t - DAY); return i < 60 ? 0 : lightDay(i); };

// all box trades: {t entry, x exit, r return}
const trades = [];
for (const s of syms) {
  let b4; let b1;
  try { b4 = await range(s, '240', START - 130 * DAY); b1 = await range(s, '60', START - 20 * DAY); } catch { continue; }
  for (const sg of findSignals({ symbol: s, b4, b1h: b1, btcDaily: btc, from: START })) {
    if (lightAt(sg.t) < 1) continue;
    const k = idxAt(b1.t, sg.t - HOUR); const e = sg.entry; let stop = e * 0.95; let peak = e; let px = null; let x = null;
    for (let i = k + 1; i < b1.t.length && b1.t[i] < sg.t + 14 * DAY; i++) {
      if (b1.l[i] <= stop) { px = stop; x = b1.t[i] + HOUR; break; }
      peak = Math.max(peak, b1.h[i]); if (peak >= e * 1.05) stop = Math.max(stop, peak * 0.95);
      px = b1.c[i]; x = b1.t[i] + HOUR;
    }
    if (px != null) trades.push({ s, t: sg.t, x, r: (px * (1 - COST)) / (e * (1 + COST)) - 1 });
  }
}
trades.sort((a, b) => a.t - b.t);

function sim({ btcPart, S, K }) {
  let cash = 1000; let units = 0; const open = []; let peak = 1000; let dd = 0; const eqAt = new Map();
  const ev = trades.map((x) => ({ ...x }));
  let ti = 0;
  const i0 = btc.t.findIndex((t) => t >= START);
  for (let i = i0; i < btc.t.length; i++) {
    const day0 = btc.t[i]; const day1 = day0 + DAY;
    // BTC sleeve: decided on yesterday's close, traded at today's open
    const want = btcPart > 0 && lightDay(i - 1) >= 1;
    if (want && units === 0) { const eq = cash + open.reduce((a, p) => a + p.size, 0); const amt = Math.min(cash, eq * btcPart); units = (amt * (1 - COST)) / btc.o[i]; cash -= amt; }
    if (!want && units > 0) { cash += units * btc.o[i] * (1 - COST); units = 0; }
    // box trades inside the day: exits then entries, in time order
    const todays = [];
    while (ti < ev.length && ev[ti].t < day1) todays.push(ev[ti++]);
    const events = [...open.filter((p) => p.x < day1).map((p) => ({ k: 'x', t: p.x, p })), ...todays.map((p) => ({ k: 'e', t: p.t, p }))].sort((a, b) => a.t - b.t || (a.k === 'x' ? -1 : 1));
    for (const e of events) {
      if (e.k === 'x') { const j = open.indexOf(e.p); if (j >= 0) { cash += e.p.size * (1 + e.p.r); open.splice(j, 1); } }
      else if (S > 0 && open.length < K && cash >= S) {
        const p = { ...e.p, size: S }; cash -= S; open.push(p);
        if (p.x < day1) { /* closes the same day: handled by a later event */ events.push({ k: 'x', t: p.x, p }); events.sort((a, b) => a.t - b.t); }
      }
    }
    const eq = cash + units * btc.c[i] + open.reduce((a, p) => a + p.size, 0);
    eqAt.set(day0, eq); peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1);
  }
  return { eqAt, dd, maxOpen: K };
}
const eqOn = (m, t) => { let v = 1000; for (const [d, e] of m) { if (d < t) v = e; else break; } return v; };
const pc = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const VARS = [
  ['A. BTC avec le feu', { btcPart: 1, S: 0, K: 0 }],
  ['B. Box seul, 10 $ / signal', { btcPart: 0, S: 10, K: 100 }],
  ['B. Box seul, 50 $ / signal, max 20', { btcPart: 0, S: 50, K: 20 }],
  ['B. Box seul, 100 $ / signal, max 10', { btcPart: 0, S: 100, K: 10 }],
  ['C. 50 % BTC feu + box 25 $, max 20', { btcPart: 0.5, S: 25, K: 20 }],
];
console.log(`\n1000 $ · ${syms.length} tokens /btc · ${trades.length} signaux box en 🟡/🟢`);
console.log(`BTC buy & hold : ${WAVES.map((w) => `${w.n} ${pc(btc.c[idxAt(btc.t, w.b - DAY)] / btc.o[btc.t.findIndex((t) => t >= w.a)] - 1)}`).join(' · ')}`);
for (const [name, cfg] of VARS) {
  const r = sim(cfg);
  const per = WAVES.map((w) => { const a = eqOn(r.eqAt, w.a + DAY); const z = eqOn(r.eqAt, w.b + DAY); return `${w.n} ${z - a >= 0 ? '+' : ''}${(z - a).toFixed(0)} $`; }).join(' · ');
  const end = [...r.eqAt.values()].at(-1);
  console.log(`\n${name}\n  fin ${end.toFixed(0)} $ (${pc(end / 1000 - 1)}) · pire baisse ${pc(r.dd)}\n  ${per}`);
}
