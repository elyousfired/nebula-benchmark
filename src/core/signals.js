// Live launchpad alerts: a token whose 24H curve was strictly below the
// launchpad on the previous refresh and is now at/above it.

/**
 * @param state   { baseline: {[sym]: lastValue} | null, history: Signal[] }
 * @param curves  24H curves of the listed tokens
 * @param levels  { entry, sl, tp }
 * @param ranks   { [sym]: rank }
 * @returns { state, fresh: Signal[] }
 */
export function stepSignals(state, curves, levels, ranks, now) {
  const lastOf = (sym) => {
    const pts = curves[sym];
    return pts && pts.length ? pts[pts.length - 1].v : null;
  };

  // First call: record a baseline so old pumps don't fire.
  if (!state.baseline) {
    const baseline = {};
    for (const sym of Object.keys(curves)) {
      const v = lastOf(sym);
      if (v != null) baseline[sym] = v;
    }
    return { state: { ...state, baseline }, fresh: [] };
  }

  const baseline = { ...state.baseline };
  const fresh = [];
  for (const sym of Object.keys(curves)) {
    const v = lastOf(sym);
    if (v == null) continue;
    const prev = baseline[sym] ?? v;
    baseline[sym] = v;
    const crossed = prev < levels.entry && v >= levels.entry;
    const alreadyActive = state.history.some((s) => s.symbol === sym && s.status === 'ACTIVE');
    if (crossed && !alreadyActive) {
      fresh.push({
        id: `${sym}_${now}`,
        symbol: sym,
        rank: ranks[sym] ?? null,
        at: now,
        trigger: Number(v.toFixed(2)),
        entry: levels.entry,
        sl: levels.sl,
        tp: levels.tp,
        current: Number(v.toFixed(2)),
        max: Number(v.toFixed(2)),
        status: v >= levels.tp ? 'WIN' : 'ACTIVE',
        pnl: 0,
        closedAt: v >= levels.tp ? now : null,
      });
    }
  }

  const history = state.history.map((s) => {
    if (s.status !== 'ACTIVE') return s;
    const v = lastOf(s.symbol);
    if (v == null) return s;
    const max = Math.max(s.max, v);
    if (max >= s.tp) return { ...s, current: v, max, status: 'WIN', pnl: Number((s.tp - s.trigger).toFixed(2)), closedAt: now };
    if (v <= s.sl) return { ...s, current: v, max, status: 'STOPPED', pnl: Number((s.sl - s.trigger).toFixed(2)), closedAt: now };
    return { ...s, current: Number(v.toFixed(2)), max: Number(max.toFixed(2)), pnl: Number((v - s.trigger).toFixed(2)) };
  });

  return { state: { baseline, history: [...fresh, ...history].slice(0, 300) }, fresh };
}
