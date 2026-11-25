// Quiet-box breakout on the Top 50 alts (1H close above the 14-day 4H box while quiet<=10),
// split by the BTC light A of that day, two exits, then a real portfolio:
// one capital, max 5 open, risk 1 % of equity per trade (size = 1 % / stop distance, cap 25 %),
// hourly mark-to-market drawdown. Compared with the BTC/ETH rotation on the same year.
// Cost 0.1 % fee + 0.05 % slippage per side. Run: node backtest/squeezeLight.js [--days 365]
import { bybitGet } from '../src/lib/bybit.js';
import { selectUniverse } from '../src/core/universe.js';
import { HOUR, DAY } from '../src/core/bars.js';
import { range } from './data.js';
import { findSignals, idxAt } from './squeezeSim.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const DAYS = arg('days', 365); const COST = 0.0015; const MAXPOS = 5; const RISK = 0.01; const CAP = 0.25;
const now = Date.now(); const testFrom = Math.floor((now - DAYS * DAY) / DAY) * DAY;
const pc = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const WRAP = /^(WBTC|WETH|STETH|WSTETH|METH|BBSOL|CBBTC|WBETH|CMETH|JITOSOL|MSOL|BNSOL|SOLVBTC|LBTC|USDE|USDD|FDUSD|PYUSD|RLUSD|USD1|XAUT|PAXG)USDT$/;

// BTC light A per closed day (signal known after that day's close).
const btcD = await range('BTCUSDT', 'D', testFrom - 200 * DAY);
const ethD = await range('ETHUSDT', 'D', testFrom - 200 * DAY);
const ema = []; btcD.c.forEach((c, i) => ema.push(i ? ema[i - 1] + (2 / 51) * (c - ema[i - 1]) : c));
const topA = (i) => { let lo = -1; for (let k = Math.max(0, i - 60); k < i; k++) if (lo < 0 || btcD.l[k] < btcD.l[lo]) lo = k; let h = 0; for (let k = Math.max(0, lo - 20); k < lo; k++) h = Math.max(h, btcD.h[k]); return h || Infinity; };
const lightN = btcD.c.map((c, i) => (i < 60 ? null : (c > ema[i]) + (c > topA(i))));
const lightAtT = (t) => { const i = idxAt(btcD.t, t - DAY); return i < 0 ? null : lightN[i]; }; // last daily candle closed before t
const LBL = ['🔴', '🟡', '🟢'];

const tickers = (await bybitGet('tickers', { category: 'spot' })).list;
const uni = selectUniverse(tickers, { limit: 70 }).map((t) => t.symbol).filter((s) => !/^(BTC|ETH)USDT$/.test(s) && !WRAP.test(s)).slice(0, 50);
const data = {};
for (const s of uni) {
  try { data[s] = { b4: await range(s, '240', testFrom - 130 * DAY), b1h: await range(s, '60', testFrom - 20 * DAY) }; } catch { /* skip */ }
}

/** Walk 1H bars from entry: fixed (-5 %, trail 5 % once +5 %) or ATR (2×ATR, trail 2×ATR once +2×ATR); 14 days. */
function exitPlan(b, k, entry, mode) {
  let dist = 0.05;
  if (mode === 'atr') {
    const tr = []; let day = null; let h = 0; let l = Infinity; let pc0 = null;
    for (let i = Math.max(0, k - 24 * 15); i <= k; i++) {
      const d = Math.floor(b.t[i] / DAY);
      if (d !== day) { if (day != null && pc0 != null) tr.push(Math.max(h, pc0) - Math.min(l, pc0)); if (day != null) pc0 = b.c[i - 1]; day = d; h = 0; l = Infinity; }
      h = Math.max(h, b.h[i]); l = Math.min(l, b.l[i]);
    }
    const atr = tr.slice(-14).reduce((a, x) => a + x, 0) / Math.max(1, tr.slice(-14).length);
    dist = Math.min(0.4, Math.max(0.01, (2 * atr) / entry));
  }
  let stop = entry * (1 - dist); let peak = entry; const end = b.t[k] + 14 * DAY;
  let i = k + 1;
  for (; i < b.t.length && b.t[i] < end; i++) {
    if (b.l[i] <= stop) return { exitT: b.t[i] + HOUR, px: stop, dist };
    peak = Math.max(peak, b.h[i]);
    if (peak >= entry * (1 + dist)) stop = Math.max(stop, peak * (1 - dist));
  }
  if (i >= b.t.length) return null; // still open at the end of the data
  return { exitT: b.t[i - 1] + HOUR, px: b.c[i - 1], dist };
}

const trades = { fixed: [], atr: [] };
for (const s of Object.keys(data)) {
  const { b4, b1h } = data[s];
  for (const sg of findSignals({ symbol: s, b4, b1h, btcDaily: btcD, from: testFrom })) {
    const k = idxAt(b1h.t, sg.t - HOUR);
    for (const mode of ['fixed', 'atr']) {
      const x = exitPlan(b1h, k, sg.entry, mode);
      if (!x) continue;
      trades[mode].push({ s, t: sg.t, entry: sg.entry, ...x, light: lightAtT(sg.t), ret: (x.px * (1 - COST)) / (sg.entry * (1 + COST)) - 1 });
    }
  }
}
const st = (a) => { const w = a.filter((x) => x.ret > 0); const g = w.reduce((p, x) => p + x.ret, 0); const l = -a.filter((x) => x.ret <= 0).reduce((p, x) => p + x.ret, 0); return { n: a.length, pf: l ? g / l : null, avg: a.length ? a.reduce((p, x) => p + x.ret, 0) / a.length : null, win: a.length ? w.length / a.length : null }; };

