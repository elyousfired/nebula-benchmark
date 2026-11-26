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
    // trade entered at the open of bar e (e = k+1 normally, later for the waiting filters)
    const sim = (e) => {
      if (e >= n) return null;
      const entry = b.o[e]; let stop = Math.max(b.l[k], entry * 0.88); let peak = entry; let exit = null;
      if (entry <= stop) stop = entry * 0.88;
      for (let j = e; j < n; j++) {
        if (b.o[j] <= stop && j > e) { exit = { j, px: b.o[j], why: stop > entry ? 'trailing' : 'stop' }; break; }
        if (b.l[j] <= stop) { exit = { j, px: Math.min(stop, b.o[j]), why: stop > entry ? 'trailing' : 'stop' }; break; }
        peak = Math.max(peak, b.h[j]);
        if (peak >= entry * 1.2) stop = Math.max(stop, peak * 0.85);
        if (b.t[j] + HOUR >= b.t[e] + 7 * DAY) { exit = { j, px: b.c[j], why: '7 jours' }; break; }
      }
      if (!exit) exit = { j: n - 1, px: b.c[n - 1], why: 'ouvert' };
      const ret = (exit.px * (1 - COST)) / (entry * (1 + COST)) - 1;
      return { s, t: b.t[e], light: light(b.t[e]), entry, ret, usd: BET * ret, why: exit.why, hours: exit.j - e + 1, max: peak / entry - 1, j: exit.j };
    };
    const base = sim(k + 1); if (!base) continue;
    // features of the signal, known at the close of k (or later for the waiting filters)
    const avg = vs / 168; const mid = (b.o[k] + b.c[k]) / 2;
    let m30 = 0; for (let j = k - 720; j < k; j++) m30 += b.c[j]; m30 /= 720;
    const f = {
      wick: (b.c[k] - b.l[k]) / (b.h[k] - b.l[k] || 1) >= 0.75, // F2 close in the top quarter
      cap: b.c[k] / b.o[k] - 1 <= 0.25, // F4 candle <= +25 %
      trend: b.c[k - 1] > m30, // F5 above its 30-day mean before the candle
      vol2: k + 1 < n && b.q[k + 1] >= 3 * avg, // F3 next hour volume >= 3x (entry k+2)
      conf: k + 3 < n && b.c[k + 1] >= mid && b.c[k + 2] >= mid, // F1 2 hours holding the middle (entry k+3)
    };
    trades.push({ ...base, f, vol2T: f.vol2 ? sim(k + 2) : null, confT: f.conf ? sim(k + 3) : null, allT: f.conf && f.vol2 && f.wick && f.cap && f.trend ? sim(k + 3) : null });
    busyUntil = base.j;
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
if (process.argv.includes('--filters')) {
  const VARS = [
    ['Base (sans filtre)', trades],
    ['F1 confirmation 2h (entrée h+3)', trades.map((x) => x.confT).filter(Boolean)],
    ['F2 clôture en haut de la bougie', trades.filter((x) => x.f.wick)],
    ['F3 volume h+1 ≥ 3x (entrée h+2)', trades.map((x) => x.vol2T).filter(Boolean)],
    ['F4 bougie ≤ +25 %', trades.filter((x) => x.f.cap)],
    ['F5 au-dessus moyenne 30 j', trades.filter((x) => x.f.trend)],
    ['F2+F4+F5 (entrée h+1)', trades.filter((x) => x.f.wick && x.f.cap && x.f.trend)],
    ['Les 5 ensemble (entrée h+3)', trades.map((x) => x.allT).filter(Boolean)],
  ];
  const usd = (g) => g.reduce((a, x) => a + x.usd, 0);
  const pf = (g) => { const w = g.filter((x) => x.usd > 0).reduce((a, x) => a + x.usd, 0); const l = -g.filter((x) => x.usd <= 0).reduce((a, x) => a + x.usd, 0); return l ? (w / l).toFixed(2) : '∞'; };
  console.log(`\nFILTRES · ${done} alts · 10 $ par signal · total puis par vague (H1 / B1 / H2 / B2)`);
  for (const lt of [['sans feu', () => true], ['feu 🟡/🟢', (x) => x.light >= 1]]) {
    console.log(`\n== ${lt[0]} ==`);
    for (const [name, g0] of VARS) {
      const g = g0.filter(lt[1]); const win = g.filter((x) => x.usd > 0).length;
      const fast = g.filter((x) => x.why === 'stop' && x.hours <= 24).length;
      const waves = WAVES.map((w) => { const h = g.filter((x) => x.t >= w.a && x.t < w.b); return `${usd(h) >= 0 ? '+' : ''}${usd(h).toFixed(0)}$`; }).join(' / ');
      console.log(`${name.padEnd(34)} ${String(g.length).padStart(4)} tr · ${String(g.length ? Math.round((win / g.length) * 100) : 0).padStart(2)}% gagn · ${(usd(g) >= 0 ? '+' : '') + usd(g).toFixed(1).padStart(6)} $ · PF ${pf(g)} · stop<24h ${g.length ? Math.round((fast / g.length) * 100) : 0}% · ${waves}`);
    }
  }
  process.exit(0);
}
console.log(`\nEXPLOSION ·${done} alts (top ${N} actuel) · volume ≥ ${VOL}x · bougie ≥ ${pc(MOVE)} · 10 $ par signal`);
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
