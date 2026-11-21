#!/usr/bin/env node
// Nebula Launchpad — PAPER trading bot (no orders are ever sent, no API key needed).
//
//   npm run bot            start (Ctrl+C to stop; state is saved and resumed)
//   npm run bot:report     print the P&L summary and exit
//
// Uses the same scan, score and 24H Launchpad / Rejection-Wall levels as the site
// (Top 50 by 30D score), then simulates trades with bid/ask prices and fees.
// Rules: see bot/engine.js. Data: bot/data/ (state.json, trades.csv, events.log).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchTickers, fetchKlines, pool, setProxy, currentRoute } from '../src/lib/bybit.js';
import { parseKlines, mergeBars, patchLive, INTERVAL_MS } from '../src/core/bars.js';
import { computeTokenMetrics } from '../src/core/metrics.js';
import { scoreUniverse, topList } from '../src/core/scoring.js';
import { selectUniverse } from '../src/core/universe.js';
import { buildCurves } from '../src/core/curves.js';
import { collectiveLevels, sniperLevels } from '../src/core/levels.js';
import {
  DEFAULT_CONFIG, detectCrossings, openPosition, updatePosition, unrealizedPnlPct, summarize,
} from './engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.BOT_DATA_DIR || path.join(HERE, 'data');
const STATE_FILE = path.join(DATA, 'state.json');
const TRADES_CSV = path.join(DATA, 'trades.csv');
const EVENTS_LOG = path.join(DATA, 'events.log');
const MOCK = process.env.BOT_MOCK === '1';

// Optional overrides in bot/config.json, e.g. { "stopPct": 2, "finalPct": 10 }
let userCfg = {};
try { userCfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8')); } catch { /* defaults */ }
const CFG = { ...DEFAULT_CONFIG, ...userCfg };

const TICK_MS = MOCK ? 2_000 : 10_000; // prices + exits + entries
const TAIL_MS = MOCK ? 2_000 : 5 * 60_000; // last candles
const FULL_MS = 60 * 60_000; // full rescan
const SUMMARY_MS = MOCK ? 20_000 : 60_000;
const UNIVERSE = 500;

setProxy(process.env.BOT_PROXY || 'https://nebula-benchmark.vercel.app/api/bybit');

// ---------- persistence ----------
fs.mkdirSync(DATA, { recursive: true });

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {
    return { open: [], closed: [], prevPts: null, prevPtsAt: 0, cooldown: {}, startedAt: Date.now() };
  }
}
function saveState() {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}
const iso = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
function log(line) {
  const msg = `[${iso(Date.now())}] ${line}`;
  console.log(msg);
  fs.appendFileSync(EVENTS_LOG, `${msg}\n`);
}
function journal(pos) {
  if (!fs.existsSync(TRADES_CSV)) {
    fs.writeFileSync(TRADES_CSV, 'symbol,opened_utc,closed_utc,entry,tp1,final,stop_initial,exits,pnl_pct\n');
  }
  const exits = pos.fills.map((f) => `${f.reason}@${f.price}x${f.share}`).join(' ');
  const row = [pos.symbol, iso(pos.openedAt), iso(pos.closedAt), pos.entry, pos.tp1 ?? '', pos.final, pos.stopInitial, exits, pos.pnlPct];
  fs.appendFileSync(TRADES_CSV, `${row.join(',')}\n`);
}

const state = loadState();

