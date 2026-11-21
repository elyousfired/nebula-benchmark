#!/usr/bin/env node
// Backtest of the Launchpad strategy over the last N days (default 30).
//
//   npm run backtest                 30 days
//   npm run backtest -- --days 14    another window
//
// Downloads ~N+31 days of 15m candles for the Bybit spot universe (cached in
// backtest/cache for 6 h), then replays the paper-bot rules step by step with no
// look-ahead. Results in backtest/results/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bybitGet, fetchTickers, pool, setProxy, currentRoute } from '../src/lib/bybit.js';
import { selectUniverse } from '../src/core/universe.js';
import { DEFAULT_CONFIG } from '../bot/engine.js';
import { simulate, rolling24h, Q } from './sim.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, 'cache');
const OUT = path.join(HERE, 'results');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const DAYS = arg('days', 30);
const WARMUP_DAYS = 31; // 30D score + 24H curve
const MOCK = process.env.BOT_MOCK === '1';

// Same overrides as the bot (bot/config.json), plus CLI: --trail 2 --activate 0 --no-tp1 --no-final --stop 2 --final 10
let userCfg = {};
try { userCfg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'bot', 'config.json'), 'utf8')); } catch { /* defaults */ }
const CFG = { ...DEFAULT_CONFIG, ...userCfg };
if (process.argv.includes('--trail')) CFG.trailPct = arg('trail', 0);
if (process.argv.includes('--activate')) CFG.trailActivatePct = arg('activate', 0);
if (process.argv.includes('--stop')) CFG.stopPct = arg('stop', CFG.stopPct);
if (process.argv.includes('--final')) CFG.finalPct = arg('final', CFG.finalPct);
if (process.argv.includes('--no-tp1')) CFG.useTp1 = false;
if (process.argv.includes('--no-final')) CFG.useFinal = false;
const MAX_RANK = arg('max-rank', 50);

setProxy(process.env.BOT_PROXY || 'https://nebula-benchmark.vercel.app/api/bybit');
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

if (MOCK) {
  const { mockBybitResponse } = await import('../dev/mockBybit.js');
  globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => {
    const u = new URL(String(url), 'http://x');
    const end = Number(u.searchParams.get('end')) || Date.now();
    return mockBybitResponse(String(url), Math.min(end, Date.now()));
  } });
}

const log = (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

async function klines15(symbol, fromMs, toMs) {
  const file = path.join(CACHE, `${symbol}.json`);
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c.from <= fromMs && Date.now() - c.fetchedAt < 6 * 3_600_000) return c.rows;
  } catch { /* no cache */ }
  const rows = new Map();
  let end = toMs;
  for (let guard = 0; guard < 20 && end > fromMs; guard++) {
    const r = await bybitGet('kline', { category: 'spot', symbol, interval: '15', limit: '1000', end: String(end) });
    const list = r.list || [];
    if (!list.length) break;
    let oldest = Infinity;
    for (const k of list) {
      const t = Number(k[0]);
      rows.set(t, [t, +k[1], +k[2], +k[3], +k[4], +k[6]]);
      if (t < oldest) oldest = t;
    }
    if (oldest >= end) break;
    end = oldest - 1;
    if (list.length < 1000) break; // listing start reached
  }
  const sorted = [...rows.values()].sort((a, b) => a[0] - b[0]);
  fs.writeFileSync(file, JSON.stringify({ from: fromMs, fetchedAt: Date.now(), rows: sorted }));
  return sorted;
}

