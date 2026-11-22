// Paper-trading engine for the Launchpad strategy. Pure functions, no I/O.
//
// Rules (in real PRICES, frozen at entry — not in rolling 24H "pts"):
//   ENTRY  : the token's 24H curve crosses the Launchpad line upward between two ticks
//            (prev < launchpad <= now), not chasing more than `maxChasePts` above it.
//            Fill at the ask price.
//   TP1    : 50% sold at the Rejection Wall price (wall level converted to a price with
//            the 24H base at entry time). If the wall is >= the final target, there is no
//            partial: everything exits at the final target.
//   STOP   : -2% from entry. After TP1 the stop of the remaining half moves to breakeven
//            (entry + fees, so the runner can't turn the trade into a loss).
//   FINAL  : remaining half sold at +10% from entry.
// Exits are checked against the bid. A stop that gaps is filled at the bid (worse),
// targets are filled at their level. Fees are charged on every fill.

export const DEFAULT_CONFIG = {
  stopPct: 2, // -2%
  finalPct: 10, // +10%
  tp1Share: 0.5, // half at the wall
  feePct: 0.1, // Bybit spot taker, per fill
  minTp1Pct: 1, // skip trades whose wall is less than +1% above entry (not worth fees)
  maxChasePts: 2, // don't buy if already > launchpad + 2 pts
  cooldownMs: 6 * 3_600_000, // no re-entry on the same token for 6h after an exit
  maxHoldMs: 0, // 0 = no time limit
  // Trailing stop (off when trailPct = 0): once the best bid is >= entry × (1 + trailActivatePct%),
  // the stop follows the best bid at trailPct% below it (never moves down).
  trailPct: 0,
  trailActivatePct: 0,
  useTp1: true, // 50% at the rejection wall
  useFinal: true, // remaining part at +finalPct%
  maxRank: 50, // only enter tokens ranked <= maxRank by 30D score
  // Volatility mode (0 = off): initial stop = entry - atrStopMult × ATR, and a chandelier
  // trailing stop = highest bid since entry - chandelierMult × ATR (ATR frozen at entry).
  atrStopMult: 0,
  chandelierMult: 0,
  maxOpen: 0, // max simultaneous positions (0 = unlimited); e.g. 5 = capital split in 5
};

const r6 = (x) => Number(x.toPrecision(8));

/**
 * Entry signals: tokens whose 24H curve crossed `launchpad` since the previous tick.
 * @param prev   { [sym]: last 24H pts at previous tick } (null on the first tick)
 * @param now    { [sym]: current 24H pts }
 */
export function detectCrossings(prev, now, launchpad, maxChasePts) {
  if (!prev) return [];
  const out = [];
  for (const [sym, v] of Object.entries(now)) {
    const p = prev[sym];
    if (p == null || v == null) continue;
    if (p < launchpad && v >= launchpad && v <= launchpad + maxChasePts) out.push(sym);
  }
  return out;
}

/**
 * Build a position. Returns { position } or { skip: reason }.
 * @param ask        current ask price (fill price)
 * @param curvePts   current 24H pts of the token (to recover the 24H base price)
 * @param levels     { entry: launchpadPts, tp: wallPts }
 */
export function openPosition({ symbol, ask, last, curvePts, levels, now, rank, atr }, cfg = DEFAULT_CONFIG) {
  if (!(ask > 0) || !(last > 0)) return { skip: 'no price' };
  const base24h = last / (1 + curvePts / 100);
  const wallPrice = base24h * (1 + levels.tp / 100);
  const tp1Pct = (wallPrice / ask - 1) * 100;
  if (cfg.useTp1 !== false && tp1Pct < cfg.minTp1Pct) return { skip: `wall too close (+${tp1Pct.toFixed(2)}%)` };
  const useAtr = cfg.atrStopMult > 0 || cfg.chandelierMult > 0;
  if (useAtr && !(atr > 0)) return { skip: 'no ATR' };

  const finalPrice = cfg.useFinal === false ? Infinity : ask * (1 + cfg.finalPct / 100);
  const partial = cfg.useTp1 !== false && wallPrice < finalPrice;
  return {
    position: {
      id: `${symbol}_${now}`,
      symbol,
      rank: rank ?? null,
      openedAt: now,
      entry: r6(ask),
      launchpadPts: levels.entry,
      wallPts: levels.tp,
      tp1: partial ? r6(wallPrice) : null,
      final: Number.isFinite(finalPrice) ? r6(finalPrice) : null,
      stop: r6(cfg.atrStopMult > 0 ? ask - cfg.atrStopMult * atr : ask * (1 - cfg.stopPct / 100)),
      atr: useAtr ? atr : null,
      remaining: 1, // fraction of the position still open
      fills: [], // { at, price, share, reason }
      status: 'OPEN',
      maxPrice: ask,
      minPrice: ask,
    },
  };
}

function fill(pos, { at, price, share, reason }) {
  pos.fills.push({ at, price: r6(price), share, reason });
  pos.remaining = Number((pos.remaining - share).toFixed(6));
}

