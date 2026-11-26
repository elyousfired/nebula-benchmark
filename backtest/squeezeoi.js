// "Short squeeze" setup seen on MMT (17/11), tested on the top 300 alts that have a Bybit perp, 4H bars.
// Signal on a closed 4H bar i (all must hold):
//   A. small token in the perps: open interest <= $3M
//   B. price was falling (7-day change <= 0 one day ago) and now turns up: +5 % or more over the last 24 h
//   C. shorts are opening into the rise: last funding < 0 and open interest +15 % or more over 24 h
// Outcome from the next 4H open, over 7 days: max gain, gain at 7 days, and a $10 trade
// (stop -12 %, trailing 15 % once +20 %, 7 days max, cost 0.15 %/side). Compared with A+B only and A only.
// Data cached for good in backtest/cache/flow_{SYMBOL}.json. Run: node backtest/squeezeoi.js
import fs from 'node:fs';
import path from 'node:path';
import { fetchTickers } from '../src/lib/bybit.js';
import { selectUniverse } from '../src/core/universe.js';
import { CACHE } from './data.js';
import * as by from '../../nebula-core/src/cex/bybit.js';

const H4 = 4 * 3_600_000; const DAY = 86_400_000;
const START = Date.parse('2026-02-20'); const T0 = Date.parse('2026-03-02');
const WRAP = /^(BTC|ETH|WBTC|WETH|STETH|WSTETH|METH|BBSOL|CBBTC|WBETH|CMETH|JITOSOL|MSOL|BNSOL|SOLVBTC|LBTC|USDE|USDD|FDUSD|PYUSD|RLUSD|USD1|XAUT|PAXG)USDT$/;

async function flow(s) {
  const file = path.join(CACHE, `flow_${s}.json`);
  let c = null; try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none */ }
  const from = c ? c.end - 2 * DAY : START; const end = Date.now();
  if (c && end - c.end < 6 * 3_600_000) return c;
  const [k, oi, f] = await Promise.all([
    by.klinesRange(s, '4h', { category: 'linear', start: from, end }),
    by.openInterestRange(s, { interval: '4h', start: from, end }),
    by.fundingHistory(s, { start: from, end }),
  ]);
  const merge = (a = [], b) => [...new Map([...a, ...b].map((x) => [x.t, x])).values()].sort((x, y) => x.t - y.t);
  c = { end, k: merge(c?.k, k), oi: merge(c?.oi, oi), f: merge(c?.f, f) };
  fs.writeFileSync(file, JSON.stringify(c));
  return c;
}

const perps = new Set((await by.instruments('linear')).filter((x) => x.status === 'Trading' && x.quoteCoin === 'USDT').map((x) => x.symbol));
const alts = selectUniverse(await fetchTickers(), { limit: 340 }).map((t) => t.symbol).filter((s) => !WRAP.test(s)).slice(0, 300).filter((s) => perps.has(s));
console.error(`${alts.length} alts with a perp`);

const sig = { ABC: [], AB: [], A: [] };
let done = 0;
for (const s of alts) {
  let d; try { d = await flow(s); } catch (e) { console.error(s, e.message); continue; }
  if (++done % 25 === 0) console.error(`${done}/${alts.length}`);
  const k = d.k; const n = k.length; if (n < 60) continue;
  const O = new Map(d.oi.map((x) => [x.t, x.oi]));
  const fundAt = (t) => { let r = null; for (const x of d.f) { if (x.t > t) break; r = x.rate; } return r; };
  const last = { ABC: -1e15, AB: -1e15, A: -1e15 };
  for (let i = 48; i < n - 1; i++) {
    const t = k[i].t + H4; if (t < T0) continue; // bar close time
    const oi = O.get(k[i].t); const oi6 = O.get(k[i - 6].t); if (!oi || !oi6) continue;
    const A = oi * k[i].c <= 3e6;
    const B = k[i - 6].c / k[i - 48].c - 1 <= 0 && k[i].c / k[i - 6].c - 1 >= 0.05;
    const fu = fundAt(t);
    const C = fu != null && fu < 0 && oi / oi6 - 1 >= 0.15;
    const out = () => {
      const e = k[i + 1].o; let stop = e * 0.88; let peak = e; let px = null; let max = 0; let ret7 = null;
      for (let j = i + 1; j < n && k[j].t < k[i + 1].t + 7 * DAY; j++) {
        max = Math.max(max, k[j].h / e - 1); ret7 = k[j].c / e - 1;
        if (px == null) {
          if (k[j].l <= stop) px = Math.min(stop, k[j].o);
          else { peak = Math.max(peak, k[j].h); if (peak >= e * 1.2) stop = Math.max(stop, peak * 0.85); }
        }
      }
      if (px == null) px = e * (1 + ret7);
      return { s, t, max, ret7, usd: 10 * ((px * 0.9985) / (e * 1.0015) - 1), oiM: (oi * k[i].c) / 1e6, fu };
    };
    // one signal per token per 3 days and per variant
    for (const [name, ok] of [['ABC', A && B && C], ['AB', A && B], ['A', A]]) {
      if (ok && t - last[name] >= 3 * DAY && (name !== 'A' || i % 6 === 0)) { sig[name].push(out()); last[name] = t; }
    }
  }
}

