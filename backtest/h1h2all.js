// Every Bybit spot USDT token listed before Hausse 1: did the ones that rose in Hausse 1 rise in Hausse 2?
// Wave change = close of the last day / open of the first day. Also the max gain inside the wave.
// Only tokens still trading today (delisted ones are missing: survivorship). Run: node backtest/h1h2all.js
import { bybitGet } from '../src/lib/bybit.js';
import { range } from './data.js';

const DAY = 86_400_000;
const H1 = [Date.parse('2026-03-02'), Date.parse('2026-05-26')];
const H2 = [Date.parse('2026-07-01'), Date.parse('2026-09-21')];
const STABLE = /^(USDC|USDE|USDD|FDUSD|PYUSD|RLUSD|USD1|DAI|TUSD|USDQ|USDR|EURC|EUR|XAUT|PAXG|BUSD|USDP|USTC|GHO|CRVUSD|FRAX|LUSD|USDS|USDG|SUSDE|USDA|USD0|AUSD)USDT$/;

const ins = (await bybitGet('instruments-info', { category: 'spot', limit: '1000' })).list || [];
const syms = ins.filter((x) => x.quoteCoin === 'USDT' && x.status === 'Trading').map((x) => x.symbol).filter((s) => !STABLE.test(s));
console.error(`${syms.length} spot USDT tokens`);

const wave = (b, [a, z]) => {
  const i0 = b.t.findIndex((t) => t >= a); let i1 = -1; for (let i = 0; i < b.t.length; i++) if (b.t[i] < z) i1 = i;
  if (i0 < 0 || i1 <= i0 || b.t[i0] > a + 2 * DAY) return null; // must exist at the wave start
  let hi = 0; for (let i = i0; i <= i1; i++) hi = Math.max(hi, b.h[i]);
  return { chg: b.c[i1] / b.o[i0] - 1, max: hi / b.o[i0] - 1 };
};
const rows = []; let n = 0;
for (const s of syms) {
  let b; try { b = await range(s, 'D', H1[0] - 5 * DAY); } catch { continue; }
  if (++n % 100 === 0) console.error(`${n}/${syms.length}`);
  const w1 = wave(b, H1); const w2 = wave(b, H2);
  if (w1 && w2) rows.push({ s, w1, w2 });
}
const pc = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const med = (a) => { const v = [...a].sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };
const btc = rows.find((r) => r.s === 'BTCUSDT');
const alts = rows.filter((r) => !['BTCUSDT', 'ETHUSDT'].includes(r.s));
console.log(`\n${syms.length} tokens spot USDT sur Bybit · ${alts.length} alts présents dans les 2 hausses`);
if (btc) console.log(`BTC : Hausse 1 ${pc(btc.w1.chg)} · Hausse 2 ${pc(btc.w2.chg)}`);
const show = (name, g) => {
  const up = g.filter((r) => r.w2.chg > 0).length; const beat = btc ? g.filter((r) => r.w2.chg > btc.w2.chg).length : 0;
  console.log(`${name.padEnd(36)} ${String(g.length).padStart(4)} tokens · montés en H2 ${String(Math.round((100 * up) / g.length)).padStart(3)}% · mieux que BTC en H2 ${String(Math.round((100 * beat) / g.length)).padStart(3)}% · H2 médian ${pc(med(g.map((r) => r.w2.chg)))} · max H2 médian ${pc(med(g.map((r) => r.w2.max)))}`);
};
console.log('\nSelon la Hausse 1 (variation début → fin) :');
show('montés en H1', alts.filter((r) => r.w1.chg > 0));
show('baissés en H1', alts.filter((r) => r.w1.chg <= 0));
console.log('\nPar tranche de H1 :');
show('H1 ≥ +100 %', alts.filter((r) => r.w1.chg >= 1));
show('H1 +30 % à +100 %', alts.filter((r) => r.w1.chg >= 0.3 && r.w1.chg < 1));
show('H1 0 à +30 %', alts.filter((r) => r.w1.chg > 0 && r.w1.chg < 0.3));
show('H1 −30 % à 0', alts.filter((r) => r.w1.chg <= 0 && r.w1.chg > -0.3));
show('H1 < −30 %', alts.filter((r) => r.w1.chg <= -0.3));
console.log('\nSelon le max atteint en Hausse 1 :');
show('max H1 ≥ +50 %', alts.filter((r) => r.w1.max >= 0.5));
show('max H1 < +50 %', alts.filter((r) => r.w1.max < 0.5));
console.log(`\nTous les alts                          ${alts.length} · montés en H2 ${Math.round((100 * alts.filter((r) => r.w2.chg > 0).length) / alts.length)}%`);