// ---------- report mode ----------
function printSummary(prices = {}) {
  const s = summarize(state.closed);
  const pct = (x) => (x == null ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(2)}%`);
  console.log('\n══════════ NEBULA LAUNCHPAD · PAPER ══════════');
  console.log(`Trades fermés : ${s.trades}   gagnants ${s.wins} / perdants ${s.losses}   win rate ${s.winRate == null ? '—' : `${(s.winRate * 100).toFixed(0)}%`}`);
  console.log(`P&L total     : ${pct(s.totalPct)}  (somme des % par trade, frais inclus)`);
  console.log(`Moyenne/trade : ${pct(s.avgPct)}   gain moyen ${pct(s.avgWinPct)}   perte moyenne ${pct(s.avgLossPct)}`);
  console.log(`Max drawdown  : ${pct(s.maxDrawdownPct)}`);
  if (Object.keys(s.byExit).length) console.log(`Sorties       : ${Object.entries(s.byExit).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  if (state.open.length) {
    console.log(`Positions ouvertes (${state.open.length}) :`);
    for (const p of state.open) {
      const bid = prices[p.symbol];
      const u = bid ? unrealizedPnlPct(p, bid, CFG) : null;
      console.log(`  ${p.symbol.padEnd(14)} entrée ${p.entry}  ${p.tp1Done ? 'TP1 ✔ stop=BE' : `TP1 ${p.tp1 ?? '—'}`}  final ${p.final}  stop ${p.stop}  P&L ${pct(u)}`);
    }
  }
  console.log('═══════════════════════════════════════════════\n');
}

if (process.argv.includes('--report')) {
  printSummary();
  process.exit(0);
}

// ---------- mock mode (offline test with accelerated synthetic market) ----------
if (MOCK) {
  const { mockBybitResponse } = await import('../dev/mockBybit.js');
  const t0 = Date.now();
  const realNow = Date.now.bind(Date);
  const SPEED = 450; // 2 s real = 15 min market
  Date.now = () => t0 + (realNow() - t0) * SPEED;
  globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => mockBybitResponse(String(url), Date.now()) });
  log('MODE MOCK: marché synthétique accéléré (×450)');
}

// ---------- market data ----------
const LEN15 = 100;
const LEN60 = 1000;
let symbols = [];
const series = {};
let tickers = {};

async function loadTickers() {
  const list = await fetchTickers();
  const map = {};
  for (const t of list) map[t.symbol] = t;
  tickers = map;
}

async function fullScan() {
  await loadTickers();
  symbols = selectUniverse(Object.values(tickers), { limit: UNIVERSE }).map((t) => t.symbol);
  // Keep watching symbols we hold even if they left the universe.
  for (const p of state.open) if (!symbols.includes(p.symbol)) symbols.push(p.symbol);
  let done = 0;
  const res = await pool(symbols, async (sym) => {
    const [k15, k60] = await Promise.all([fetchKlines(sym, '15', LEN15), fetchKlines(sym, '60', LEN60)]);
    series[sym] = { bars15: parseKlines(k15), bars60: parseKlines(k60) };
    done++;
    if (done % 100 === 0) process.stdout.write(`  scan ${done}/${symbols.length}\r`);
  }, { concurrency: 6 });
  const failed = res.filter((r) => r && r.error).length;
  log(`Scan complet: ${symbols.length} tokens${failed ? `, ${failed} échecs` : ''} (route ${currentRoute()})`);
}

async function refreshTails() {
  await pool(symbols, async (sym) => {
    const s = series[sym];
    if (!s) return;
    const [k15, k60] = await Promise.all([fetchKlines(sym, '15', 4), fetchKlines(sym, '60', 4)]);
    series[sym] = { bars15: mergeBars(s.bars15, parseKlines(k15), LEN15 + 20), bars60: mergeBars(s.bars60, parseKlines(k60), LEN60) };
  }, { concurrency: 6 });
}

// ---------- strategy tick ----------
const bidOf = (t) => Number(t?.bid1Price) || Number(t?.lastPrice) || null;
const askOf = (t) => Number(t?.ask1Price) || Number(t?.lastPrice) || null;
let lastLevels = null;

function computeSignals(now) {
  const live = {};
  const metrics = [];
  for (const sym of symbols) {
    const s = series[sym];
    if (!s) continue;
    const tk = tickers[sym];
    const price = Number(tk?.lastPrice);
    live[sym] = {
      bars15: patchLive(s.bars15, INTERVAL_MS['15'], price, now),
      bars60: patchLive(s.bars60, INTERVAL_MS['60'], price, now),
    };
    const m = computeTokenMetrics({ symbol: sym, ...live[sym], ticker: tk, now });
    if (m && !m.stale) metrics.push(m);
  }
  const top = topList(scoreUniverse(metrics), 'month', 50, 'score');
  const { curves } = buildCurves(top, live, 'day', now);
  if (!Object.keys(curves).length) return null;
  const levels = sniperLevels(collectiveLevels(curves));
  const pts = {};
  for (const [sym, c] of Object.entries(curves)) pts[sym] = c[c.length - 1].v;
  const ranks = Object.fromEntries(top.map((t) => [t.symbol, t.rank]));
  return { levels, pts, ranks };
}

