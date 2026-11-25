// "Pick the time, not the token": base = BTC with the light A (in at 🟢, out at 🔴). While in,
// hold ETH (or a basket of big alts) instead of BTC when ETH/BTC is above its EMA. Daily,
// signal at the close, return from the next day. Cost 0.15 % per change. Binance via nebula-core.
// Run: node backtest/ethbtcrotation.js
import { klinesRange } from 'file:///C:/Users/red1e/nebula-core/src/cex/binance.js';

const COST = 0.0015;
const ALTS = ['ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT', 'TRXUSDT']; // big alts listed since 2018-19
const pc = (x) => `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`;

const load = async (s) => new Map((await klinesRange(s, '1d', Date.parse('2017-08-01'))).map((k) => [k.t, k]));
const btcRows = await klinesRange('BTCUSDT', '1d', Date.parse('2017-08-01'));
const M = {}; for (const s of ALTS) M[s] = await load(s);
const T = btcRows.map((k) => k.t); const n = T.length;
const C = (s, i) => (s === 'BTCUSDT' ? btcRows[i].c : M[s].get(T[i])?.c);

// Light A on BTC.
const ema = []; btcRows.forEach((k, i) => ema.push(i ? ema[i - 1] + (2 / 51) * (k.c - ema[i - 1]) : k.c));
const top = (i) => { let lo = -1; for (let k = Math.max(0, i - 60); k < i; k++) if (lo < 0 || btcRows[k].l < btcRows[lo].l) lo = k; let h = 0; for (let k = Math.max(0, lo - 20); k < lo; k++) h = Math.max(h, btcRows[k].h); return h || Infinity; };
const inBtc = []; let pos = false;
for (let i = 0; i < n; i++) { const s = (btcRows[i].c > ema[i]) + (btcRows[i].c > top(i)); if (!pos && s === 2) pos = true; else if (pos && s === 0) pos = false; inBtc.push(pos); }
// ETH/BTC above its EMA (several lengths).
function ratioUp(len) {
  const out = []; let e = null;
  for (let i = 0; i < n; i++) { const eth = C('ETHUSDT', i); if (!eth) { out.push(false); continue; } const r = eth / btcRows[i].c; e = e == null ? r : e + (2 / (len + 1)) * (r - e); out.push(r > e); }
  return out;
}
const dayRet = (s, i) => { const a = C(s, i - 1); const b = C(s, i); return a && b ? b / a - 1 : null; };
const basketRet = (i) => { const r = ALTS.map((s) => dayRet(s, i)).filter((x) => x != null); return r.length ? r.reduce((p, q) => p + q, 0) / r.length : 0; };

// hold(i) -> 'cash' | 'BTC' | 'ETH' | 'ALTS' decided at close i-1, applied to day i.
function run(hold, i0, i1) {
  let eq = 1; let pk = 1; let dd = 0; let prev = 'cash'; const days = { BTC: 0, ETH: 0, ALTS: 0 };
  for (let i = i0 + 1; i <= i1; i++) {
    const h = hold(i - 1);
    if (h !== prev) { eq *= 1 - COST * (prev === 'cash' || h === 'cash' ? 1 : 2); prev = h; }
    if (h !== 'cash') { days[h]++; eq *= 1 + (h === 'BTC' ? dayRet('BTCUSDT', i) : h === 'ETH' ? (dayRet('ETHUSDT', i) ?? 0) : basketRet(i)); }
    pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1);
  }
  return { r: eq - 1, dd, days };
}
const idx = (d) => T.findIndex((t) => t >= Date.parse(d));
const PERIODS = [['2018-01 → 2021-06 (jamais vu)', '2018-01-01', '2021-07-01'], ['2021-07 → maintenant', '2021-07-01', null], ['Tout 2018 → maintenant', '2018-01-01', null]];
for (const len of [30, 50, 100]) {
  const up = ratioUp(len);
  console.log(`\n=== ETH/BTC au-dessus de son EMA${len} ===`);
  for (const [label, a, z] of PERIODS) {
    const i0 = idx(a); const i1 = z ? idx(z) - 1 : n - 1;
    const S = {
      'BTC gardé': run(() => 'BTC', i0, i1),
      'BTC au feu': run((i) => (inBtc[i] ? 'BTC' : 'cash'), i0, i1),
      'Feu + ETH si ETH/BTC ↑': run((i) => (inBtc[i] ? (up[i] ? 'ETH' : 'BTC') : 'cash'), i0, i1),
      'Feu + panier alts si ↑': run((i) => (inBtc[i] ? (up[i] ? 'ALTS' : 'BTC') : 'cash'), i0, i1),
    };
    console.log(`${label}`);
    for (const [k, v] of Object.entries(S)) console.log(`  ${k.padEnd(26)} ${pc(v.r).padStart(8)} · max DD ${pc(v.dd).padStart(5)}${v.days.ETH + v.days.ALTS ? ` · jours en alts ${v.days.ETH + v.days.ALTS}/${v.days.BTC + v.days.ETH + v.days.ALTS}` : ''}`);
  }
  // Did it catch the 2023-10 -> 2024-04 alt run, and stay in BTC otherwise?
  const i0 = idx('2023-10-18'); const i1 = idx('2024-04-30');
  let inAlt = 0; let inAny = 0; for (let i = i0; i < i1; i++) if (inBtc[i]) { inAny++; if (up[i]) inAlt++; }
  console.log(`  Épisode 2023-10-18 → 2024-04-30 : en alts ${inAlt}/${inAny} jours investis`);
}