/**
 * Advance a position with a new bid. Returns { position, events } (position is a new object).
 * events: ['TP1', 'FINAL', 'STOP', 'BREAKEVEN', 'TRAIL', 'TIMEOUT']
 */
export function updatePosition(position, { bid, now }, cfg = DEFAULT_CONFIG) {
  if (position.status !== 'OPEN' || !(bid > 0)) return { position, events: [] };
  const pos = { ...position, fills: [...position.fills] };
  const events = [];
  pos.maxPrice = Math.max(pos.maxPrice, bid);
  pos.minPrice = Math.min(pos.minPrice, bid);

  // Chandelier trailing stop (volatility mode).
  if (cfg.chandelierMult > 0 && pos.atr > 0) {
    const ch = r6(pos.maxPrice - cfg.chandelierMult * pos.atr);
    if (ch > pos.stop) { pos.stop = ch; pos.trailing = true; }
  }

  // Trailing stop: ratchet the stop up behind the best bid.
  if (cfg.trailPct > 0 && pos.maxPrice >= pos.entry * (1 + (cfg.trailActivatePct || 0) / 100)) {
    const trail = r6(pos.maxPrice * (1 - cfg.trailPct / 100));
    if (trail > pos.stop) { pos.stop = trail; pos.trailing = true; }
  }

  // Stop first: if the bid is at/below the stop, we're out regardless of targets.
  if (bid <= pos.stop) {
    const reason = pos.trailing ? 'TRAIL' : pos.tp1Done ? 'BREAKEVEN' : 'STOP';
    fill(pos, { at: now, price: Math.min(bid, pos.stop), share: pos.remaining, reason });
    events.push(reason);
  } else {
    if (pos.tp1 && !pos.tp1Done && bid >= pos.tp1) {
      fill(pos, { at: now, price: pos.tp1, share: cfg.tp1Share, reason: 'TP1' });
      pos.tp1Done = true;
      pos.stop = Math.max(pos.stop, r6(pos.entry * (1 + (2 * cfg.feePct) / 100)));
      events.push('TP1');
    }
    if (pos.final != null && bid >= pos.final && pos.remaining > 0) {
      fill(pos, { at: now, price: pos.final, share: pos.remaining, reason: 'FINAL' });
      events.push('FINAL');
    }
    if (pos.remaining > 0 && cfg.maxHoldMs > 0 && now - pos.openedAt >= cfg.maxHoldMs) {
      fill(pos, { at: now, price: bid, share: pos.remaining, reason: 'TIMEOUT' });
      events.push('TIMEOUT');
    }
  }

  if (pos.remaining <= 1e-9) {
    pos.remaining = 0;
    pos.status = 'CLOSED';
    pos.closedAt = now;
    pos.pnlPct = realizedPnlPct(pos, cfg);
  }
  return { position: pos, events };
}

/** Net % P&L of the closed part (weighted by share), fees on entry and each exit. */
export function realizedPnlPct(pos, cfg = DEFAULT_CONFIG) {
  let pnl = 0;
  for (const f of pos.fills) {
    const gross = (f.price / pos.entry - 1) * 100;
    pnl += f.share * (gross - 2 * cfg.feePct);
  }
  return Number(pnl.toFixed(3));
}

/** Mark-to-market % of an open position at `bid` (closed fills + open part at bid). */
export function unrealizedPnlPct(pos, bid, cfg = DEFAULT_CONFIG) {
  const closed = realizedPnlPct(pos, cfg);
  const open = pos.remaining * ((bid / pos.entry - 1) * 100 - 2 * cfg.feePct);
  return Number((closed + open).toFixed(3));
}

/** Stats over closed trades: each trade counts the same (P&L in % of the trade). */
export function summarize(closed) {
  const n = closed.length;
  const wins = closed.filter((t) => t.pnlPct > 0);
  const losses = closed.filter((t) => t.pnlPct <= 0);
  const sum = closed.reduce((s, t) => s + t.pnlPct, 0);
  let peak = 0;
  let cum = 0;
  let maxDd = 0;
  for (const t of [...closed].sort((a, b) => a.closedAt - b.closedAt)) {
    cum += t.pnlPct;
    peak = Math.max(peak, cum);
    maxDd = Math.min(maxDd, cum - peak);
  }
  const byExit = {};
  for (const t of closed) {
    const k = t.fills.map((f) => f.reason).join('+');
    byExit[k] = (byExit[k] || 0) + 1;
  }
  const avg = (a) => (a.length ? a.reduce((s, t) => s + t.pnlPct, 0) / a.length : 0);
  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: n ? wins.length / n : null,
    totalPct: Number(sum.toFixed(2)),
    avgPct: n ? Number((sum / n).toFixed(3)) : null,
    avgWinPct: Number(avg(wins).toFixed(3)),
    avgLossPct: Number(avg(losses).toFixed(3)),
    maxDrawdownPct: Number(maxDd.toFixed(2)),
    byExit,
  };
}
