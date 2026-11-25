// BTC trend light vs buy & hold. Daily, no lookahead (signal at close, trade at that close).
// e = close > EMA50 · h = close > "last top" · 🟢 both -> buy, 🔴 none -> sell, 🟡 hold as is.
// Two "last top" versions: A = the highest high of the 20 days before the lowest low of the
// last 60 days (like /btc), B = 20-day high breakout. Fee 0.1%/side. Run: node backtest/btclight.js
import { range } from './data.js';

const DAY = 86400000;
const b = await range('BTCUSDT', 'D', Date.parse('2021-01-01'));
const ema = []; b.c.forEach((c, i) => ema.push(i ? ema[i - 1] + (2 / 51) * (c - ema[i - 1]) : c));
function topA(i) {
  let lo = -1; for (let k = Math.max(0, i - 60); k < i; k++) if (lo < 0 || b.l[k] < b.l[lo]) lo = k;
  let h = 0; for (let k = Math.max(0, lo - 20); k < lo; k++) h = Math.max(h, b.h[k]);
  return h || Infinity;
}
const topB = (i) => { let h = 0; for (let k = Math.max(0, i - 20); k < i; k++) h = Math.max(h, b.h[k]); return h; };
const pc = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`;

function run(top, from) {
  const i0 = b.t.findIndex((t) => t >= from);
  let inPos = false; let eq = 1; let pk = 1; let dd = 0; let trades = 0; let days = 0;
  let hold = 1; let hpk = 1; let hdd = 0;
  for (let i = i0 + 1; i < b.t.length; i++) {
    const r = b.c[i] / b.c[i - 1] - 1;
    if (inPos) { eq *= 1 + r; days++; }
    hold *= 1 + r; hpk = Math.max(hpk, hold); hdd = Math.min(hdd, hold / hpk - 1);
    const n = (b.c[i] > ema[i]) + (b.c[i] > top(i));
    if (!inPos && n === 2) { inPos = true; eq *= 0.999; trades++; }
    else if (inPos && n === 0) { inPos = false; eq *= 0.999; }
    pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1);
  }
  return { eq: eq - 1, dd, trades, expo: days / (b.t.length - i0 - 1), hold: hold - 1, hdd };
}
for (const from of ['2021-06-01', '2023-01-01', '2026-03-01']) {
  const A = run(topA, Date.parse(from)); const B = run(topB, Date.parse(from));
  console.log(`\nDepuis ${from} · BTC acheté et gardé ${pc(A.hold)} (max DD ${pc(A.hdd)})`);
  console.log(`  Feu A (sommet avant le creux) ${pc(A.eq)} · max DD ${pc(A.dd)} · ${A.trades} entrées · investi ${pc(A.expo)} du temps`);
  console.log(`  Feu B (cassure plus haut 20J) ${pc(B.eq)} · max DD ${pc(B.dd)} · ${B.trades} entrées · investi ${pc(B.expo)} du temps`);
}
console.log(`\nDonnées BTC du ${new Date(b.t[0]).toISOString().slice(0, 10)} au ${new Date(b.t[b.t.length - 1]).toISOString().slice(0, 10)}`);
