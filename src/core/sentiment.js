// Short-term breadth of the listed tokens: is each curve rising or falling over
// its last `lookback` points?

export function marketSentiment(curves, { lookback = 2, threshold = 0.05 } = {}) {
  let up = 0;
  let down = 0;
  let flat = 0;
  for (const pts of Object.values(curves)) {
    if (!pts || pts.length < 2) continue;
    const last = pts[pts.length - 1].v;
    const prev = pts[Math.max(0, pts.length - 1 - lookback)].v;
    const d = last - prev;
    if (d > threshold) up++;
    else if (d < -threshold) down++;
    else flat++;
  }
  const total = up + down + flat;
  const upPct = total ? Math.round((up / total) * 100) : 0;
  const downPct = total ? Math.round((down / total) * 100) : 0;
  const dominance = upPct >= 55 ? 'BULL' : downPct >= 55 ? 'BEAR' : 'NEUTRE';
  return { up, down, flat, total, upPct, downPct, dominance };
}
