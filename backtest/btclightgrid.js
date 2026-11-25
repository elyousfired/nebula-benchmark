// Robustness of the BTC trend light: EMA 30..200 × several "last top" windows, on BTC and
// ETH from Binance (2017-08 -> now, via nebula-core), incl. 2017-2021 never seen before.
// 🟢 (close > EMA and > top) buy, 🔴 (neither) sell, 🟡 keep. Fee 0.1%/side.
// Run: node backtest/btclightgrid.js
import { klinesRange } from 'file:///C:/Users/red1e/nebula-core/src/cex/binance.js';

const EMAS = [30, 40, 50, 60, 100, 200];
const TOPS = [['A 30/10', 'A', 30, 10], ['A 60/20', 'A', 60, 20], ['A 90/30', 'A', 90, 30], ['B 10J', 'B', 10], ['B 20J', 'B', 20], ['B 50J', 'B', 50]];
const PERIODS = [['2017-08 → 2021-06 (jamais vu)', '2017-08-01', '2021-07-01'], ['2021-07 → maintenant', '2021-07-01', null], ['Tout 2017 → maintenant', '2017-08-01', null]];
const pc = (x) => `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`;

// Staged: weight = number of green conditions / 2 (🟡 = 50 %, 🟢 = 100 %, 🔴 = 0), fee on each change.
function staged(b, emaN, top, i0, i1) {
  const e = []; b.forEach((k, i) => e.push(i ? e[i - 1] + (2 / (emaN + 1)) * (k.c - e[i - 1]) : k.c));
  const tp = (i) => {
    if (top[1] === 'B') { let h = 0; for (let k = Math.max(0, i - top[2]); k < i; k++) h = Math.max(h, b[k].h); return h; }
    let lo = -1; for (let k = Math.max(0, i - top[2]); k < i; k++) if (lo < 0 || b[k].l < b[lo].l) lo = k;
    let h = 0; for (let k = Math.max(0, lo - top[3]); k < lo; k++) h = Math.max(h, b[k].h); return h || Infinity;
  };
  let w = 0; let eq = 1; let pk = 1; let dd = 0;
  for (let i = i0 + 1; i <= i1; i++) {
    eq *= 1 + w * (b[i].c / b[i - 1].c - 1);
    const nw = ((b[i].c > e[i]) + (b[i].c > tp(i))) / 2;
    eq *= 1 - 0.001 * Math.abs(nw - w); w = nw;
    pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1);
  }
  return { r: eq - 1, dd };
}

function sim(b, emaN, top, i0, i1) {
  const e = []; b.forEach((k, i) => e.push(i ? e[i - 1] + (2 / (emaN + 1)) * (k.c - e[i - 1]) : k.c));
  const tp = (i) => {
    if (top[1] === 'B') { let h = 0; for (let k = Math.max(0, i - top[2]); k < i; k++) h = Math.max(h, b[k].h); return h; }
    let lo = -1; for (let k = Math.max(0, i - top[2]); k < i; k++) if (lo < 0 || b[k].l < b[lo].l) lo = k;
    let h = 0; for (let k = Math.max(0, lo - top[3]); k < lo; k++) h = Math.max(h, b[k].h); return h || Infinity;
  };
  let pos = false; let eq = 1; let pk = 1; let dd = 0; let n = 0;
  for (let i = i0 + 1; i <= i1; i++) {
    if (pos) eq *= b[i].c / b[i - 1].c;
    const s = (b[i].c > e[i]) + (b[i].c > tp(i));
    if (!pos && s === 2) { pos = true; eq *= 0.999; n++; } else if (pos && s === 0) { pos = false; eq *= 0.999; }
    pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1);
  }
  return { r: eq - 1, dd, n };
}
const hold = (b, i0, i1) => { let pk = 0; let dd = 0; for (let i = i0; i <= i1; i++) { pk = Math.max(pk, b[i].c); dd = Math.min(dd, b[i].c / pk - 1); } return { r: b[i1].c / b[i0].c - 1, dd }; };

for (const sym of ['BTCUSDT', 'ETHUSDT']) {
  const b = await klinesRange(sym, '1d', Date.parse('2017-01-01'));
  for (const [label, from, to] of PERIODS) {
    // Warm-up: the signal uses data before `from` (EMA200 needs it), trades start at `from`.
    const i0 = b.findIndex((k) => k.t >= Date.parse(from)); const i1 = to ? b.findIndex((k) => k.t >= Date.parse(to)) - 1 : b.length - 1;
    if (i0 < 0) continue;
    const h = hold(b, Math.max(i0, 0), i1);
    console.log(`\n${sym.replace('USDT', '')} · ${label} · acheté et gardé ${pc(h.r)} (DD ${pc(h.dd)}) · cases = rendement / max DD`);
    console.log(`EMA  | ${TOPS.map((t) => t[0].padEnd(12)).join('| ')}`);
    let beatR = 0; let beatDD = 0; let tot = 0;
    for (const em of EMAS) {
      const cells = TOPS.map((t) => { const s = sim(b, em, t, i0, i1); tot++; if (s.r > h.r) beatR++; if (s.dd > h.dd * 0.7) beatDD++; return `${pc(s.r)}/${pc(s.dd)}`.padEnd(12); });
      console.log(`${String(em).padEnd(4)} | ${cells.join('| ')}`);
    }
    console.log(`→ bat le rendement de l'actif gardé : ${beatR}/${tot} · drawdown réduit d'au moins 30 % : ${beatDD}/${tot}`);
    // Staged vs all at once over the same 36 settings.
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
    const A = []; const S = [];
    for (const em of EMAS) for (const t of TOPS) { A.push(sim(b, em, t, i0, i1)); S.push(staged(b, em, t, i0, i1)); }
    const rdd = (x) => x.r / -x.dd;
    const better = S.filter((s, k) => rdd(s) > rdd(A[k])).length;
    console.log(`   Tout d'un coup : médiane ${pc(med(A.map((x) => x.r)))} / DD ${pc(med(A.map((x) => x.dd)))} · Par étapes (🟡 50 %) : médiane ${pc(med(S.map((x) => x.r)))} / DD ${pc(med(S.map((x) => x.dd)))} · étapes meilleur rendement/DD : ${better}/36`);
  }
}