if (process.argv.includes('--short')) {
  // Short trades on spot 1H bars from the signal close: take profit TP, stop -8 %, max H hours.
  // If TP and stop are both inside the same hour, the stop is counted (worst case). Cost 0.15 %/side.
  const { range } = await import('./data.js');
  const bars = new Map();
  const get1h = async (s) => { if (!bars.has(s)) { try { bars.set(s, await range(s, '60', T0 - 2 * DAY)); } catch { bars.set(s, null); } } return bars.get(s); };
  const run = async (g, tp, hmax, stopPct = 0.08) => {
    let usd = 0; let w = 0; let l = 0; let nTp = 0; let nSt = 0; let nT = 0; let n = 0;
    for (const x of g) {
      const b = await get1h(x.s); if (!b) continue;
      const i0 = b.t.findIndex((t) => t >= x.t); if (i0 < 0) continue;
      const e = b.o[i0]; let px = null;
      for (let j = i0; j < b.t.length && j < i0 + hmax; j++) {
        if (b.l[j] <= e * (1 - stopPct)) { px = e * (1 - stopPct); nSt++; break; }
        if (b.h[j] >= e * (1 + tp)) { px = e * (1 + tp); nTp++; break; }
      }
      if (px == null) { const j = Math.min(b.t.length - 1, i0 + hmax - 1); px = b.c[j]; nT++; }
      const r = 10 * ((px * 0.9985) / (e * 1.0015) - 1); usd += r; if (r > 0) w += r; else l -= r; n++;
    }
    return `${String(n).padStart(4)} tr · TP touché ${n ? Math.round((100 * nTp) / n) : 0}% · stop ${n ? Math.round((100 * nSt) / n) : 0}% · fin du temps ${n ? Math.round((100 * nT) / n) : 0}% · ${(usd >= 0 ? '+' : '') + usd.toFixed(1).padStart(6)} $ · PF ${l ? (w / l).toFixed(2) : '—'}`;
  };
  console.log(`\nSORTIE COURTE · stop -8 % · bougies 1H spot · 10 $ par signal`);
  for (const [name, g] of [['A+B+C', sig.ABC], ['A+B  ', sig.AB]]) {
    for (const h of [24, 48]) for (const tp of [0.10, 0.15, 0.20]) console.log(`${name} · ${String(h).padStart(2)}h · TP +${tp * 100}%  ${await run(g, tp, h)}`);
    console.log('');
  }
  process.exit(0);
}
const pc = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const med = (a) => { const v = [...a].sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : 0; };
const line = (g) => {
  const w = g.filter((x) => x.usd > 0).reduce((a, x) => a + x.usd, 0); const l = -g.filter((x) => x.usd <= 0).reduce((a, x) => a + x.usd, 0);
  return `${String(g.length).padStart(5)} sig · max 7j médian ${pc(med(g.map((x) => x.max)))} · ≥ +30 % : ${g.length ? Math.round((100 * g.filter((x) => x.max >= 0.3).length) / g.length) : 0}% · à 7j médian ${pc(med(g.map((x) => x.ret7 ?? 0)))} · trade 10 $ : ${(w - l >= 0 ? '+' : '') + (w - l).toFixed(1)} $ PF ${l ? (w / l).toFixed(2) : '—'}`;
};
console.log(`\nSHORT SQUEEZE · ${done} alts avec perp · depuis ${new Date(T0).toISOString().slice(0, 10)} · bougies 4H`);
console.log(`A seul (OI ≤ 3 M$, base de comparaison)   ${line(sig.A)}`);
console.log(`A + B (petit OI + ça remonte +5 %/24h)    ${line(sig.AB)}`);
console.log(`A + B + C (+ funding < 0, OI +15 %/24h)   ${line(sig.ABC)}`);
console.log('\nSignaux A+B+C :');
[...sig.ABC].sort((a, b) => a.t - b.t).forEach((x) => console.log(`  ${x.s.replace('USDT', '').padEnd(10)} ${new Date(x.t).toISOString().slice(0, 13)} OI ${x.oiM.toFixed(1)}M$ funding ${(x.fu * 100).toFixed(3)}% · max 7j ${pc(x.max)} · à 7j ${pc(x.ret7 ?? 0)} · ${x.usd >= 0 ? '+' : ''}${x.usd.toFixed(2)} $`));
