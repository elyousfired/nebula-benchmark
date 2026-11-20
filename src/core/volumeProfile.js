// Collective horizontal volume profile: quote turnover of every candle of every
// token, bucketed by its performance level (pts from the horizon base).

export function volumeProfile(curves, { bucket = 1, valueArea = 0.7 } = {}) {
  const map = new Map();
  let total = 0;
  for (const [symbol, pts] of Object.entries(curves)) {
    if (!pts) continue;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      if (!(p.q > 0) || !Number.isFinite(p.v)) continue;
      const lvl = Math.floor(p.v / bucket) * bucket;
      let b = map.get(lvl);
      if (!b) { b = { lvl, volume: 0, up: 0, down: 0, tokens: new Set() }; map.set(lvl, b); }
      b.volume += p.q;
      if (p.up) b.up += p.q; else b.down += p.q;
      b.tokens.add(symbol);
      total += p.q;
    }
  }
  const buckets = [...map.values()]
    .sort((a, b) => a.lvl - b.lvl)
    .map((b) => ({ ...b, tokens: b.tokens.size }));
  if (!buckets.length) return { buckets: [], poc: null, vah: null, val: null, total: 0 };

  let pocIdx = 0;
  buckets.forEach((b, i) => { if (b.volume > buckets[pocIdx].volume) pocIdx = i; });

  // Value area: expand from POC toward the larger neighbour until 70% of volume.
  let lo = pocIdx;
  let hi = pocIdx;
  let acc = buckets[pocIdx].volume;
  while (acc < total * valueArea && (lo > 0 || hi < buckets.length - 1)) {
    const down = lo > 0 ? buckets[lo - 1].volume : -1;
    const up = hi < buckets.length - 1 ? buckets[hi + 1].volume : -1;
    if (up >= down) { hi++; acc += buckets[hi].volume; } else { lo--; acc += buckets[lo].volume; }
  }

  return {
    buckets,
    poc: buckets[pocIdx].lvl,
    pocVolume: buckets[pocIdx].volume,
    val: buckets[lo].lvl,
    vah: buckets[hi].lvl + bucket,
    total,
    bucket,
  };
}
