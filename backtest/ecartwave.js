// Does a positive écart in a BTC down wave predict a positive écart in the next up wave?
// Baisse 1 (2026-05-26 -> 07-01) vs Hausse 2 (07-01 -> 09-21). Amplification = daily beta
// over Hausse 1 only (out of sample for both). Whole universe with data before Hausse 1
// (not the followers list). Run: node backtest/ecartwave.js
import { bybitGet } from '../src/lib/bybit.js';
import { selectUniverse } from '../src/core/universe.js';
import { range } from './data.js';

const T = (s) => Date.parse(`${s}T00:00:00Z`);
const H1 = [T('2026-03-02'), T('2026-05-26')]; const B1 = [H1[1], T('2026-07-01')]; const H2 = [B1[1], T('2026-09-21')];
const at = (b, t) => { const i = b.t.indexOf(t); return i >= 0 ? b.c[i] : null; };
const ret = (b, [a, z]) => { const p0 = at(b, a); const p1 = at(b, z); return p0 && p1 ? p1 / p0 - 1 : null; };
function beta(b, btc, [a, z]) {
  const x = []; const y = [];
  for (let i = 1; i < btc.t.length; i++) {
    const t = btc.t[i]; if (t <= a || t > z) continue;
    const p = at(b, t); const q = at(b, btc.t[i - 1]); if (!p || !q) continue;
    x.push(btc.c[i] / btc.c[i - 1] - 1); y.push(p / q - 1);
  }
  if (x.length < 40) return null;
  const mx = x.reduce((s, v) => s + v, 0) / x.length; const my = y.reduce((s, v) => s + v, 0) / y.length;
  let c = 0; let v = 0; for (let i = 0; i < x.length; i++) { c += (x[i] - mx) * (y[i] - my); v += (x[i] - mx) ** 2; }
  return c / v;
}
const rank = (a) => { const s = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = []; s.forEach(([, i], k) => { r[i] = k; }); return r; };
const spearman = (a, b) => { const ra = rank(a); const rb = rank(b); const n = a.length; let d = 0; for (let i = 0; i < n; i++) d += (ra[i] - rb[i]) ** 2; return 1 - (6 * d) / (n * (n * n - 1)); };
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const med = (a) => { const s = [...a].sort((p, q) => p - q); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pc = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

const tickers = (await bybitGet('tickers', { category: 'spot' })).list;
const uni = selectUniverse(tickers, { limit: 500 }).map((t) => t.symbol).filter((s) => s !== 'BTCUSDT');
const btc = await range('BTCUSDT', 'D', H1[0] - 86400000);
const bH1 = ret(btc, H1); const bB1 = ret(btc, B1); const bH2 = ret(btc, H2);
const rows = [];
for (const s of uni) {
  let b; try { b = await range(s, 'D', H1[0] - 86400000); } catch { continue; }
  if (!b.t.length || b.t[0] > H1[0]) continue; // needs data before Hausse 1
  const be = beta(b, btc, H1); const rB = ret(b, B1); const rH = ret(b, H2);
  if (be == null || rB == null || rH == null) continue;
  rows.push({ s, be, eB: rB - be * bB1, eH: rH - be * bH2, rH });
}
rows.sort((a, b) => b.eB - a.eB);
const n = rows.length; const k = Math.floor(n / 3);
const groups = [['Haut (écart B1 le + fort)', rows.slice(0, k)], ['Milieu', rows.slice(k, n - k)], ['Bas', rows.slice(n - k)]];
console.log(`BTC: Hausse1 ${pc(bH1)} · Baisse1 ${pc(bB1)} · Hausse2 ${pc(bH2)} · ${n} tokens`);
for (const [name, g] of groups) {
  console.log(`${name.padEnd(26)} n=${g.length}  écart B1 moy ${pc(mean(g.map((r) => r.eB)))} | H2 écart moy ${pc(mean(g.map((r) => r.eH)))} méd ${pc(med(g.map((r) => r.eH)))} | H2 brut moy ${pc(mean(g.map((r) => r.rH)))} méd ${pc(med(g.map((r) => r.rH)))} | H2 écart>0 ${Math.round(100 * g.filter((r) => r.eH > 0).length / g.length)}%`);
}
console.log(`Spearman(écart B1, écart H2) = ${spearman(rows.map((r) => r.eB), rows.map((r) => r.eH)).toFixed(2)} · (écart B1, brut H2) = ${spearman(rows.map((r) => r.eB), rows.map((r) => r.rH)).toFixed(2)}`);
console.log('Top 10 écart B1:', rows.slice(0, 10).map((r) => `${r.s.replace('USDT', '')} ${pc(r.eB)}→${pc(r.eH)}`).join(' | '));
