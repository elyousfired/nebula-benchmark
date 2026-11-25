// Out-of-sample followers: pick them with Hausse 1 + Baisse 1 only, then measure an
// equal-weight basket vs BTC in Hausse 2 and Baisse 2 (return, max drawdown, ret/DD).
// With one wave of each kind HH/HL cannot be checked, so the pick = fidelity (up in H1,
// down in B1); also the top 20 by asymmetry. Run: node backtest/followersoos.js
import { bybitGet } from '../src/lib/bybit.js';
import { selectUniverse } from '../src/core/universe.js';
import { tokenSwings, waveScores } from '../src/core/btcswings.js';
import { range } from './data.js';

const DAY = 86400000; const T = (s) => Date.parse(`${s}T00:00:00Z`);
const W = [['Hausse 1', 'up', '2026-03-02', '2026-05-26'], ['Baisse 1', 'down', '2026-05-26', '2026-07-01'], ['Hausse 2', 'up', '2026-07-01', '2026-09-21'], ['Baisse 2', 'down', '2026-09-21', null]];
const now = Date.now(); const last = Math.floor(now / DAY) * DAY - DAY;
const waves = W.map(([name, kind, s, e]) => ({ name, kind, t0: T(s) - DAY, t1: e ? T(e) : last }));
const pick = waves.slice(0, 2);
const pc = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

const tickers = (await bybitGet('tickers', { category: 'spot' })).list;
const uni = selectUniverse(tickers, { limit: 500 }).map((t) => t.symbol).filter((s) => s !== 'BTCUSDT');
const btc = await range('BTCUSDT', 'D', waves[0].t0 - DAY);
const btcMoves = tokenSwings(btc, pick);
const toks = [];
for (const s of uni) {
  let b; try { b = await range(s, 'D', waves[0].t0 - DAY); } catch { continue; }
  if (!b.t.length || b.t[0] > waves[0].t0) continue;
  const moves = tokenSwings(b, pick);
  if (moves.some((m) => !m)) continue;
  const sc = waveScores(pick, moves, btcMoves);
  if (sc.fidelity === 2) toks.push({ s, b, asym: sc.asym ?? 0 });
}
// Equal-weight basket curve over a wave: each token rebased to 1 at t0 (last known close carried).
function curve(list, w) {
  const days = btc.t.filter((t) => t >= w.t0 && t <= w.t1);
  const idx = list.map((x) => new Map(x.b.t.map((t, i) => [t, x.b.c[i]])));
  const base = idx.map((m) => m.get(w.t0));
  const lastP = [...base];
  return days.map((t) => {
    let s = 0; let n = 0;
    idx.forEach((m, j) => { if (!(base[j] > 0)) return; const p = m.get(t); if (p > 0) lastP[j] = p; s += lastP[j] / base[j]; n++; });
    return n ? s / n : 1;
  });
}
const stats = (c) => { let pk = c[0]; let dd = 0; for (const v of c) { pk = Math.max(pk, v); dd = Math.min(dd, v / pk - 1); } const r = c[c.length - 1] / c[0] - 1; return { r, dd, rdd: dd < 0 ? r / -dd : null }; };
const btcCurve = (w) => btc.t.map((t, i) => [t, btc.c[i]]).filter(([t]) => t >= w.t0 && t <= w.t1).map(([, c]) => c);
const line = (name, st) => `${name.padEnd(30)} ${pc(st.r).padStart(8)} | max DD ${pc(st.dd).padStart(7)} | ret/DD ${st.rdd == null ? '—' : st.rdd.toFixed(2)}`;

const top = [...toks].sort((a, b) => b.asym - a.asym).slice(0, 20);
for (const w of waves.slice(2)) {
  console.log(`\n${w.name} (${new Date(w.t0 + DAY).toISOString().slice(0, 10)} → ${new Date(w.t1).toISOString().slice(0, 10)})`);
  console.log(line('BTC', stats(btcCurve(w))));
  console.log(line(`Panier fidèles H1+B1 (${toks.length})`, stats(curve(toks, w))));
  console.log(line('Panier top 20 asymétrie', stats(curve(top, w))));
}
const both = { name: 'H2+B2', t0: waves[2].t0, t1: waves[3].t1 };
console.log(`\nH2 + B2 ensemble`);
console.log(line('BTC', stats(btcCurve(both))));
console.log(line(`Panier fidèles H1+B1 (${toks.length})`, stats(curve(toks, both))));
console.log(line('Panier top 20 asymétrie', stats(curve(top, both))));
console.log('\nTop 20 asymétrie:', top.map((x) => x.s.replace('USDT', '')).join(', '));