async function tick() {
  await loadTickers();
  const now = Date.now();

  // 1) Exits on open positions.
  const stillOpen = [];
  for (const p of state.open) {
    const { position, events } = updatePosition(p, { bid: bidOf(tickers[p.symbol]), now }, CFG);
    for (const e of events) {
      const f = position.fills[position.fills.length - 1];
      if (e === 'TP1') log(`✂️  TP1  ${p.symbol} 50% @ ${position.fills.find((x) => x.reason === 'TP1').price} → stop au breakeven ${position.stop}`);
      else log(`${e === 'FINAL' ? '🎯' : e === 'STOP' ? '🛑' : '⏹️ '} ${e.padEnd(9)} ${p.symbol} @ ${f.price}`);
    }
    if (position.status === 'CLOSED') {
      state.closed.push(position);
      state.cooldown[p.symbol] = now;
      journal(position);
      log(`   ↳ ${p.symbol} fermé: ${position.pnlPct > 0 ? '+' : ''}${position.pnlPct}% (frais inclus)`);
    } else stillOpen.push(position);
  }
  state.open = stillOpen;

  // 2) Entries.
  const sig = computeSignals(now);
  if (sig) {
    lastLevels = sig.levels;
    // Previous values older than 2 ticks (restart, sleep) are not trusted for crossings.
    const prev = now - state.prevPtsAt <= 3 * TICK_MS * (MOCK ? 450 : 1) ? state.prevPts : null;
    const crosses = detectCrossings(prev, sig.pts, sig.levels.entry, CFG.maxChasePts);
    for (const sym of crosses) {
      if (state.open.some((p) => p.symbol === sym)) continue;
      if ((sig.ranks[sym] ?? 99) > (CFG.maxRank || 50)) continue;
      if (now - (state.cooldown[sym] || 0) < CFG.cooldownMs) continue;
      const tk = tickers[sym];
      const r = openPosition({ symbol: sym, ask: askOf(tk), last: Number(tk?.lastPrice), curvePts: sig.pts[sym], levels: sig.levels, now, rank: sig.ranks[sym] }, CFG);
      if (r.skip) { log(`·  ignoré  ${sym}: ${r.skip}`); continue; }
      r.position.stopInitial = r.position.stop;
      state.open.push(r.position);
      const p = r.position;
      log(`🚀 ACHAT   ${sym} (#${p.rank}) @ ${p.entry} | LP ${sig.levels.entry} pts | TP1 ${p.tp1 ?? '—'} (${p.tp1 ? `+${((p.tp1 / p.entry - 1) * 100).toFixed(2)}%` : 'mur ≥ +10%'}) | final ${p.final ?? '—'}${p.final ? ` (+${CFG.finalPct}%)` : ''} | stop ${p.stop} (-${CFG.stopPct}%)`);
    }
    state.prevPts = sig.pts;
    state.prevPtsAt = now;
  }
  saveState();
}

// ---------- main ----------
function guard(name, fn) {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try { await fn(); } catch (e) { log(`⚠️  ${name}: ${e.message || e}`); } finally { running = false; }
  };
}

async function main() {
  log(`Démarrage bot PAPER · stop -${CFG.stopPct}% · ${CFG.useTp1 === false ? 'pas de TP1' : '50% au mur'} · ${CFG.useFinal === false ? 'pas de target' : `reste +${CFG.finalPct}%`}${CFG.trailPct ? ` · trailing ${CFG.trailPct}% dès +${CFG.trailActivatePct || 0}%` : ''} · frais ${CFG.feePct}%/ordre`);
  if (state.open.length || state.closed.length) log(`Reprise: ${state.open.length} positions ouvertes, ${state.closed.length} trades fermés`);
  await fullScan();
  const tickG = guard('tick', tick);
  const tailG = guard('tails', refreshTails);
  const fullG = guard('scan', fullScan);
  await tickG();
  setInterval(tickG, TICK_MS);
  setInterval(tailG, TAIL_MS);
  setInterval(fullG, FULL_MS);
  setInterval(() => {
    if (lastLevels) log(`Niveaux 24H: launchpad ${lastLevels.entry} pts · mur ${lastLevels.tp} pts · ${state.open.length} positions`);
    printSummary(Object.fromEntries(state.open.map((p) => [p.symbol, bidOf(tickers[p.symbol])])));
  }, SUMMARY_MS);
}

process.on('SIGINT', () => {
  saveState();
  printSummary(Object.fromEntries(state.open.map((p) => [p.symbol, bidOf(tickers[p.symbol])])));
  process.exit(0);
});

main().catch((e) => { log(`Erreur fatale: ${e.message || e}`); process.exit(1); });
