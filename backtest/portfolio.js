// Portfolio view of a list of trades when the capital is split into `slots` equal parts:
// each new trade gets (realized equity at entry) / slots. Returns the equity path stats.

export function portfolio(closed, open = [], slots = 5) {
  const ev = [];
  for (const t of closed) {
    ev.push({ t: t.openedAt, k: 0, tr: t });
    ev.push({ t: t.closedAt, k: 1, tr: t });
  }
  for (const p of open) ev.push({ t: p.openedAt, k: 0, tr: p });
  ev.sort((a, b) => a.t - b.t || b.k - a.k); // exits before entries at the same time
  let E = 1;
  let peak = 1;
  let maxDd = 0;
  const alloc = new Map();
  for (const e of ev) {
    if (e.k === 0) alloc.set(e.tr, E / slots);
    else {
      E += alloc.get(e.tr) * (e.tr.pnlPct / 100);
      peak = Math.max(peak, E);
      maxDd = Math.min(maxDd, E / peak - 1);
    }
  }
  let openVal = 0;
  for (const p of open) openVal += (alloc.get(p) || 0) * ((p.markPct || 0) / 100);
  // longest losing streak (by close time)
  let streak = 0;
  let maxStreak = 0;
  for (const t of [...closed].sort((a, b) => a.closedAt - b.closedAt)) {
    if (t.pnlPct <= 0) { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0;
  }
  // contribution of the best trade(s)
  const gains = closed.filter((t) => t.pnlPct > 0).sort((a, b) => b.pnlPct - a.pnlPct);
  const totalGain = gains.reduce((s, t) => s + t.pnlPct, 0);
  const top3Share = totalGain > 0 ? gains.slice(0, 3).reduce((s, t) => s + t.pnlPct, 0) / totalGain : null;
  return {
    returnPct: (E - 1) * 100,
    returnWithOpenPct: (E + openVal - 1) * 100,
    maxDrawdownPct: maxDd * 100,
    maxLosingStreak: maxStreak,
    top3ShareOfGains: top3Share,
  };
}