const pct = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(d)}%`);
const day = (t) => new Date(t).toISOString().slice(0, 10);

function report(name, res, ctx) {
  const s = res.summary;
  const L = [];
  L.push(`── ${name} ──`);
  L.push(`Trades fermés      : ${s.trades}  (gagnants ${s.wins} / perdants ${s.losses})  win rate ${s.winRate == null ? '—' : `${(s.winRate * 100).toFixed(1)}%`}`);
  L.push(`P&L total          : ${pct(s.totalPct)}   (somme des % par trade, frais 0.1%×2 + spread inclus)`);
  L.push(`Moyenne / trade    : ${pct(s.avgPct, 3)}   gain moyen ${pct(s.avgWinPct)}   perte moyenne ${pct(s.avgLossPct)}`);
  const pf = s.losses && s.avgLossPct ? (s.wins * s.avgWinPct) / Math.abs(s.losses * s.avgLossPct) : null;
  L.push(`Profit factor      : ${pf == null ? '—' : pf.toFixed(2)}     Max drawdown (cumul %) : ${pct(s.maxDrawdownPct)}`);
  L.push(`Sorties            : ${Object.entries(s.byExit).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ') || '—'}`);
  const holds = res.closed.map((t) => t.holdMs / 3_600_000).sort((a, b) => a - b);
  if (holds.length) L.push(`Durée médiane      : ${holds[Math.floor(holds.length / 2)].toFixed(1)} h`);
  if (res.open.length) {
    const m = res.open.reduce((a, p) => a + p.markPct, 0);
    L.push(`Encore ouvertes    : ${res.open.length} (valeur actuelle cumulée ${pct(m)})`);
  }
  L.push(`Signaux ignorés    : chase ${res.skipped.chase} · mur trop proche ${res.skipped.wall} · liquidité ${res.skipped.liquidity} · cooldown ${res.skipped.cooldown}`);
  // weekly split
  const byWeek = {};
  for (const t of res.closed) {
    const w = Math.floor((t.closedAt - ctx.start) / (7 * 86_400_000));
    byWeek[w] = byWeek[w] || { n: 0, sum: 0 };
    byWeek[w].n++;
    byWeek[w].sum += t.pnlPct;
  }
  L.push(`Par semaine        : ${Object.entries(byWeek).map(([w, v]) => `S${+w + 1}: ${v.n} trades ${pct(v.sum)}`).join(' | ') || '—'}`);
  const sorted = [...res.closed].sort((a, b) => b.pnlPct - a.pnlPct);
  if (sorted.length) {
    L.push(`Meilleurs          : ${sorted.slice(0, 5).map((t) => `${t.symbol.replace('USDT', '')} ${pct(t.pnlPct)}`).join(', ')}`);
    L.push(`Pires              : ${sorted.slice(-5).reverse().map((t) => `${t.symbol.replace('USDT', '')} ${pct(t.pnlPct)}`).join(', ')}`);
  }
  return L.join('\n');
}

function writeTrades(file, res) {
  const rows = ['symbol,rank,opened_utc,closed_utc,hold_h,entry,tp1,final,exits,pnl_pct,turnover24h'];
  for (const t of res.closed) {
    rows.push([t.symbol, t.rank, new Date(t.openedAt).toISOString(), new Date(t.closedAt).toISOString(), (t.holdMs / 3_600_000).toFixed(2),
      t.entry, t.tp1 ?? '', t.final, t.fills.map((f) => `${f.reason}@${f.price}x${f.share}`).join(' '), t.pnlPct, Math.round(t.turnover24h)].join(','));
  }
  fs.writeFileSync(file, `${rows.join('\n')}\n`);
}

