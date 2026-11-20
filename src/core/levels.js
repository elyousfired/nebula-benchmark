// 24H collective levels, ported from the original "Launchpad" / "Mur de rejet"
// logic but computed on time-aligned curves.

/**
 * @param curves { [symbol]: [{x, v, hi}] } — 24H curves
 * @returns { launchpad, rejectionWall, pumping: [{symbol, breakout, peak}], pierced: [symbol], rejectedCount }
 */
export function collectiveLevels(curves) {
  const peaks = [];
  const pumps = [];

  for (const [symbol, pts] of Object.entries(curves)) {
    if (!pts || pts.length < 3) continue;
    let maxPt = -Infinity;
    let maxIdx = 0;
    pts.forEach((p, i) => { if (p.hi > maxPt) { maxPt = p.hi; maxIdx = i; } });
    const lastPt = pts[pts.length - 1].v;

    // Accumulation ceiling before the impulse: highest high before the peak,
    // capped at min(10, 60% of the peak).
    const cap = Math.min(10, maxPt * 0.6);
    let pre = -Infinity;
    const limit = Math.max(Math.min(10, pts.length), maxIdx);
    for (let i = 0; i < limit; i++) {
      if (pts[i].hi > pre && pts[i].hi <= cap) pre = pts[i].hi;
    }
    if (pre === -Infinity || pre < 1) pre = Math.min(Math.max(4, maxPt * 0.35), 8.5);

    if (maxPt >= 10) pumps.push({ symbol, breakout: pre, peak: maxPt });
    peaks.push({ symbol, maxPt, lastPt, pullback: maxPt - lastPt });
  }

  // Rejection wall = 75th percentile of 24H peaks (min 13 pts).
  let rejectionWall = 15;
  if (peaks.length) {
    const sorted = peaks.map((p) => p.maxPt).sort((a, b) => a - b);
    rejectionWall = Math.max(13, sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))]);
  }

  // Launchpad = most common breakout level (0.5 pt buckets, 2–11) among pumping tokens.
  let launchpad = 8;
  if (pumps.length) {
    const buckets = new Map();
    for (const p of pumps) {
      const k = Math.round(p.breakout * 2) / 2;
      buckets.set(k, (buckets.get(k) || 0) + 1);
    }
    let best = null;
    let bestN = -1;
    for (const [k, n] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
      if (k >= 2 && k <= 11 && n > bestN) { best = k; bestN = n; }
    }
    if (best != null) launchpad = best;
    else {
      const s = [...pumps].sort((a, b) => a.breakout - b.breakout);
      launchpad = s[Math.floor(s.length / 2)].breakout;
    }
  }
  launchpad = Math.max(4, Math.min(launchpad, 10));
  rejectionWall = Math.max(rejectionWall, launchpad + 4.5);

  return {
    launchpad: Number(launchpad.toFixed(2)),
    rejectionWall: Number(rejectionWall.toFixed(2)),
    pumping: pumps.map((p) => ({ ...p, breakout: Number(p.breakout.toFixed(2)), peak: Number(p.peak.toFixed(2)) })),
    pierced: peaks.filter((p) => p.lastPt > rejectionWall).map((p) => p.symbol),
    rejectedCount: peaks.filter((p) => p.maxPt <= rejectionWall * 1.1 && p.pullback >= 1.5).length,
  };
}

/** Entry / stop / target for the 24H launchpad strategy. */
export function sniperLevels({ launchpad, rejectionWall }) {
  const entry = launchpad;
  const sl = Math.max(0, entry - 2);
  const tp = Math.max(entry + 4, rejectionWall);
  return { entry, sl: Number(sl.toFixed(2)), tp: Number(tp.toFixed(2)) };
}
