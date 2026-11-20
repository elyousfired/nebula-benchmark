// Scores are cross-sectional: each performance is turned into a percentile
// rank (0–100) across the whole universe, then weighted. This keeps one
// +80% outlier from drowning every other signal (old score mixed raw % with
// confluence points), and makes scores comparable between horizons.

export const HORIZONS = {
  month: {
    label: '30D',
    weights: { d30: 0.30, w1: 0.20, d1: 0.20, h4: 0.15, h1: 0.10, m15: 0.05 },
    confluence: { d30: 3, w1: 2.5, d1: 2.5, h4: 1.5, h1: 1.5, m15: 1 },
  },
  week: {
    label: '7D',
    weights: { w1: 0.35, d1: 0.25, h4: 0.20, h1: 0.12, m15: 0.08 },
    confluence: { w1: 3, d1: 2.5, h4: 2, h1: 1.5, m15: 1 },
  },
  day: {
    label: '24H',
    weights: { d1: 0.40, h4: 0.25, h1: 0.20, m15: 0.15 },
    confluence: { d1: 3, h4: 2.5, h1: 1.5, m15: 1 },
  },
};

/**
 * Percentile ranks in [0, 100] for an array of numbers (nulls -> null).
 * Ties share the average rank. A single value gets 100.
 */
export function percentileRanks(values) {
  const idx = [];
  values.forEach((v, i) => { if (v != null && Number.isFinite(v)) idx.push(i); });
  const out = new Array(values.length).fill(null);
  const n = idx.length;
  if (n === 0) return out;
  if (n === 1) { out[idx[0]] = 100; return out; }
  idx.sort((a, b) => values[a] - values[b]);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[idx[j + 1]] === values[idx[i]]) j++;
    const avgRank = (i + j) / 2;
    const pct = (avgRank / (n - 1)) * 100;
    for (let k = i; k <= j; k++) out[idx[k]] = pct;
    i = j + 1;
  }
  return out;
}

/** Share (0..1) of confluence weight whose performance is positive. */
export function confluenceRatio(perf, confWeights) {
  let got = 0;
  let tot = 0;
  for (const [k, w] of Object.entries(confWeights)) {
    tot += w;
    if (perf[k] != null && perf[k] > 0) got += w;
  }
  return tot > 0 ? got / tot : 0;
}

/**
 * Adds `scores` { month, week, day } (0–100 or null when history is missing)
 * and `confluence` { month, week, day } (0..1) to each token. Returns new objects.
 * score = weighted percentile × (0.5 + 0.5 × confluence)
 */
export function scoreUniverse(tokens) {
  const keys = ['m15', 'h1', 'h4', 'd1', 'w1', 'd30'];
  const ranks = {};
  for (const k of keys) ranks[k] = percentileRanks(tokens.map((t) => t.perf[k]));

  return tokens.map((t, i) => {
    const scores = {};
    const confluence = {};
    for (const [h, def] of Object.entries(HORIZONS)) {
      let s = 0;
      let ok = true;
      for (const [k, w] of Object.entries(def.weights)) {
        const r = ranks[k][i];
        if (r == null) { ok = false; break; }
        s += r * w;
      }
      const c = confluenceRatio(t.perf, def.confluence);
      confluence[h] = Number(c.toFixed(2));
      scores[h] = ok ? Number((s * (0.5 + 0.5 * c)).toFixed(2)) : null;
    }
    return { ...t, scores, confluence };
  });
}

/** Sorted top list for a horizon (`peak` = by 30D max points). Tokens lacking data are excluded. */
export function topList(tokens, horizon, limit = 50, universe = 'score') {
  const key = universe === 'peak' ? (t) => t.maxPointsMonth : (t) => t.scores?.[horizon];
  return tokens
    .filter((t) => key(t) != null)
    .sort((a, b) => key(b) - key(a))
    .slice(0, limit)
    .map((t, i) => ({ ...t, rank: i + 1 }));
}