async function main() {
  const now = Date.now();
  const lastClosedOpen = Math.floor(now / Q) * Q - Q; // open time of the last CLOSED candle
  const start = lastClosedOpen - DAYS * 86_400_000;
  const from = start - WARMUP_DAYS * 86_400_000;

  log(`Backtest Launchpad · ${DAYS} jours · du ${day(start)} au ${day(lastClosedOpen)}`);
  const tickers = await fetchTickers();
  const universe = selectUniverse(tickers, { limit: 500, minTurnover: 10_000 }).map((t) => t.symbol);
  log(`Univers: ${universe.length} paires Bybit spot (+BTC pour référence). Téléchargement des bougies 15m (cache 6 h)…`);

  const raw = {};
  let done = 0;
  const res = await pool([...universe, 'BTCUSDT'], async (s) => {
    raw[s] = await klines15(s, from, lastClosedOpen + Q - 1);
    done++;
    if (done % 50 === 0) log(`  ${done}/${universe.length + 1}`);
  }, { concurrency: 6 });
  const failed = res.filter((r) => r && r.error).length;
  log(`Données OK (${failed} échecs, route ${currentRoute()})`);

  // Grid
  const T = [];
  for (let t = from; t <= lastClosedOpen; t += Q) T.push(t);
  const idx = new Map(T.map((t, i) => [t, i]));
  const tokens = {};
  for (const s of universe) {
    const rows = raw[s];
    if (!rows || rows.length < 200) continue;
    const mk = () => new Float64Array(T.length).fill(NaN);
    const tk = { o: mk(), h: mk(), l: mk(), c: mk(), q: mk() };
    for (const r of rows) {
      const i = idx.get(r[0]);
      if (i == null) continue;
      tk.o[i] = r[1]; tk.h[i] = r[2]; tk.l[i] = r[3]; tk.c[i] = r[4]; tk.q[i] = r[5];
    }
    tk.turn24 = rolling24h(tk.q);
    tokens[s] = tk;
  }
  const startIdx = idx.get(start);
  log(`Simulation sur ${T.length - startIdx} bougies × ${Object.keys(tokens).length} tokens…`);

  const ctx = { start: start + Q };
  const A = simulate({ T, tokens, startIdx, cfg: CFG, maxRank: MAX_RANK });
  const B = simulate({ T, tokens, startIdx, cfg: CFG, minTurnoverEntry: 1_000_000, maxRank: MAX_RANK });

  // References
  const btc = raw.BTCUSDT || [];
  const btcAt = (t) => btc.find((r) => r[0] === t)?.[4];
  const btcRet = btcAt(start) && btcAt(lastClosedOpen) ? ((btcAt(lastClosedOpen) / btcAt(start)) - 1) * 100 : null;
  const rets = Object.values(tokens).map((tk) => (tk.c[startIdx] > 0 && tk.c[T.length - 1] > 0 ? (tk.c[T.length - 1] / tk.c[startIdx] - 1) * 100 : null)).filter((x) => x != null).sort((a, b) => a - b);
  const median = rets.length ? rets[Math.floor(rets.length / 2)] : null;
  const lp = A.levelsLog.map((l) => l.entry).sort((a, b) => a - b);
  const wall = A.levelsLog.map((l) => l.tp).sort((a, b) => a - b);

  const text = [
    '═══════════════ BACKTEST LAUNCHPAD (walk-forward, sans look-ahead) ═══════════════',
    `Période       : ${day(start)} → ${day(lastClosedOpen)} (${DAYS} j) · pas de 15 min · ${Object.keys(tokens).length} tokens`,
    `Règles        : entrée croisement Launchpad 24H (Top ${MAX_RANK} score 30D) · ${CFG.useTp1 === false ? 'pas de TP1' : '50% au mur'} · ${CFG.useFinal === false ? 'pas de target final' : `reste +${CFG.finalPct}%`} · stop -${CFG.stopPct}%${CFG.trailPct ? ` · trailing ${CFG.trailPct}% (activé à +${CFG.trailActivatePct || 0}%)` : ' · stop BE après TP1'} · frais ${CFG.feePct}%/ordre · spread 0.05%`,
    `Niveaux vus   : launchpad médian ${lp.length ? lp[Math.floor(lp.length / 2)] : '—'} pts · mur médian ${wall.length ? wall[Math.floor(wall.length / 2)] : '—'} pts`,
    `Référence     : BTC ${pct(btcRet)} · token médian de l'univers ${pct(median)} sur la période`,
    '',
    report('A · Toutes les entrées (univers ≥ $10K / 24h)', A, ctx),
    '',
    report('B · Entrées liquides seulement (≥ $1M / 24h)', B, ctx),
    '',
    'Limites: univers = paires listées aujourd\'hui (les tokens délistés manquent → biais favorable);',
    'détection toutes les 15 min (le bot réel: 10 s); ordre intra-bougie supposé (verte O→L→H→C, rouge O→H→L→C).',
  ].join('\n');

  console.log(`\n${text}\n`);
  fs.writeFileSync(path.join(OUT, 'summary.txt'), `${text}\n`);
  writeTrades(path.join(OUT, 'trades-A-all.csv'), A);
  writeTrades(path.join(OUT, 'trades-B-liquid.csv'), B);
  log(`Résultats écrits dans ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