console.log(`Quiet-box breakout · ${Object.keys(data).length} alts (Top 50 sans stables ni wrapped) · ${new Date(testFrom).toISOString().slice(0, 10)} → maintenant`);
console.log(`Jours au feu : 🟢 ${btcD.t.filter((t, i) => t >= testFrom && lightN[i] === 2).length} · 🟡 ${btcD.t.filter((t, i) => t >= testFrom && lightN[i] === 1).length} · 🔴 ${btcD.t.filter((t, i) => t >= testFrom && lightN[i] === 0).length}`);
for (const mode of ['fixed', 'atr']) {
  console.log(`\nSortie ${mode === 'fixed' ? 'fixe (-5 %, trailing 5 % dès +5 %, 14 J)' : 'ATR (2×ATR jour, trailing 2×ATR, 14 J)'} — par trade`);
  for (const [lab, f] of [['Tous', () => true], ['🟢', (x) => x.light === 2], ['🟡', (x) => x.light === 1], ['🔴', (x) => x.light === 0]]) {
    const r = st(trades[mode].filter(f));
    console.log(`  ${lab.padEnd(5)} n=${String(r.n).padStart(4)} · PF ${r.pf == null ? '—' : r.pf.toFixed(2)} · moy ${pc(r.avg, 2)} · gagnants ${pc(r.win, 0)}`);
  }
}

// Portfolio: hourly, max 5 open, 1 % risk per trade, size capped at 25 % of equity and by cash.
function portfolio(list) {
  const ev = [...list].sort((a, b) => a.t - b.t);
  let cash = 1; const open = []; let pk = 1; let dd = 0; let taken = 0; let skipped = 0;
  const priceAt = (s, t) => { const b = data[s].b1h; const i = idxAt(b.t, t - HOUR); return i >= 0 ? b.c[i] : null; };
  const t0 = testFrom; let e = 0;
  for (let t = t0; t <= now; t += HOUR) {
    for (let j = open.length - 1; j >= 0; j--) if (open[j].exitT <= t) { cash += open[j].units * open[j].px * (1 - COST); open.splice(j, 1); }
    let eq = cash + open.reduce((p, o) => p + o.units * (priceAt(o.s, t) ?? o.entry), 0);
    for (; e < ev.length && ev[e].t <= t; e++) {
      const x = ev[e];
      if (open.length >= MAXPOS || open.some((o) => o.s === x.s)) { skipped++; continue; }
      const size = Math.min(CAP * eq, RISK * eq / x.dist, cash);
      if (size <= 0) { skipped++; continue; }
      cash -= size; open.push({ ...x, units: (size * (1 - COST)) / x.entry }); taken++;
    }
    eq = cash + open.reduce((p, o) => p + o.units * (priceAt(o.s, t) ?? o.entry), 0);
    pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1);
  }
  const eq = cash + open.reduce((p, o) => p + o.units * (priceAt(o.s, now) ?? o.entry), 0);
  return { r: eq - 1, dd, taken, skipped };
}
// BTC/ETH rotation with the light on the same days (daily, next-open fills).
function rotation() {
  const em = new Map(ethD.t.map((t, i) => [t, i])); let e2 = null; const up = btcD.t.map((t, i) => { const j = em.get(t); if (j == null) return false; const r = ethD.c[j] / btcD.c[i]; e2 = e2 == null ? r : e2 + (2 / 51) * (r - e2); return r > e2; });
  let pos = false; let hold = 'cash'; let eq = 1; let pk = 1; let dd = 0;
  const i0 = btcD.t.findIndex((t) => t >= testFrom);
  for (let i = i0 + 1; i < btcD.t.length; i++) {
    const n = lightN[i - 1]; if (!pos && n === 2) pos = true; else if (pos && n === 0) pos = false;
    const want = pos ? (up[i - 1] ? 'ETH' : 'BTC') : 'cash';
    if (want !== hold) { eq *= 1 - COST * (hold === 'cash' || want === 'cash' ? 1 : 2); hold = want; }
    if (hold !== 'cash') { const b = hold === 'BTC' ? btcD : ethD; const j = hold === 'BTC' ? i : em.get(btcD.t[i]); eq *= b.c[j] / b.o[j]; const jn = hold === 'BTC' ? i + 1 : em.get(btcD.t[i + 1]); if (jn != null && jn < b.t.length) eq *= b.o[jn] / b.c[j]; }
    pk = Math.max(pk, eq); dd = Math.min(dd, eq / pk - 1);
  }
  return { r: eq - 1, dd };
}
console.log('\nPortefeuille réel (capital unique, max 5 ouverts, risque 1 %/trade)');
for (const mode of ['fixed', 'atr']) {
  for (const [lab, f] of [['tous les signaux', () => true], ['seulement feu 🟢', (x) => x.light === 2]]) {
    const p = portfolio(trades[mode].filter(f));
    console.log(`  ${mode.padEnd(5)} · ${lab.padEnd(17)} ${pc(p.r).padStart(7)} · max DD ${pc(p.dd).padStart(6)} · ${p.taken} pris, ${p.skipped} ignorés (5 déjà ouverts)`);
  }
}
const rt = rotation();
console.log(`  Rotation BTC/ETH au feu (même période)   ${pc(rt.r).padStart(7)} · max DD ${pc(rt.dd).padStart(6)}`);
console.log(`  BTC gardé                                ${pc(btcD.c[btcD.c.length - 1] / btcD.c[btcD.t.findIndex((t) => t >= testFrom)] - 1).padStart(7)}`);
