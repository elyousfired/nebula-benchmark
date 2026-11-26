// "Explosion" system on the top 300 alts, $10 per signal, in our waves.
// Signal (closed 1H candle): volume >= 5x its 7-day hourly mean, candle >= +8 %, close above
// the 7-day high, token listed for >= 30 days. Entry: open of the next hour.
// Exit: stop = max(signal candle low, entry -12 %); once +20 %, trailing 15 % under the peak; 7 days max.
// Cost 0.15 %/side. One position per token at a time. Compared with and without the BTC light.
// Run: node backtest/explosion.js [--vol 5] [--move 0.08]
import { fetchTickers } from '../src/lib/bybit.js';
import { selectUniverse } from '../src/core/universe.js';
import { HOUR, DAY } from '../src/core/bars.js';
import { range } from './data.js';
import { lightAt } from '../../nebula-top50-agent/agent/btclight.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const VOL = arg('vol', 5); const MOVE = arg('move', 0.08); const N = arg('n', 300);
const COST = 0.0015; const BET = 10;
const WAVES = [['Hausse 1', '2026-03-02', '2026-05-26'], ['Baisse 1', '2026-05-26', '2026-07-01'], ['Hausse 2', '2026-07-01', '2026-09-21'], ['Baisse 2', '2026-09-21', null]]
  .map(([n, a, b]) => ({ n, a: Date.parse(a), b: b ? Date.parse(b) : Date.now() }));
const START = WAVES[0].a;
const WRAP = /^(BTC|ETH|WBTC|WETH|STETH|WSTETH|METH|BBSOL|CBBTC|WBETH|CMETH|JITOSOL|MSOL|BNSOL|SOLVBTC|LBTC|USDE|USDD|FDUSD|PYUSD|RLUSD|USD1|XAUT|PAXG)USDT$/;

const btcD = await range('BTCUSDT', 'D', START - 300 * DAY);
const lightOf = (t) => { let i = -1; for (let k = 0; k < btcD.t.length; k++) if (btcD.t[k] + DAY <= t) i = k; return i >= 60 ? lightAt(btcD, i).n : null; };
const lightCache = new Map(); const light = (t) => { const d = Math.floor(t / DAY); if (!lightCache.has(d)) lightCache.set(d, lightOf(d * DAY)); return lightCache.get(d); };

const alts = selectUniverse(await fetchTickers(), { limit: N + 40 }).map((t) => t.symbol).filter((s) => !WRAP.test(s)).slice(0, N);
const trades = [];
let done = 0;
for (const s of alts) {
  let b; try { b = await range(s, '60', START - 40 * DAY); } catch { continue; }
  if (++done % 25 === 0) console.error(`${done}/${alts.length}`);
  const n = b.t.length; if (n < 900) continue;
  let busyUntil = -1;
  for (let k = 720; k < n - 1; k++) {
    const t = b.t[k]; if (t < START || k <= busyUntil) continue;
    if (b.c[k] / b.o[k] - 1 < MOVE) continue;
    let vs = 0; let hi = 0; for (let j = k - 168; j < k; j++) { vs += b.q[j]; hi = Math.max(hi, b.h[j]); }
    if (!(b.q[k] >= VOL * (vs / 168)) || b.c[k] <= hi) continue;
    // trade
    const entry = b.o[k + 1]; let stop = Math.max(b.l[k], entry * 0.88); let peak = entry; let exit = null;
    for (let j = k + 1; j < n; j++) {
      if (b.o[j] <= stop && j > k + 1) { exit = { j, px: b.o[j], why: 'stop' }; break; }
      if (b.l[j] <= stop) { exit = { j, px: Math.min(stop, b.o[j]), why: stop > entry ? 'trailing' : 'stop' }; break; }
      peak = Math.max(peak, b.h[j]);
      if (peak >= entry * 1.2) stop = Math.max(stop, peak * 0.85);
      if (b.t[j] + HOUR >= b.t[k + 1] + 7 * DAY) { exit = { j, px: b.c[j], why: '7 jours' }; break; }
    }
    if (!exit) { exit = { j: n - 1, px: b.c[n - 1], why: 'ouvert' }; }
    const ret = (exit.px * (1 - COST)) / (entry * (1 + COST)) - 1;
    trades.push({ s, t: b.t[k + 1], light: light(b.t[k + 1]), entry, ret, usd: BET * ret, why: exit.why, hours: exit.j - k, max: peak / entry - 1, candle: b.c[k] / b.o[k] - 1, vx: b.q[k] / (vs / 168) });
    busyUntil = exit.j;
  }
}

const pc = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const stat = (g) => {
  if (!g.length) return '0 trades';
  const gain = g.filter((x) => x.usd > 0).reduce((a, x) => a + x.usd, 0); const loss = -g.filter((x) => x.usd <= 0).reduce((a, x) => a + x.usd, 0);
  const fast = g.filter((x) => x.why === 'stop' && x.hours <= 24).length;
  const win = g.filter((x) => x.usd > 0);
  return `${String(g.length).padStart(4)} trades · ${String(Math.round((win.length / g.length) * 100)).padStart(3)}% gagnants · ${(gain - loss >= 0 ? '+' : '') + (gain - loss).toFixed(2)} $ · PF ${loss ? (gain / loss).toFixed(2) : '∞'} · stop en <24h ${Math.round((fast / g.length) * 100)}% · gain moyen des gagnants ${win.length ? pc(win.reduce((a, x) => a + x.ret, 0) / win.length) : '—'}`;
};
console.log(`\nEXPLOSION · ${done} alts (top ${N} actuel) · volume ≥ ${VOL}x · bougie ≥ ${pc(MOVE)} · 10 $ par signal`);
for (const w of WAVES) {
  const g = trades.filter((x) => x.t >= w.a && x.t < w.b);
  console.log(`\n${w.n} (${new Date(w.a).toISOString().slice(0, 10)} → ${new Date(w.b).toISOString().slice(0, 10)})`);
  console.log(`  sans feu   : ${stat(g)}`);
  console.log(`  feu 🟡/🟢  : ${stat(g.filter((x) => x.light >= 1))}`);
  console.log(`  feu 🔴     : ${stat(g.filter((x) => x.light === 0))}`);
}
console.log(`\nTOTAL sans feu : ${stat(trades)}`);
console.log(`TOTAL 🟡/🟢    : ${stat(trades.filter((x) => x.light >= 1))}`);
console.log(`TOTAL 🔴       : ${stat(trades.filter((x) => x.light === 0))}`);
const why = {}; trades.forEach((x) => { why[x.why] = (why[x.why] || 0) + 1; }); console.log('sorties :', JSON.stringify(why));
console.log('\nMeilleurs :'); [...trades].sort((a, b) => b.ret - a.ret).slice(0, 8).forEach((x) => console.log(`  ${x.s.replace('USDT', '').padEnd(9)} ${new Date(x.t).toISOString().slice(0, 13)} ${['🔴', '🟡', '🟢'][x.light] ?? '?'} ${pc(x.ret)} (max ${pc(x.max)}, ${x.why})`));
console.log('Pires :'); [...trades].sort((a, b) => a.ret - b.ret).slice(0, 5).forEach((x) => console.log(`  ${x.s.replace('USDT', '').padEnd(9)} ${new Date(x.t).toISOString().slice(0, 13)} ${pc(x.ret)} (${x.why}, ${x.hours}h)`));
const mmt = trades.filter((x) => x.s === 'MMTUSDT'); if (mmt.length) console.log('MMT :', mmt.map((x) => `${new Date(x.t).toISOString().slice(5, 13)} ${pc(x.ret)} ${x.why}`).join(' | '));
