// Replays the launchpad strategy on each 24H curve.
// Fixes vs. the old code:
//  - outcome is decided by whichever of TP / SL is touched FIRST after entry
//    (old code checked TP before SL regardless of order);
//  - no invented 80% win rate when nothing is decided yet (winRate = null).

export function replayTrade(pts, { entry, sl, tp }) {
  let i = pts.findIndex((p) => p.v >= entry);
  if (i < 0) return null;
  const entryX = pts[i].x;
  let peak = pts[i].v;
  for (let j = i + 1; j < pts.length; j++) {
    const p = pts[j];
    if (p.hi != null && p.hi > peak) peak = p.hi;
    if ((p.hi ?? p.v) >= tp) return { status: 'WIN', entryX, exitX: p.x, pnl: tp - entry, peak };
    if (p.v <= sl) return { status: 'LOSS', entryX, exitX: p.x, pnl: sl - entry, peak };
  }
  const last = pts[pts.length - 1].v;
  return { status: 'OPEN', entryX, exitX: null, pnl: last - entry, peak };
}

export function replayAll(curves, levels) {
  const trades = [];
  for (const [symbol, pts] of Object.entries(curves)) {
    if (!pts || pts.length < 2) continue;
    const r = replayTrade(pts, levels);
    if (r) trades.push({ symbol, ...r, pnl: Number(r.pnl.toFixed(2)) });
  }
  const wins = trades.filter((t) => t.status === 'WIN');
  const losses = trades.filter((t) => t.status === 'LOSS');
  const open = trades.filter((t) => t.status === 'OPEN');
  const decided = wins.length + losses.length;
  const winRate = decided ? wins.length / decided : null;
  const avg = (arr) => (arr.length ? arr.reduce((s, t) => s + t.pnl, 0) / arr.length : null);
  const avgWin = avg(wins);
  const avgLoss = avg(losses);
  const expectancy = decided ? (wins.reduce((s, t) => s + t.pnl, 0) + losses.reduce((s, t) => s + t.pnl, 0)) / decided : null;
  return {
    trades: trades.sort((a, b) => b.pnl - a.pnl),
    wins: wins.length,
    losses: losses.length,
    open: open.length,
    winRate,
    avgWin,
    avgLoss,
    expectancy,
    riskReward: levels.entry - levels.sl > 0 ? (levels.tp - levels.entry) / (levels.entry - levels.sl) : null,
  };
}
