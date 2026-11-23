// BTC swings (zigzag on daily candles) and how each token moved in each swing.
// Daily bars: { t, h, l, c } ascending, closed days only.

/**
 * Zigzag pivots: a swing ends when price reverses by `th` from its extreme.
 * Returns pivots [{ type: 'H'|'L', i, t, p }] and the running extreme.
 */
export function zigzag(b, th = 0.15) {
  const piv = [];
  let dir = 0; let ext = 0; let low0 = 0; // low0: lowest bar before the first pivot
  for (let i = 1; i < b.t.length; i++) {
    if (dir === 0 && b.l[i] < b.l[low0]) low0 = i;
    if (dir >= 0) {
      if (b.h[i] > b.h[ext]) ext = i;
      if (dir === 0 && b.h[ext] > b.l[low0] * (1 + th) && low0 < ext) { piv.push({ type: 'L', i: low0, t: b.t[low0], p: b.l[low0] }); dir = 1; }
      if (b.l[i] < b.h[ext] * (1 - th)) { piv.push({ type: 'H', i: ext, t: b.t[ext], p: b.h[ext] }); dir = -1; ext = i; }
    } else {
      if (b.l[i] < b.l[ext]) ext = i;
      if (b.h[i] > b.l[ext] * (1 + th)) { piv.push({ type: 'L', i: ext, t: b.t[ext], p: b.l[ext] }); dir = 1; ext = i; }
    }
  }
  return { piv, ext, dir };
}

/**
 * Swings of BTC starting at the first pivot on/after `from`, plus the swing in
 * progress (open: true, ends at the last bar).
 * Each swing: { kind: 'up'|'down', t0, t1, p0, p1, ret, open }.
 */
export function btcSwings(b, from, th = 0.15, minDays = 5) {
  const { piv, dir } = zigzag(b, th);
  const P = piv.filter((x) => x.t >= from);
  // Drop intraday whipsaws: a pair of pivots closer than minDays is removed.
  for (let k = 1; k < P.length;) {
    if (P[k].t - P[k - 1].t < minDays * 86_400_000) P.splice(k - 1, 2); else k++;
  }
  const out = [];
  for (let k = 1; k < P.length; k++) {
    const a = P[k - 1]; const z = P[k];
    out.push({ kind: a.type === 'L' ? 'up' : 'down', t0: a.t, t1: z.t, p0: a.p, p1: z.p, ret: z.p / a.p - 1, open: false });
  }
  const last = P[P.length - 1];
  if (last) {
    const n = b.t.length - 1;
    out.push({ kind: dir === -1 ? 'down' : 'up', t0: last.t, t1: b.t[n], p0: last.p, p1: b.c[n], ret: b.c[n] / last.p - 1, open: true });
  }
  return out;
}

/** Close at day t (or the last close before it). */
function closeAt(b, t) {
  let r = null;
  for (let i = 0; i < b.t.length && b.t[i] <= t; i++) r = b.c[i];
  return r;
}

/**
 * Token move in each BTC swing: ret (close to close), max (best high reached,
 * for up swings) and min (worst low, for down swings), from the swing start close.
 */
export function tokenSwings(b, swings) {
  return swings.map((s) => {
    const p0 = closeAt(b, s.t0);
    const p1 = closeAt(b, s.t1);
    if (!(p0 > 0) || !(p1 > 0) || b.t[0] > s.t0) return null;
    let hi = 0; let lo = Infinity;
    for (let i = 0; i < b.t.length; i++) if (b.t[i] > s.t0 && b.t[i] <= s.t1) { hi = Math.max(hi, b.h[i]); lo = Math.min(lo, b.l[i]); }
    return { p0, ret: p1 / p0 - 1, max: hi > 0 ? hi / p0 - 1 : null, min: lo < Infinity ? lo / p0 - 1 : null };
  });
}

/**
 * How a token follows BTC over the waves. waves: [{ kind: 'up'|'down' }],
 * moves / btcMoves: tokenSwings output for the token and for BTC.
 * fidelity = waves where the token moved in the wave's direction;
 * upAmp / downAmp = token move / BTC move averaged over up / down waves
 * (2 = twice BTC's move); asym = upAmp / downAmp (> 1: rises more than it falls).
 */
export function waveScores(waves, moves, btcMoves) {
  let fidelity = 0; let n = 0; const up = []; const dn = [];
  waves.forEach((w, k) => {
    const m = moves[k]; const b = btcMoves[k];
    if (!m || !b) return;
    n++;
    if (w.kind === 'up' ? m.ret > 0 : m.ret < 0) fidelity++;
    if (b.ret !== 0) (w.kind === 'up' ? up : dn).push(m.ret / b.ret);
  });
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const upAmp = avg(up); const downAmp = avg(dn);
  return { fidelity, waves: n, upAmp, downAmp, asym: upAmp != null && downAmp != null && downAmp > 0 ? upAmp / downAmp : null };
}

/** Daily log-return correlation and beta of token vs BTC over common days >= from. */
export function corrBeta(b, btc, from) {
  const m = new Map(btc.t.map((t, i) => [t, i]));
  const xs = []; const ys = [];
  for (let i = 1; i < b.t.length; i++) {
    if (b.t[i] < from) continue;
    const j = m.get(b.t[i]); const jp = m.get(b.t[i - 1]);
    if (j == null || jp == null) continue;
    xs.push(Math.log(b.c[i] / b.c[i - 1])); ys.push(Math.log(btc.c[j] / btc.c[jp]));
  }
  if (xs.length < 20) return { corr: null, beta: null };
  const mx = xs.reduce((a, v) => a + v, 0) / xs.length; const my = ys.reduce((a, v) => a + v, 0) / ys.length;
  let cov = 0; let vx = 0; let vy = 0;
  xs.forEach((x, k) => { cov += (x - mx) * (ys[k] - my); vx += (x - mx) ** 2; vy += (ys[k] - my) ** 2; });
  return { corr: cov / Math.sqrt(vx * vy), beta: cov / vy };
}
